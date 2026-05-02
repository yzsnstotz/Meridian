import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import { unlink as unlinkFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LifecycleStore, hubResultContainsBlockSignal, hubResultContainsFailureSignal } from "../agent-dispatcher/lifecycle-store";
import { StateStore } from "../../state-store";
import {
  AgentDispatcherConfigSchema,
  AppStateSchema,
  type AgentDispatcherConfig,
  type AppState,
  type DispatchWorkerState
} from "../../types";
import { launchDispatcher, type LaunchConfig, type LaunchResult } from "../agent-dispatcher/launcher";
import { parseNormalizedAgentDispatcherConfig } from "../agent-dispatcher/config-normalization";
import {
  buildSystemPrompt,
  materializeDispatcherSystemPrompt,
  type PromptVars
} from "../agent-dispatcher/prompt-builder";
import {
  resolveConfiguredDispatchRepoRoot,
  resolveConfiguredDocsRoot
} from "../agent-dispatcher/dispatch-paths";
import { createMeridianApiClient, type MeridianApiClient } from "../agent-dispatcher/meridian-api-client";
import { resolveDispatchModelMapFromMarkdown } from "../agent-dispatcher/model-routing";
import {
  outputArtifactsContain,
  outputsExist as outputArtifactsExist
} from "../agent-dispatcher/output-artifacts";
import {
  readWorkersByStatus,
  SessionManager,
  type DispatchThreadState,
  type SessionManagerOptions
} from "../agent-dispatcher/session-manager";
import runTool from "../../tool-gateway/tools/run";
import type { BaseRole, RoleContext } from "../base-role";

type PersistableStateStore = Pick<StateStore, "load" | "save">;
type DispatcherLifecycleStatus = "active" | "paused";
type SessionManagerLike = Pick<
  SessionManager,
  | "getDispatcherThreadId"
  | "initSession"
  | "isPaused"
  | "onRestart"
  | "prepareFreshDispatcherLaunch"
  | "setPaused"
> & {
  setPaused(paused: boolean, options?: { skipPersist?: boolean }): void;
};
type LifecycleStoreLike = Pick<LifecycleStore, "load" | "save">;

const EMPTY_APP_STATE: AppState = {
  roles: [],
  promptStore: {}
};
const DISPATCHER_STATUS_WORKER_ID = "DISPATCHER-STATUS";
const SIGNAL_FILE_CLEANUP_DELAY_MS = 5_000;

export interface AgentDispatcherRoleOptions {
  stateStore?: PersistableStateStore;
  buildSystemPrompt?: (vars: PromptVars) => string;
  launchDispatcher?: (config: LaunchConfig) => Promise<LaunchResult>;
  sessionManagerFactory?: (threadId: string, options: SessionManagerOptions) => SessionManagerLike;
  readWorkersByStatus?: (dispatchPlanPath: string, status: string) => Promise<string[]>;
  lifecycleStoreFactory?: (dispatchPlanPath: string) => LifecycleStoreLike;
  killThread?: (threadId: string) => Promise<void>;
  signalDispatcher?: (dispatcherThreadId: string, status: DispatcherLifecycleStatus) => Promise<void>;
  meridianApi?: MeridianApiClient;
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
  private readonly createLifecycleStore: (dispatchPlanPath: string) => LifecycleStoreLike;
  private readonly killTrackedThread: (threadId: string) => Promise<void>;
  private readonly signalDispatcherThread: (
    dispatcherThreadId: string,
    status: DispatcherLifecycleStatus
  ) => Promise<void>;

  private ctx: RoleContext | null = null;
  private sessionManager: SessionManagerLike | null = null;

  constructor(threadId: string, config: unknown, options: AgentDispatcherRoleOptions = {}) {
    this.threadId = threadId;
    this.config = parseNormalizedAgentDispatcherConfig(config, { threadId })
      ?? AgentDispatcherConfigSchema.parse(config);
    this.stateStore = options.stateStore ?? new StateStore();
    this.buildPrompt = options.buildSystemPrompt ?? buildSystemPrompt;
    this.launch = options.launchDispatcher ?? launchDispatcher;
    this.createSessionManager = options.sessionManagerFactory ?? defaultSessionManagerFactory;
    this.readPlanWorkersByStatus = options.readWorkersByStatus ?? readWorkersByStatus;
    this.createLifecycleStore = options.lifecycleStoreFactory ?? defaultLifecycleStoreFactory;
    const sharedMeridianApi = options.meridianApi ?? createMeridianApiClient();
    this.killTrackedThread = options.killThread ?? ((threadId) => defaultKillThread(threadId, sharedMeridianApi));
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
      dispatcherThreadId = await this.executeDispatcherHubLaunch();
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

  /**
   * Spawn a new Hub dispatcher thread and record it in the lifecycle sidecar.
   * Does not clear an existing thread; use when the role is first activated.
   */
  private async executeDispatcherHubLaunch(): Promise<string> {
    const sessionManager = this.requireSessionManager();
    const inProgressWorkers = await this.readPlanWorkersByStatus(this.config.dispatch_plan_path, "🔄");
    if (inProgressWorkers.length > 0) {
      await sessionManager.onRestart();
    }

    const systemPrompt = this.resolveDispatcherSystemPrompt();
    const launched = await this.launch({
      agentType: this.config.agent_type,
      modelId: this.config.model_id,
      mode: this.config.mode,
      autoApprove: this.config.auto_approve,
      systemPrompt,
      dispatchRepoRoot: resolveConfiguredDispatchRepoRoot(this.config),
      dispatchPlanPath: this.config.dispatch_plan_path,
      commandFilePath: this.config.command_file_path,
      dispatcherRoleId: this.threadId,
      userReplyChannel: this.getPrimaryReplyChannel()
    });
    if (!launched.ok || !launched.threadId.trim()) {
      const launchError = launched.error ?? "Failed to launch dispatcher agent";
      const orphanedThreadId = launched.threadId.trim();
      if (orphanedThreadId) {
        try {
          await this.killTrackedThread(orphanedThreadId);
        } catch (error) {
          throw new Error(`${launchError}; orphan cleanup failed for thread ${orphanedThreadId}: ${asError(error).message}`);
        }
      }

      throw new Error(launchError);
    }

    const dispatcherThreadId = launched.threadId;
    await sessionManager.initSession(dispatcherThreadId, this.config.dispatch_plan_path);
    return dispatcherThreadId;
  }

  private resolveDispatcherSystemPrompt(): string {
    const configuredSystemPrompt = this.config.system_prompt?.trim();
    const defaultSystemPrompt = this.buildPrompt({
      dispatch_plan_path: this.config.dispatch_plan_path,
      command_file_path: this.config.command_file_path,
      dispatcher_role_id: this.threadId,
      dispatch_repo_root: resolveConfiguredDispatchRepoRoot(this.config),
      docs_root: resolveConfiguredDocsRoot(this.config),
      user_reply_channels: JSON.stringify(this.config.user_reply_channels),
      default_agent_type: this.config.agent_type,
      default_mode: this.config.mode,
      kill_policy: this.config.kill_policy,
      auto_approve: this.config.auto_approve,
      resolved_model_map_json: JSON.stringify(this.resolveDispatchModelMap())
    });
    return configuredSystemPrompt && configuredSystemPrompt.length > 0
      ? materializeDispatcherSystemPrompt(configuredSystemPrompt, this.threadId)
      : defaultSystemPrompt;
  }

  private resolveDispatchModelMap() {
    try {
      const markdown = fsSync.readFileSync(this.config.dispatch_plan_path, "utf8");
      return resolveDispatchModelMapFromMarkdown(markdown, this.config.model_map);
    } catch {
      return this.config.model_map ?? {};
    }
  }

  /**
   * Kill any stale Hub dispatcher thread, reset the sidecar dispatcher row, and launch a new Hub session.
   * For use when dispatcher_thread_id is pending or the in-memory Hub thread is out of sync with disk.
   */
  async relaunchHubSession(): Promise<{ dispatcher_thread_id: string }> {
    const sessionManager = this.requireSessionManager();
    this.requireContext();
    await sessionManager.prepareFreshDispatcherLaunch();
    const dispatcherThreadId = await this.executeDispatcherHubLaunch();
    await this.persistState(sessionManager.isPaused() ? "paused" : "active");
    return { dispatcher_thread_id: dispatcherThreadId };
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
      this.ctx?.log.warn("Agent dispatcher failed to reset dispatch lifecycle state", {
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

  async onInboundResult(): Promise<void> {
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
    sessionManager.setPaused(status === "paused", { skipPersist: true });
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
    return toDispatchThreadState(this.createLifecycleStore(this.config.dispatch_plan_path).load());
  }

  private async resetTrackedThreads(): Promise<void> {
    const lifecycleStore = this.createLifecycleStore(this.config.dispatch_plan_path);
    const lifecycleState = lifecycleStore.load();
    const nowIso = new Date().toISOString();
    const nextWorkers = Object.fromEntries(
      Object.entries(lifecycleState.workers).map(([workerId, worker]) => [
        workerId,
        worker.status === "running"
          ? {
              ...worker,
              status: resolveStoppedWorkerStatus(worker),
              last_seen_at: nowIso
            }
          : worker
      ])
    );

    lifecycleStore.save({
      ...lifecycleState,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "pending"
      },
      workers: nextWorkers
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
    model_map: config.model_map ? Object.fromEntries(
      Object.entries(config.model_map).map(([code, entry]) => [
        code,
        { ...entry }
      ])
    ) : undefined,
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

function expectedOutputsExist(expectedOutputs: string[], startedAt?: string): boolean {
  return outputArtifactsExist(expectedOutputs, startedAt);
}

function outputArtifactsContainFailureSignal(expectedOutputs: string[], startedAt?: string): boolean {
  return outputArtifactsContain(
    expectedOutputs,
    (content) => hubResultContainsFailureSignal({ content }),
    startedAt
  );
}

function outputArtifactsContainBlockSignal(expectedOutputs: string[], startedAt?: string): boolean {
  return outputArtifactsContain(
    expectedOutputs,
    (content) => hubResultContainsBlockSignal({ content }),
    startedAt
  );
}

function resolveStoppedWorkerStatus(worker: DispatchWorkerState): "completed" | "failed" | "blocked" | "abandoned" {
  if (outputArtifactsContainFailureSignal(worker.expected_outputs, worker.started_at)) {
    if (outputArtifactsContainBlockSignal(worker.expected_outputs, worker.started_at)) {
      return "blocked";
    }

    return "failed";
  }

  return expectedOutputsExist(worker.expected_outputs, worker.started_at) ? "completed" : "abandoned";
}

function defaultSessionManagerFactory(threadId: string, options: SessionManagerOptions): SessionManagerLike {
  return new SessionManager(threadId, options);
}

function defaultLifecycleStoreFactory(dispatchPlanPath: string): LifecycleStoreLike {
  return new LifecycleStore(resolveDispatchThreadPath(dispatchPlanPath));
}

async function defaultKillThread(threadId: string, meridianApi: MeridianApiClient): Promise<void> {
  await meridianApi.kill(threadId);
}

async function defaultSignalDispatcher(
  dispatcherThreadId: string,
  status: DispatcherLifecycleStatus
): Promise<void> {
  const commandPath = path.join(tmpdir(), `dispatcher_status_${randomUUID()}.md`);
  await writeFile(commandPath, buildStatusSignalPrompt(status), "utf8");

  let handoffStarted = false;
  try {
    const handoff = runTool.execute({
      thread_id: dispatcherThreadId,
      command: commandPath,
      worker: DISPATCHER_STATUS_WORKER_ID
    });
    handoffStarted = true;

    handoff.catch((error) => {
      console.warn("dispatcher status signal background run failed", {
        dispatcherThreadId,
        status,
        error: asError(error).message
      });
    });

    const timer = setTimeout(() => {
      void unlinkFile(commandPath).catch(() => undefined);
    }, SIGNAL_FILE_CLEANUP_DELAY_MS);
    timer.unref?.();
  } finally {
    if (!handoffStarted) {
      await unlinkFile(commandPath).catch(() => undefined);
    }
  }
}

function buildStatusSignalPrompt(status: DispatcherLifecycleStatus): string {
  if (status === "paused") {
    return "# Dispatcher Control\nPause requested. Stop starting new workers after the current tool call finishes. Remain idle until explicitly resumed.";
  }

  return "# Dispatcher Control\nResume requested. Re-read the dispatch plan from disk and continue from the next eligible worker.";
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json");
}

function toDispatchThreadState(lifecycleState: ReturnType<LifecycleStoreLike["load"]>): DispatchThreadState {
  const workers = Object.fromEntries(
    Object.entries(lifecycleState.workers)
      .filter(([, worker]) => worker.status === "running")
      .map(([workerId, worker]) => [
        workerId,
        {
          thread_id: worker.thread_id,
          started_at: worker.started_at
        }
      ])
  );

  return {
    dispatcher_thread_id: lifecycleState.dispatcher.status === "running"
      ? lifecycleState.dispatcher.thread_id
      : null,
    workers
  };
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
