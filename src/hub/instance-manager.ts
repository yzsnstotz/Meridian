import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { buildClaudeSpawnArgs } from "../agents/claude";
import { buildCodexSpawnArgs } from "../agents/codex";
import { buildCursorSpawnArgs } from "../agents/cursor";
import { buildGeminiSpawnArgs } from "../agents/gemini";
import { config } from "../config";
import { createLogger } from "../logger";
import { APPROVAL_HELP_TEXT, approvalActionToTmuxKeys, normalizeApprovalAction } from "../shared/approval";
import { AgentAPIClient } from "../shared/agentapi-client";
import { ProviderModelCatalog } from "../shared/model-catalog";
import type {
  AgentInstance,
  AgentInstanceStatus,
  AgentType,
  BridgeMode,
  ProviderModelCatalog as ProviderModelCatalogPayload
} from "../types";
import { InstanceRegistry } from "./registry";
import { buildPersistedHubState, type PersistedHubState } from "./state-store";

type SpawnFn = typeof spawn;
type ExecSyncFn = typeof execSync;
type SocketPathFactory = (threadId: string) => string;

interface StatusClient {
  connect: (endpoint: string) => Promise<void>;
  disconnect: () => void;
  getStatus: () => Promise<Record<string, unknown>>;
}

export interface InstanceStatus {
  instance: AgentInstance;
  agent_status: Record<string, unknown>;
}

export interface SessionBinding {
  session: string;
  thread_id: string;
  previous_thread_id: string | null;
}

export interface ThreadAttachment {
  sessions: string[];
  interface_id: string | null;
}

export interface RehydrationResult {
  restored_thread_ids: string[];
  pruned_thread_ids: string[];
}

export interface InstanceManagerOptions {
  agentapiBinPath?: string;
  logDir?: string;
  agentWorkdir?: string;
  spawnFn?: SpawnFn;
  execSyncFn?: ExecSyncFn;
  socketPathFactory?: SocketPathFactory;
  agentapiSocketSupport?: boolean;
  agentapiAttachSocketSupport?: boolean;
  clientFactory?: (threadId: string) => StatusClient;
  modelCatalog?: ProviderModelCatalog;
  now?: () => Date;
  paneBridgeUsePtyWrapper?: boolean;
  /** When pane delta has no overlap (full-screen redraw), write last K lines to log instead of skipping. Default 50. */
  paneDeltaTailLinesWhenNoOverlap?: number;
}

const SESSION_THREAD_PLACEHOLDERS = new Set(["active", "all", "global", "pending", "unbound", "none"]);
const VALID_INSTANCE_STATUSES = new Set<AgentInstanceStatus>([
  "idle",
  "running",
  "waiting",
  "stopped",
  "error"
]);
const DEFAULT_NODE_ENV = process.env.NODE_ENV ?? "development";
const DEFAULT_LOG_DIR = process.env.LOG_DIR ?? "/var/log/hub";
const DEFAULT_AGENT_WORKDIR = config.AGENT_WORKDIR;
/** When overlap is 0 (full-screen redraw), write this many tail lines to pane log instead of skipping. */
const PANE_DELTA_TAIL_LINES_WHEN_NO_OVERLAP = 50;
/** Bytes of pane log tail to read when deduping capture vs run-injected content. */
const CAPTURE_DEDUP_TAIL_SIZE = 65536;
type SpawnStdioMode = "inherit" | ["ignore", number, number];
type AgentEndpointBinding = {
  endpoint: string;
  listenArg: string;
  transport: "socket" | "http";
};

interface PaneCaptureState {
  timer: NodeJS.Timeout;
  tmuxSession: string;
  logPath: string;
  lastSnapshot: string;
}

export class InstanceManager {
  private readonly log = createLogger("instance_mgr");
  private readonly agentapiBinPath: string;
  private readonly logDir: string;
  private readonly agentWorkdir: string;
  private readonly spawnFn: SpawnFn;
  private readonly execSyncFn: ExecSyncFn;
  private readonly socketPathFactory: SocketPathFactory;
  private readonly forcedAgentapiSocketSupport: boolean | null;
  private readonly forcedAgentapiAttachSocketSupport: boolean | null;
  private readonly clientFactory: (threadId: string) => StatusClient;
  private readonly modelCatalog: ProviderModelCatalog;
  private readonly now: () => Date;
  private readonly paneBridgeUsePtyWrapper: boolean;
  private readonly paneDeltaTailLinesWhenNoOverlap: number;
  private agentapiSocketSupportCache: boolean | null = null;
  private agentapiAttachSocketSupportCache: boolean | null = null;
  private paneCaptureIntervalMs: number = config.PANE_CAPTURE_INTERVAL_MS;
  private readonly children = new Map<string, ChildProcess>();
  private readonly agentLogFdByThread = new Map<string, number>();
  private readonly paneCaptureByThread = new Map<string, PaneCaptureState>();
  private readonly sessionThreadBySession = new Map<string, string>();
  private readonly startupAttempts = 180;
  private readonly startupDelayMs = 250;
  private readonly spawnAttempts = 3;
  private readonly spawnRetryDelayMs = 500;

  constructor(
    private readonly registry: InstanceRegistry,
    options: InstanceManagerOptions = {}
  ) {
    this.agentapiBinPath = options.agentapiBinPath ?? path.resolve(process.cwd(), "bin/agentapi");
    this.logDir = options.logDir ?? DEFAULT_LOG_DIR;
    this.agentWorkdir = this.resolveWorkdir(options.agentWorkdir ?? DEFAULT_AGENT_WORKDIR);
    this.spawnFn = options.spawnFn ?? spawn;
    this.execSyncFn = options.execSyncFn ?? execSync;
    this.socketPathFactory = options.socketPathFactory ?? ((threadId: string) => this.formatAgentSocketPath(threadId));
    this.forcedAgentapiSocketSupport = options.agentapiSocketSupport ?? null;
    this.forcedAgentapiAttachSocketSupport = options.agentapiAttachSocketSupport ?? null;
    this.clientFactory =
      options.clientFactory ??
      ((threadId: string) => {
        return new AgentAPIClient({ threadId });
      });
    this.modelCatalog = options.modelCatalog ?? new ProviderModelCatalog();
    this.now = options.now ?? (() => new Date());
    this.paneBridgeUsePtyWrapper = options.paneBridgeUsePtyWrapper ?? false;
    this.paneDeltaTailLinesWhenNoOverlap =
      options.paneDeltaTailLinesWhenNoOverlap ?? PANE_DELTA_TAIL_LINES_WHEN_NO_OVERLAP;
  }

  async spawn(
    type: AgentType,
    mode: BridgeMode,
    workingDirectory?: string,
    modelId?: string,
    autoApprove?: boolean
  ): Promise<string> {
    return await this.spawnWithRetry(type, mode, undefined, workingDirectory, modelId, autoApprove);
  }

  async kill(threadId: string): Promise<void> {
    await this.killInternal(threadId, false);
  }

  attach(threadId: string, session: string): SessionBinding {
    const sanitizedSession = this.sanitizeSession(session);
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot attach session; thread_id=${threadId} is not registered`);
    }

    const currentAttachment = this.getThreadAttachment(threadId);
    const incomingInterfaceId = this.extractInterfaceIdFromSession(sanitizedSession);
    if (currentAttachment.interface_id && currentAttachment.interface_id !== incomingInterfaceId) {
      throw new Error(
        `Cannot attach session; thread_id=${threadId} is already attached to interface=${currentAttachment.interface_id}`
      );
    }

    const previousThreadId = this.sessionThreadBySession.get(sanitizedSession) ?? null;
    this.sessionThreadBySession.set(sanitizedSession, threadId);

    this.log.info(
      {
        operation: "attach",
        thread_id: threadId,
        session: sanitizedSession,
        previous_thread_id: previousThreadId,
        pid: instance.pid,
        socket_path: instance.socket_path,
        prev_status: instance.status,
        next_status: instance.status
      },
      "Session attached to agent instance"
    );

    return {
      session: sanitizedSession,
      thread_id: threadId,
      previous_thread_id: previousThreadId
    };
  }

  detach(session: string): string | null {
    const sanitizedSession = this.sanitizeSession(session);
    const previous = this.sessionThreadBySession.get(sanitizedSession) ?? null;
    this.sessionThreadBySession.delete(sanitizedSession);

    const instance = previous ? this.registry.get(previous) : null;
    this.log.info(
      {
        operation: "detach",
        session: sanitizedSession,
        thread_id: previous,
        pid: instance?.pid ?? null,
        socket_path: instance?.socket_path ?? null,
        prev_status: instance?.status ?? null,
        next_status: instance?.status ?? null
      },
      "Session detached from agent instance"
    );

    return previous;
  }

  getAttachedThread(session: string): string | null {
    const normalized = session.trim();
    if (!normalized) {
      return null;
    }
    return this.sessionThreadBySession.get(normalized) ?? null;
  }

  getSessionsForThread(threadId: string): string[] {
    const sessions: string[] = [];
    for (const [session, boundThreadId] of this.sessionThreadBySession.entries()) {
      if (boundThreadId === threadId) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  getThreadAttachment(threadId: string): ThreadAttachment {
    const sessions = this.getSessionsForThread(threadId);
    const interfaceIds = new Set<string>();
    for (const session of sessions) {
      interfaceIds.add(this.extractInterfaceIdFromSession(session));
    }
    const interfaceId = interfaceIds.size > 0 ? Array.from(interfaceIds.values())[0] ?? null : null;
    return { sessions, interface_id: interfaceId };
  }

  isThreadAttachableBySession(threadId: string, session: string): boolean {
    const currentAttachment = this.getThreadAttachment(threadId);
    if (!currentAttachment.interface_id) {
      return true;
    }
    const incomingInterfaceId = this.extractInterfaceIdFromSession(this.sanitizeSession(session));
    return currentAttachment.interface_id === incomingInterfaceId;
  }

  async restart(threadId: string): Promise<string> {
    const existing = this.registry.get(threadId);
    if (!existing) {
      throw new Error(`Cannot restart; thread_id=${threadId} is not registered`);
    }

    const previousStatus = existing.status;
    await this.killInternal(threadId, true);
    const restartedThreadId = await this.spawnWithRetry(
      existing.agent_type,
      existing.mode,
      threadId,
      existing.working_dir,
      existing.model_id,
      existing.auto_approve
    );
    const current = this.registry.get(restartedThreadId);

    this.log.info(
      {
        operation: "restart",
        thread_id: restartedThreadId,
        pid: current?.pid ?? null,
        socket_path: current?.socket_path ?? null,
        prev_status: previousStatus,
        next_status: current?.status ?? "idle"
      },
      "Agent instance restarted"
    );

    return restartedThreadId;
  }

  async listModels(threadId: string): Promise<ProviderModelCatalogPayload> {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot list models; thread_id=${threadId} is not registered`);
    }

    const catalog = await this.modelCatalog.listModels(instance.agent_type);
    return {
      thread_id: threadId,
      provider: catalog.provider,
      current_model_id: instance.model_id ?? null,
      models: catalog.models
    };
  }

  sendTerminalInput(threadId: string, rawInput: string): string {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot send terminal input; thread_id=${threadId} is not registered`);
    }

    if (instance.mode !== "pane_bridge" || !instance.tmux_pane) {
      throw new Error(
        `Thread ${threadId} is running in mode=${instance.mode}; terminal_input requires a pane_bridge thread with tmux.`
      );
    }

    const action = normalizeApprovalAction(rawInput);
    const keys = action
      ? approvalActionToTmuxKeys(action)
      : this.rawTerminalInputToTmuxKeys(rawInput);
    const escapedKeys = keys.map((key) => this.shellEscape(key)).join(" ");
    this.execSyncFn(`tmux send-keys -t ${this.shellEscape(instance.tmux_pane)} ${escapedKeys}`, {
      stdio: "ignore"
    });

    this.log.info(
      {
        operation: "terminal_input",
        thread_id: threadId,
        tmux_pane: instance.tmux_pane,
        approval_action: action ?? null,
        raw_input: action ? null : rawInput,
        keys
      },
      "Sent terminal input to tmux pane"
    );

    return action ? `Sent approval action '${action}' to ${threadId}.` : `Sent terminal input to ${threadId}.`;
  }

  private rawTerminalInputToTmuxKeys(rawInput: string): string[] {
    const normalized = rawInput.replace(/\r/g, "");
    if (!normalized.trim()) {
      throw new Error(`Unsupported empty terminal input. ${APPROVAL_HELP_TEXT}`);
    }

    const lines = normalized.split("\n");
    const keys: string[] = [];
    for (const line of lines) {
      if (line.length > 0) {
        keys.push(line);
      }
      keys.push("Enter");
    }
    return keys;
  }

  snapshotState(): PersistedHubState {
    return buildPersistedHubState(
      this.now().toISOString(),
      this.registry.list(),
      Object.fromEntries(this.sessionThreadBySession.entries())
    );
  }

  async rehydrateFromState(state: PersistedHubState): Promise<RehydrationResult> {
    this.registry.clear();
    this.children.clear();
    for (const threadId of this.paneCaptureByThread.keys()) {
      this.stopTmuxPaneCapture(threadId);
    }
    this.sessionThreadBySession.clear();

    const restoredThreadIds: string[] = [];
    const prunedThreadIds: string[] = [];
    const liveThreadIds = new Set<string>();

    for (const persistedInstance of state.instances ?? []) {
      const hydratedInstance = await this.rehydrateInstance(persistedInstance);
      if (!hydratedInstance) {
        prunedThreadIds.push(persistedInstance.thread_id);
        continue;
      }

      this.registry.register(hydratedInstance);
      restoredThreadIds.push(hydratedInstance.thread_id);
      liveThreadIds.add(hydratedInstance.thread_id);
    }

    for (const [session, threadId] of Object.entries(state.session_bindings ?? {})) {
      if (!liveThreadIds.has(threadId)) {
        continue;
      }
      try {
        this.sessionThreadBySession.set(this.sanitizeSession(session), threadId);
      } catch {
        // Ignore invalid persisted bindings and continue restoring the rest.
      }
    }

    return {
      restored_thread_ids: restoredThreadIds,
      pruned_thread_ids: prunedThreadIds
    };
  }

  async switchModel(threadId: string, nextModelId: string): Promise<string> {
    const existing = this.registry.get(threadId);
    if (!existing) {
      throw new Error(`Cannot switch model; thread_id=${threadId} is not registered`);
    }

    if (existing.model_id === nextModelId) {
      return threadId;
    }

    const previousStatus = existing.status;
    const previousModelId = existing.model_id ?? null;
    await this.killInternal(threadId, true);
    const restartedThreadId = await this.spawnWithRetry(
      existing.agent_type,
      existing.mode,
      threadId,
      existing.working_dir,
      nextModelId,
      existing.auto_approve
    );
    const current = this.registry.get(restartedThreadId);

    this.log.info(
      {
        operation: "switch_model",
        thread_id: restartedThreadId,
        agent_type: existing.agent_type,
        from_model_id: previousModelId,
        to_model_id: nextModelId,
        pid: current?.pid ?? null,
        socket_path: current?.socket_path ?? null,
        prev_status: previousStatus,
        next_status: current?.status ?? "idle"
      },
      "Agent instance model switched"
    );

    return restartedThreadId;
  }

  async status(threadId: string): Promise<InstanceStatus> {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot fetch status; thread_id=${threadId} is not registered`);
    }

    const client = this.clientFactory(threadId);
    await client.connect(instance.socket_path);

    try {
      const rawStatus = await client.getStatus();
      const reportedStatus = this.toKnownStatus(rawStatus.status);
      const updatedInstance = reportedStatus ? this.registry.setStatus(threadId, reportedStatus) ?? instance : instance;

      this.log.debug(
        {
          operation: "status",
          thread_id: threadId,
          pid: updatedInstance.pid,
          socket_path: updatedInstance.socket_path,
          prev_status: instance.status,
          next_status: reportedStatus ?? instance.status
        },
        "Agent status fetched"
      );

      return {
        instance: updatedInstance,
        agent_status: rawStatus
      };
    } finally {
      client.disconnect();
    }
  }

  list(): AgentInstance[] {
    return this.registry.list();
  }

  private async spawnWithRetry(
    type: AgentType,
    mode: BridgeMode,
    threadIdOverride?: string,
    workingDirectory?: string,
    modelId?: string,
    autoApprove?: boolean
  ): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.spawnAttempts; attempt += 1) {
      try {
        return await this.spawnInternal(type, mode, threadIdOverride, workingDirectory, modelId, autoApprove);
      } catch (error) {
        lastError = error;
        if (!this.shouldRetrySpawn(error) || attempt >= this.spawnAttempts) {
          throw error;
        }

        this.log.warn(
          {
            operation: "spawn_retry",
            thread_id: threadIdOverride ?? null,
            agent_type: type,
            mode,
            attempt,
            max_attempts: this.spawnAttempts,
            err: error instanceof Error ? error.message : String(error)
          },
          "Retrying agent spawn after transient readiness failure"
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.spawnRetryDelayMs);
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private shouldRetrySpawn(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message;
    return (
      message.includes("Agent instance failed readiness check") ||
      message.includes("Failed to connect to agentapi") ||
      message.includes("Failed to call GET /status") ||
      message.includes("connect ECONNREFUSED")
    );
  }

  private async spawnInternal(
    type: AgentType,
    mode: BridgeMode,
    threadIdOverride?: string,
    workingDirectory?: string,
    modelId?: string,
    autoApprove?: boolean
  ): Promise<string> {
    const threadId = threadIdOverride ?? this.nextThreadId(type);
    const spawnWorkdir = this.resolveWorkdir(workingDirectory ?? this.agentWorkdir);
    const endpointBinding = await this.resolveAgentEndpointBinding(threadId);
    const socketPath = endpointBinding.endpoint;
    if (endpointBinding.transport === "socket") {
      await this.removeSocketPath(socketPath);
    }
    const tmuxSession = mode === "pane_bridge" ? `agent_${threadId}` : null;
    const args = this.buildSpawnArgs(type, endpointBinding.listenArg, modelId, autoApprove);
    const childEnv = this.buildChildEnv();

    if (tmuxSession) {
      this.safeKillTmuxSession(tmuxSession);
      const stdio = this.buildSpawnStdio(threadId);
      const paneLaunch = this.wrapWithPseudoTerminal(this.agentapiBinPath, args, this.paneBridgeUsePtyWrapper);
      this.log.info(
        {
          operation: "spawn_launch",
          mode,
          thread_id: threadId,
          socket_path: socketPath,
          working_directory: spawnWorkdir,
          command: paneLaunch.command,
          args: paneLaunch.args,
          pane_bridge_use_pty_wrapper: this.paneBridgeUsePtyWrapper,
          child_path: this.summarizePath(childEnv.PATH),
          stdio_mode: stdio === "inherit" ? "inherit" : "redirected"
        },
        "Launching agent instance process"
      );
      const child = this.spawnFn(paneLaunch.command, paneLaunch.args, {
        detached: true,
        stdio,
        env: childEnv,
        cwd: spawnWorkdir
      });

      if (!child.pid) {
        throw new Error(`Failed to spawn agentapi process for thread_id=${threadId}`);
      }

      this.log.info(
        {
          operation: "spawn_pid",
          mode,
          thread_id: threadId,
          socket_path: socketPath,
          pid: child.pid
        },
        "Spawned agent instance process"
      );

      const instance: AgentInstance = {
        thread_id: threadId,
        agent_type: type,
        model_id: modelId,
        mode,
        socket_path: socketPath,
        working_dir: spawnWorkdir,
        pid: child.pid,
        tmux_pane: tmuxSession,
        status: "idle",
        created_at: this.now().toISOString(),
        restart_safe: true
      };

      this.registry.register(instance);
      if (autoApprove === true) {
        this.registry.setAutoApprove(threadId, true);
      }
      this.children.set(threadId, child);
      this.maybeUnrefChild(child, stdio);
      this.watchChildProcess(threadId, child);
      try {
        await this.assertAgentReady(threadId, socketPath);
        const attachArgs = this.buildAgentAttachCliArgs(endpointBinding);
        if (attachArgs) {
          this.spawnInTmuxSession(threadId, tmuxSession, attachArgs);
        }
      } catch (error) {
        await this.killInternal(threadId, false).catch(() => undefined);
        throw error;
      }
      this.log.info(
        {
          operation: "spawn",
          mode,
          thread_id: threadId,
          pid: child.pid,
          socket_path: socketPath,
          tmux_pane: tmuxSession,
          prev_status: null,
          next_status: "idle"
        },
        "Agent instance spawned"
      );

      return threadId;
    }

    const stdio = this.buildSpawnStdio(threadId);
    this.log.info(
      {
        operation: "spawn_launch",
        mode,
        thread_id: threadId,
        socket_path: socketPath,
        working_directory: spawnWorkdir,
        command: this.agentapiBinPath,
        args,
        pane_bridge_use_pty_wrapper: this.paneBridgeUsePtyWrapper,
        child_path: this.summarizePath(childEnv.PATH),
        stdio_mode: stdio === "inherit" ? "inherit" : "redirected"
      },
      "Launching agent instance process"
    );
    const child = this.spawnFn(this.agentapiBinPath, args, {
      detached: true,
      stdio,
      env: childEnv,
      cwd: spawnWorkdir
    });

    if (!child.pid) {
      throw new Error(`Failed to spawn agentapi process for thread_id=${threadId}`);
    }

    this.log.info(
      {
        operation: "spawn_pid",
        mode,
        thread_id: threadId,
        socket_path: socketPath,
        pid: child.pid
      },
      "Spawned agent instance process"
    );

    const instance: AgentInstance = {
      thread_id: threadId,
      agent_type: type,
      model_id: modelId,
      mode,
      socket_path: socketPath,
      working_dir: spawnWorkdir,
      pid: child.pid,
      tmux_pane: tmuxSession,
      status: "idle",
      created_at: this.now().toISOString(),
      restart_safe: true
    };

    this.registry.register(instance);
    if (autoApprove === true) {
      this.registry.setAutoApprove(threadId, true);
    }
    this.children.set(threadId, child);
    this.maybeUnrefChild(child, stdio);
    this.watchChildProcess(threadId, child);
    await this.assertAgentReady(threadId, socketPath);

    this.log.info(
      {
        operation: "spawn",
        mode,
        thread_id: threadId,
        pid: child.pid,
        socket_path: socketPath,
        tmux_pane: tmuxSession,
        prev_status: null,
        next_status: "idle"
      },
      "Agent instance spawned"
    );

    return threadId;
  }

  private async assertAgentReady(threadId: string, endpoint: string): Promise<void> {
    let lastError: string | null = null;

    for (let attempt = 0; attempt < this.startupAttempts; attempt += 1) {
      const child = this.children.get(threadId);
      if (!child || !this.isChildRunning(child)) {
        const exitCode = child?.exitCode ?? null;
        const signal = child?.signalCode ?? null;
        this.log.warn(
          {
            operation: "readiness_child_not_running",
            thread_id: threadId,
            endpoint,
            attempt,
            exit_code: exitCode,
            signal
          },
          "Agent process is not running during readiness check"
        );
        lastError = `agentapi process exited before readiness check succeeded (exit_code=${exitCode}, signal=${signal})`;
        break;
      }

      const client = this.clientFactory(threadId);
      try {
        await client.connect(endpoint);
        await client.getStatus();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === 0) {
          this.log.warn(
            {
              operation: "readiness_probe_failed",
              thread_id: threadId,
              endpoint,
              attempt,
              err: lastError
            },
            "Initial readiness probe failed"
          );
        }
      } finally {
        client.disconnect();
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.startupDelayMs);
      });
    }

    await this.killInternal(threadId, false).catch(() => undefined);
    throw new Error(
      `Agent instance failed readiness check for thread_id=${threadId}: ${lastError ?? "unknown startup error"}`
    );
  }

  private async rehydrateInstance(instance: AgentInstance): Promise<AgentInstance | null> {
    const client = this.clientFactory(instance.thread_id);
    try {
      await client.connect(instance.socket_path);
      const rawStatus = await client.getStatus();
      const reportedStatus = this.toKnownStatus(rawStatus.status);
      return {
        ...instance,
        status: reportedStatus ?? instance.status
      };
    } catch (error) {
      this.log.warn(
        {
          operation: "rehydrate_probe_failed",
          thread_id: instance.thread_id,
          socket_path: instance.socket_path,
          pid: instance.pid,
          err: error instanceof Error ? error.message : String(error)
        },
        "Skipping persisted agent instance because readiness probe failed"
      );
      return null;
    } finally {
      client.disconnect();
    }
  }

  private async killInternal(threadId: string, preserveBindings: boolean): Promise<void> {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot kill; thread_id=${threadId} is not registered`);
    }

    if (instance.tmux_pane) {
      this.safeKillTmuxSession(instance.tmux_pane);
    }

    const child = this.children.get(threadId);
    if (child) {
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort kill; cleanup continues below.
      }
    } else {
      try {
        process.kill(instance.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }

    if (instance.socket_path.startsWith("/")) {
      await fs.promises.unlink(instance.socket_path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }

    this.children.delete(threadId);
    this.releaseAgentLogFd(threadId);
    this.stopTmuxPaneCapture(threadId);
    this.registry.unregister(threadId);

    if (!preserveBindings) {
      this.clearSessionBindingsForThread(threadId);
    }

    this.log.info(
      {
        operation: "kill",
        thread_id: threadId,
        pid: instance.pid,
        socket_path: instance.socket_path,
        prev_status: instance.status,
        next_status: "stopped"
      },
      "Agent instance killed"
    );
  }

  private watchChildProcess(threadId: string, child: ChildProcess): void {
    child.once("exit", (code, signal) => {
      this.children.delete(threadId);
      this.releaseAgentLogFd(threadId);
      this.stopTmuxPaneCapture(threadId);

      const instance = this.registry.get(threadId);
      if (!instance) {
        return;
      }

      const isGraceful = code === 0 || signal === "SIGTERM";
      const nextStatus: AgentInstanceStatus = isGraceful ? "stopped" : "error";

      if (isGraceful) {
        this.registry.unregister(threadId);
        this.clearSessionBindingsForThread(threadId);
      } else {
        // Crash: preserve instance and session bindings so the monitor service
        // can detect the failure and deliver a Telegram alert before cleanup.
        this.registry.setStatus(threadId, "error");
      }

      this.log.warn(
        {
          operation: "process_exit",
          thread_id: threadId,
          pid: instance.pid,
          socket_path: instance.socket_path,
          exit_code: code,
          signal,
          prev_status: instance.status,
          next_status: nextStatus,
          removed_from_registry: isGraceful
        },
        "Agent process exited"
      );
    });

    child.once("error", (error) => {
      const instance = this.registry.get(threadId);
      if (!instance) {
        return;
      }

      this.registry.setStatus(threadId, "error");
      this.log.error(
        {
          operation: "process_error",
          thread_id: threadId,
          pid: instance.pid,
          socket_path: instance.socket_path,
          prev_status: instance.status,
          next_status: "error",
          err: error.message
        },
        "Agent process emitted error"
      );
    });
  }

  private nextThreadId(type: AgentType): string {
    let maxIndex = 0;
    for (const instance of this.registry.list()) {
      if (instance.agent_type !== type) {
        continue;
      }

      const match = /^.+_(\d+)$/.exec(instance.thread_id);
      const index = match ? Number(match[1]) : 0;
      if (Number.isInteger(index) && index > maxIndex) {
        maxIndex = index;
      }
    }
    return `${type}_${String(maxIndex + 1).padStart(2, "0")}`;
  }

  private buildSpawnArgs(type: AgentType, listenArg: string, modelId?: string, autoApprove?: boolean): string[] {
    if (type === "codex") {
      return buildCodexSpawnArgs("bridge", null, listenArg, modelId, autoApprove);
    }
    if (type === "claude") {
      return buildClaudeSpawnArgs("bridge", null, listenArg, modelId, autoApprove);
    }
    if (type === "gemini") {
      return buildGeminiSpawnArgs("bridge", null, listenArg, modelId);
    }
    return buildCursorSpawnArgs("bridge", null, listenArg, modelId);
  }

  private buildAgentAttachCliArgs(binding: AgentEndpointBinding): string[] | null {
    if (binding.transport === "http") {
      return [this.agentapiBinPath, "attach", `--url=${binding.endpoint}`];
    }

    if (this.supportsAgentapiAttachSocketFlag()) {
      return [this.agentapiBinPath, "attach", `--socket=${binding.endpoint}`];
    }

    this.log.warn(
      {
        operation: "spawn_attach_skipped",
        endpoint: binding.endpoint
      },
      "agentapi attach does not support --socket; skipping tmux attach for pane_bridge"
    );
    return null;
  }

  private spawnInTmuxSession(
    threadId: string,
    tmuxSession: string,
    commandParts: string[]
  ): void {
    const command = commandParts
      .map((part) => this.shellEscape(part))
      .join(" ");
    const fullCommand = command;

    this.execSyncFn(
      `tmux new-session -d -s ${this.shellEscape(tmuxSession)} ${this.shellEscape(fullCommand)}`,
      {
        stdio: "ignore"
      }
    );
    this.configureTmuxSession(tmuxSession);
    this.startTmuxPaneCapture(threadId, tmuxSession);
  }

  private configureTmuxSession(tmuxSession: string): void {
    // Keep deep scrollback and disable alternate screen so attached viewers can
    // reliably scroll older output from full-screen TUIs.
    this.execSyncFn(`tmux set-option -t ${this.shellEscape(tmuxSession)} history-limit 200000`, {
      stdio: "ignore"
    });
    this.execSyncFn(`tmux set-window-option -t ${this.shellEscape(tmuxSession)} alternate-screen off`, {
      stdio: "ignore"
    });
    this.execSyncFn(`tmux set-option -t ${this.shellEscape(tmuxSession)} mouse on`, {
      stdio: "ignore"
    });
  }

  private startTmuxPaneCapture(threadId: string, tmuxSession: string): void {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const paneLogPath = path.join(this.logDir, `pane-${threadId}.log`);
      this.stopTmuxPaneCapture(threadId);
      const timer = setInterval(() => {
        this.capturePaneSnapshot(threadId);
      }, this.paneCaptureIntervalMs);
      timer.unref();
      this.paneCaptureByThread.set(threadId, {
        timer,
        tmuxSession,
        logPath: paneLogPath,
        lastSnapshot: ""
      });
    } catch (error) {
      this.log.warn(
        {
          operation: "pane_capture_start_failed",
          thread_id: threadId,
          tmux_session: tmuxSession,
          err: error instanceof Error ? error.message : String(error)
        },
        "Failed to start tmux pane capture"
      );
    }
  }

  getPaneCaptureIntervalMs(): number {
    return this.paneCaptureIntervalMs;
  }

  setPaneCaptureIntervalMs(intervalMs: number): void {
    const clamped = Math.max(2000, Math.min(30000, Math.floor(intervalMs)));
    if (clamped === this.paneCaptureIntervalMs) {
      return;
    }
    this.paneCaptureIntervalMs = clamped;

    // Restart all active capture timers with the new interval
    for (const [threadId, capture] of this.paneCaptureByThread.entries()) {
      clearInterval(capture.timer);
      const timer = setInterval(() => {
        this.capturePaneSnapshot(threadId);
      }, this.paneCaptureIntervalMs);
      timer.unref();
      capture.timer = timer;
    }
  }

  private stopTmuxPaneCapture(threadId: string): void {
    const capture = this.paneCaptureByThread.get(threadId);
    if (!capture) {
      return;
    }
    clearInterval(capture.timer);
    this.paneCaptureByThread.delete(threadId);
  }

  /**
   * Compute the delta (new lines only) between last snapshot and current snapshot.
   * Terminal output grows downward; when the pane scrolls, the top of the new snapshot
   * may overlap with the tail of the old. We find the longest overlap (last i lines of
   * old = first i lines of new) and return the remaining lines of new as the delta.
   * First frame (lastSnapshot === ""): return full snapshot normalized with trailing newline.
   * When overlap is 0 (e.g. full-screen redraw) and not first frame: return last K lines
   * only if they are not already present at the end of lastSnapshot, to avoid duplicate
   * blocks in the pane log (which would cause duplicate push deliveries).
   */
  private computePaneDelta(lastSnapshot: string, snapshot: string): string {
    const oldLines = lastSnapshot.split(/\n/);
    const newLines = snapshot.split(/\n/);
    const n = oldLines.length;
    const m = newLines.length;
    const K = this.paneDeltaTailLinesWhenNoOverlap;

    if (lastSnapshot === "") {
      return snapshot.trimEnd() ? snapshot.trimEnd() + "\n" : "";
    }

    let overlap = 0;
    for (let i = 1; i <= Math.min(n, m); i++) {
      const oldSuffix = oldLines.slice(n - i, n);
      const newPrefix = newLines.slice(0, i);
      if (oldSuffix.every((line, j) => line === newPrefix[j])) {
        overlap = i;
      }
    }
    if (overlap === 0) {
      const tailLines = newLines.slice(-K);
      const tailBlock = tailLines.join("\n") + (tailLines.length > 0 ? "\n" : "");
      const oldTail = oldLines.slice(-K).join("\n").trimEnd();
      const newTail = tailLines.join("\n").trimEnd();
      if (newTail.length > 0 && newTail === oldTail) {
        return "";
      }
      return tailBlock;
    }
    const deltaLines = newLines.slice(overlap);
    return deltaLines.join("\n") + (deltaLines.length > 0 ? "\n" : "");
  }

  private capturePaneSnapshot(threadId: string): void {
    const capture = this.paneCaptureByThread.get(threadId);
    if (!capture) {
      return;
    }

    try {
      // Capture currently visible pane content so the log gets output as soon as it
      // appears (scrollback-only capture wrote only when lines scrolled off, so the
      // log stayed empty on large panes or low output).
      const rawSnapshot = this.execSyncFn(
        `tmux capture-pane -e -p -t ${this.shellEscape(capture.tmuxSession)}`,
        { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }
      );
      const snapshot = this.toText(rawSnapshot).trimEnd();
      const delta = this.computePaneDelta(capture.lastSnapshot, snapshot);
      capture.lastSnapshot = snapshot;

      if (!delta) {
        return;
      }

      const timestamp = this.now().toISOString();
      fs.appendFileSync(capture.logPath, `\n--- ${timestamp} ---\n${delta}\n`, "utf8");
    } catch (error) {
      this.log.warn(
        {
          operation: "pane_capture_tick_failed",
          thread_id: threadId,
          tmux_session: capture.tmuxSession,
          err: error instanceof Error ? error.message : String(error)
        },
        "Failed to capture tmux pane snapshot"
      );
    }
  }

  private formatAgentSocketPath(threadId: string): string {
    return path.join("/tmp", `agentapi-${threadId}.sock`);
  }

  private formatAgentHttpEndpoint(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  private async resolveAgentEndpointBinding(threadId: string): Promise<AgentEndpointBinding> {
    if (this.supportsAgentapiSocketFlag()) {
      const socketPath = this.socketPathFactory(threadId);
      return {
        endpoint: socketPath,
        listenArg: `--socket=${socketPath}`,
        transport: "socket"
      };
    }

    const port = await this.allocateLoopbackPort();
    return {
      endpoint: this.formatAgentHttpEndpoint(port),
      listenArg: `--port=${port}`,
      transport: "http"
    };
  }

  private supportsAgentapiSocketFlag(): boolean {
    if (this.forcedAgentapiSocketSupport !== null) {
      return this.forcedAgentapiSocketSupport;
    }
    if (this.agentapiSocketSupportCache !== null) {
      return this.agentapiSocketSupportCache;
    }

    const supported = this.probeAgentapiFlagSupport("server", "--socket");
    this.agentapiSocketSupportCache = supported;
    return supported;
  }

  private supportsAgentapiAttachSocketFlag(): boolean {
    if (this.forcedAgentapiAttachSocketSupport !== null) {
      return this.forcedAgentapiAttachSocketSupport;
    }
    if (this.agentapiAttachSocketSupportCache !== null) {
      return this.agentapiAttachSocketSupportCache;
    }

    const supported = this.probeAgentapiFlagSupport("attach", "--socket");
    this.agentapiAttachSocketSupportCache = supported;
    return supported;
  }

  private probeAgentapiFlagSupport(command: "server" | "attach", flag: string): boolean {
    const helpOutput = this.readAgentapiHelp(command);
    const supported = helpOutput.includes(flag);

    this.log.info(
      {
        operation: "agentapi_feature_probe",
        command,
        flag,
        supported
      },
      "Detected agentapi flag support"
    );

    return supported;
  }

  private readAgentapiHelp(command: "server" | "attach"): string {
    const shellCommand = `${this.shellEscape(this.agentapiBinPath)} ${command} --help`;
    try {
      const output = this.execSyncFn(shellCommand, {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8"
      });
      return this.toText(output);
    } catch (error) {
      const details = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      return `${this.toText(details.stdout)}\n${this.toText(details.stderr)}\n${details.message ?? ""}`;
    }
  }

  private toText(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (Buffer.isBuffer(value)) {
      return value.toString("utf8");
    }
    return "";
  }

  private async allocateLoopbackPort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();

      server.once("error", (error) => {
        reject(error);
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => {
            reject(new Error("Failed to allocate ephemeral loopback port"));
          });
          return;
        }

        const selectedPort = address.port;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(selectedPort);
        });
      });
    });
  }

  private async removeSocketPath(socketPath: string): Promise<void> {
    if (!socketPath.startsWith("/")) {
      return;
    }

    await fs.promises.unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }

  private safeKillTmuxSession(sessionName: string): void {
    try {
      this.execSyncFn(`tmux kill-session -t ${this.shellEscape(sessionName)}`, {
        stdio: "ignore"
      });
    } catch {
      // Session may already be gone; cleanup continues below.
    }
  }

  private buildSpawnStdio(threadId: string): SpawnStdioMode {
    const shouldRedirectLogs = DEFAULT_NODE_ENV === "production" || Boolean(process.env.PM2_HOME);
    if (!shouldRedirectLogs) {
      return "inherit";
    }

    fs.mkdirSync(this.logDir, { recursive: true });
    const agentLogPath = path.join(this.logDir, `agentapi-${threadId}.log`);
    const fd = fs.openSync(agentLogPath, "a");
    this.agentLogFdByThread.set(threadId, fd);
    return ["ignore", fd, fd];
  }

  private maybeUnrefChild(child: ChildProcess, stdio: SpawnStdioMode): void {
    if (stdio === "inherit") {
      return;
    }
    if (typeof child.unref === "function") {
      child.unref();
    }
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TMUX;
    const home = env.HOME ?? process.env.HOME;
    if (home) {
      const fnmAliasBin = path.join(home, ".local", "share", "fnm", "aliases", "default", "bin");
      if (fs.existsSync(fnmAliasBin)) {
        env.PATH = this.prependPathEntry(env.PATH, fnmAliasBin);
      }
    }
    return env;
  }

  private isChildRunning(child: ChildProcess): boolean {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      return false;
    }
    return true;
  }

  private prependPathEntry(currentPath: string | undefined, entry: string): string {
    const segments = (currentPath ?? "")
      .split(path.delimiter)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (!segments.includes(entry)) {
      segments.unshift(entry);
    }
    return segments.join(path.delimiter);
  }

  private summarizePath(currentPath: string | undefined): string[] {
    if (!currentPath) {
      return [];
    }
    return currentPath
      .split(path.delimiter)
      .map((segment) => segment.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  private wrapWithPseudoTerminal(
    command: string,
    args: string[],
    enabled: boolean
  ): { command: string; args: string[] } {
    if (!enabled) {
      return { command, args };
    }

    return {
      command: "script",
      args: ["-q", "/dev/null", command, ...args]
    };
  }

  private releaseAgentLogFd(threadId: string): void {
    const fd = this.agentLogFdByThread.get(threadId);
    if (fd === undefined) {
      return;
    }

    this.agentLogFdByThread.delete(threadId);
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close failures during cleanup
    }
  }

  private clearSessionBindingsForThread(threadId: string): void {
    for (const [session, boundThreadId] of this.sessionThreadBySession.entries()) {
      if (boundThreadId === threadId) {
        this.sessionThreadBySession.delete(session);
      }
    }
  }

  private extractInterfaceIdFromSession(session: string): string {
    const separatorIndex = session.indexOf(":");
    if (separatorIndex <= 0) {
      return "legacy";
    }

    const maybeBotId = session.slice(0, separatorIndex);
    if (/^\d+$/.test(maybeBotId)) {
      return maybeBotId;
    }
    return "legacy";
  }

  private sanitizeSession(session: string): string {
    const value = session.trim();
    if (!value) {
      throw new Error("Session id cannot be empty");
    }
    if (SESSION_THREAD_PLACEHOLDERS.has(value)) {
      throw new Error(`Invalid session id: ${value}`);
    }
    return value;
  }

  private resolveWorkdir(candidate: string): string {
    const normalized = candidate.trim();
    if (!normalized) {
      throw new Error("Agent working directory cannot be empty");
    }

    const resolved = path.resolve(normalized);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      throw new Error(`Agent working directory does not exist: ${resolved}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Agent working directory is not a directory: ${resolved}`);
    }
    return resolved;
  }

  private toKnownStatus(candidate: unknown): AgentInstanceStatus | null {
    if (typeof candidate !== "string") {
      return null;
    }
    if (!VALID_INSTANCE_STATUSES.has(candidate as AgentInstanceStatus)) {
      return null;
    }
    return candidate as AgentInstanceStatus;
  }
}
