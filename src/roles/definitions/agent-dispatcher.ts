import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink as unlinkFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { StateStore } from "../../state-store";
import {
  AgentDispatcherConfigSchema,
  AppStateSchema,
  type AgentDispatcherConfig,
  type AppState,
  type HubResult
} from "../../types";
import { launchDispatcher, type LaunchConfig, type LaunchResult } from "../agent-dispatcher/launcher";
import { buildSystemPrompt, type PromptVars } from "../agent-dispatcher/prompt-builder";
import {
  readWorkersByStatus,
  SessionManager,
  ThreadTracker,
  type DispatchThreadState,
  type RestartResult,
  type SessionManagerOptions
} from "../agent-dispatcher/session-manager";
import type { BaseRole, RoleContext } from "../base-role";

type PersistableStateStore = Pick<StateStore, "load" | "save">;
type DispatcherLifecycleStatus = "active" | "paused";
type SessionManagerLike = Pick<
  SessionManager,
  "getDispatcherThreadId" | "initSession" | "isPaused" | "onRestart" | "setPaused"
>;
type ThreadTrackerLike = Pick<ThreadTracker, "load" | "save">;

const EMPTY_APP_STATE: AppState = {
  roles: [],
  promptStore: {}
};
const DISPATCHER_STATUS_WORKER_ID = "DISPATCHER-STATUS";
const MERIDIAN_TOOL_ENTRYPOINT = "src/bin/meridian-tool.ts";
const SIGNAL_FILE_CLEANUP_DELAY_MS = 5_000;

export interface AgentDispatcherRoleOptions {
  stateStore?: PersistableStateStore;
  buildSystemPrompt?: (vars: PromptVars) => string;
  launchDispatcher?: (config: LaunchConfig) => Promise<LaunchResult>;
  sessionManagerFactory?: (threadId: string, options: SessionManagerOptions) => SessionManagerLike;
  readWorkersByStatus?: (dispatchPlanPath: string, status: string) => Promise<string[]>;
  threadTrackerFactory?: (dispatchPlanPath: string) => ThreadTrackerLike;
  killThread?: (threadId: string) => Promise<void>;
  signalDispatcher?: (dispatcherThreadId: string, status: DispatcherLifecycleStatus) => Promise<void>;
}

export class AgentDispatcherRole implements BaseRole {
  readonly roleType = "agent-dispatcher" as const;
  readonly threadId: string;
  readonly config: AgentDispatcherConfig;

  private readonly stateStore: PersistableStateStore;
  private readonly buildPrompt: (vars: PromptVars) => string;
  private readonly launch: (config: LaunchConfig) => Promise<LaunchResult>;
  private readonly createSessionManager: (threadId: string, options: SessionManagerOptions) => SessionManagerLike;
  private readonly readPlanWorkersByStatus: (dispatchPlanPath: string, status: string) => Promise<string[]>;
  private readonly createThreadTracker: (dispatchPlanPath: string) => ThreadTrackerLike;
  private readonly killTrackedThread: (threadId: string) => Promise<void>;
  private readonly signalDispatcherThread: (
    dispatcherThreadId: string,
    status: DispatcherLifecycleStatus
  ) => Promise<void>;

  private ctx: RoleContext | null = null;
  private sessionManager: SessionManagerLike | null = null;

  constructor(threadId: string, config: unknown, options: AgentDispatcherRoleOptions = {}) {
    this.threadId = threadId;
    this.config = AgentDispatcherConfigSchema.parse(config);
    this.stateStore = options.stateStore ?? new StateStore();
    this.buildPrompt = options.buildSystemPrompt ?? buildSystemPrompt;
    this.launch = options.launchDispatcher ?? launchDispatcher;
    this.createSessionManager = options.sessionManagerFactory ?? defaultSessionManagerFactory;
    this.readPlanWorkersByStatus = options.readWorkersByStatus ?? readWorkersByStatus;
    this.createThreadTracker = options.threadTrackerFactory ?? defaultThreadTrackerFactory;
    this.killTrackedThread = options.killThread ?? defaultKillThread;
    this.signalDispatcherThread = options.signalDispatcher ?? defaultSignalDispatcher;
  }

  async onActivate(ctx: RoleContext): Promise<void> {
    this.ctx = ctx;

    const sessionManager = this.createSessionManager(this.threadId, {
      stateStore: this.stateStore,
      dispatchPlanPath: this.config.dispatch_plan_path
    });
    this.sessionManager = sessionManager;

    let dispatcherThreadId: string | null = null;

    try {
      const systemPrompt = this.buildPrompt({
        dispatch_plan_path: this.config.dispatch_plan_path,
        command_file_path: this.config.command_file_path,
        user_reply_channels: JSON.stringify(this.config.user_reply_channels)
      });

      const inProgressWorkers = await this.readPlanWorkersByStatus(this.config.dispatch_plan_path, "🔄");
      if (inProgressWorkers.length > 0) {
        await sessionManager.onRestart();
      }

      const launched = await this.launch({
        agentType: this.config.agent_type,
        mode: this.config.mode,
        systemPrompt,
        dispatchPlanPath: this.config.dispatch_plan_path,
        commandFilePath: this.config.command_file_path,
        userReplyChannel: this.getPrimaryReplyChannel()
      });
      if (!launched.ok || !launched.threadId.trim()) {
        throw new Error(launched.error ?? "Failed to launch dispatcher agent");
      }

      dispatcherThreadId = launched.threadId;
      await sessionManager.initSession(dispatcherThreadId, this.config.dispatch_plan_path);
      await this.persistState(sessionManager.isPaused() ? "paused" : "active");
    } catch (error) {
      this.ctx = null;
      this.sessionManager = null;

      if (dispatcherThreadId) {
        await this.killTrackedThread(dispatcherThreadId).catch(() => undefined);
        await this.resetTrackedThreads().catch(() => undefined);
      }

      throw error;
    }
  }

  async onDeactivate(): Promise<void> {
    const trackerState = await this.loadTrackedThreads();
    const threadIds = dedupeThreadIds([
      this.sessionManager?.getDispatcherThreadId() ?? null,
      trackerState.dispatcher_thread_id,
      ...Object.values(trackerState.workers).map((entry) => entry.thread_id)
    ]);

    const killResults = await Promise.allSettled(threadIds.map((threadId) => this.killTrackedThread(threadId)));
    killResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }

      this.ctx?.log.warn("Agent dispatcher cleanup kill failed", {
        roleThreadId: this.threadId,
        targetThreadId: threadIds[index],
        error: asError(result.reason).message
      });
    });

    await this.resetTrackedThreads().catch((error) => {
      this.ctx?.log.warn("Agent dispatcher failed to clear dispatch sidecar", {
        roleThreadId: this.threadId,
        error: asError(error).message
      });
    });
    await this.removePersistedRole().catch((error) => {
      this.ctx?.log.warn("Agent dispatcher failed to remove persisted role state", {
        roleThreadId: this.threadId,
        error: asError(error).message
      });
    });

    this.sessionManager = null;
    this.ctx = null;
  }

  async onInboundResult(_result: HubResult): Promise<void> {
    return undefined;
  }

  async onStatusChange(threadId: string, status: string): Promise<void> {
    if (threadId !== this.threadId) {
      return;
    }
    if (status !== "paused" && status !== "active") {
      return;
    }

    const sessionManager = this.requireSessionManager();
    sessionManager.setPaused(status === "paused");
    await this.persistState(status);

    const dispatcherThreadId = sessionManager.getDispatcherThreadId();
    if (!dispatcherThreadId) {
      return;
    }

    await this.signalDispatcherThread(dispatcherThreadId, status).catch((error) => {
      this.requireContext().log.warn("Agent dispatcher status signal failed", {
        roleThreadId: this.threadId,
        dispatcherThreadId,
        status,
        error: asError(error).message
      });
    });
  }

  getDispatcherThreadId(): string | null {
    return this.sessionManager?.getDispatcherThreadId() ?? null;
  }

  private getPrimaryReplyChannel() {
    const replyChannel = this.config.user_reply_channels[0];
    if (!replyChannel) {
      throw new Error("Agent dispatcher requires at least one user reply channel");
    }

    return { ...replyChannel };
  }

  private async persistState(status: DispatcherLifecycleStatus): Promise<void> {
    const currentState = AppStateSchema.parse((await this.stateStore.load()) ?? EMPTY_APP_STATE);
    const roles = currentState.roles.filter((role) => role.threadId !== this.threadId);

    roles.push({
      threadId: this.threadId,
      roleType: this.roleType,
      config: snapshotConfig(this.config),
      status
    });

    await this.stateStore.save({
      roles,
      promptStore: currentState.promptStore
    });
  }

  private async removePersistedRole(): Promise<void> {
    const currentState = await this.stateStore.load();
    if (!currentState) {
      return;
    }

    const nextRoles = currentState.roles.filter((role) => role.threadId !== this.threadId);
    if (nextRoles.length === currentState.roles.length) {
      return;
    }

    await this.stateStore.save({
      roles: nextRoles,
      promptStore: currentState.promptStore
    });
  }

  private async loadTrackedThreads(): Promise<DispatchThreadState> {
    return this.createThreadTracker(this.config.dispatch_plan_path).load();
  }

  private async resetTrackedThreads(): Promise<void> {
    await this.createThreadTracker(this.config.dispatch_plan_path).save({
      dispatcher_thread_id: null,
      workers: {}
    });
  }

  private requireSessionManager(): SessionManagerLike {
    if (!this.sessionManager) {
      throw new Error("AgentDispatcherRole is not active");
    }

    return this.sessionManager;
  }

  private requireContext(): RoleContext {
    if (!this.ctx) {
      throw new Error("AgentDispatcherRole is not active");
    }

    return this.ctx;
  }
}

function snapshotConfig(config: AgentDispatcherConfig): AgentDispatcherConfig {
  return {
    ...config,
    tasks: config.tasks.map((task) => ({
      ...task,
      depends_on: [...task.depends_on]
    })),
    user_reply_channel: config.user_reply_channel ? { ...config.user_reply_channel } : undefined,
    user_reply_channels: config.user_reply_channels.map((replyChannel) => ({ ...replyChannel }))
  };
}

function dedupeThreadIds(values: Array<string | null>): string[] {
  const unique = new Set<string>();

  values.forEach((value) => {
    const normalized = value?.trim();
    if (normalized) {
      unique.add(normalized);
    }
  });

  return [...unique];
}

function defaultSessionManagerFactory(threadId: string, options: SessionManagerOptions): SessionManagerLike {
  return new SessionManager(threadId, options);
}

function defaultThreadTrackerFactory(dispatchPlanPath: string): ThreadTrackerLike {
  return new ThreadTracker(dispatchPlanPath);
}

async function defaultKillThread(threadId: string): Promise<void> {
  await execFile("npx", [
    "tsx",
    MERIDIAN_TOOL_ENTRYPOINT,
    "kill",
    "--thread-id",
    threadId
  ]);
}

async function defaultSignalDispatcher(
  dispatcherThreadId: string,
  status: DispatcherLifecycleStatus
): Promise<void> {
  const commandPath = path.join(tmpdir(), `dispatcher_status_${randomUUID()}.md`);
  await writeFile(commandPath, buildStatusSignalPrompt(status), "utf8");

  try {
    const child = nodeSpawn(
      "npx",
      [
        "tsx",
        MERIDIAN_TOOL_ENTRYPOINT,
        "run",
        "--thread-id",
        dispatcherThreadId,
        "--command",
        commandPath,
        "--worker",
        DISPATCHER_STATUS_WORKER_ID
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    child.unref();
    const timer = setTimeout(() => {
      void unlinkFile(commandPath).catch(() => undefined);
    }, SIGNAL_FILE_CLEANUP_DELAY_MS);
    timer.unref?.();
  } catch (error) {
    await unlinkFile(commandPath).catch(() => undefined);
    throw error;
  }
}

function buildStatusSignalPrompt(status: DispatcherLifecycleStatus): string {
  if (status === "paused") {
    return [
      "# Dispatcher Control",
      "Pause requested by meridian-roles.",
      "Stop starting new workers as soon as the current tool call finishes.",
      "Remain idle until a later control message explicitly says to resume."
    ].join("\n");
  }

  return [
    "# Dispatcher Control",
    "Resume requested by meridian-roles.",
    "Re-read the dispatch plan from disk and continue the dispatch loop from the next eligible worker."
  ].join("\n");
}

function execFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
