import { exec, execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { buildClaudeSpawnArgs } from "../agents/claude";
import { buildCodexExecArgs, buildCodexSpawnArgs } from "../agents/codex";
import { buildCursorSpawnArgs } from "../agents/cursor";
import { buildGeminiSpawnArgs } from "../agents/gemini";
import { config } from "../config";
import { createLogger } from "../logger";
import { AgentAPIClient } from "../shared/agentapi-client";
import { ProviderModelCatalog } from "../shared/model-catalog";
import {
  AgentTypeSchema,
  type AgentInstance,
  type AgentInstanceStatus,
  type AgentType,
  type BridgeMode,
  type CallerIdentity,
  type ProviderModelCatalog as ProviderModelCatalogPayload,
  type ReasoningEffort,
  type SandboxMode
} from "../types";
import type { ResolvedCredential } from "./credential-store";
import { InstanceRegistry } from "./registry";
import { buildPersistedHubState, type PersistedHubState } from "./state-store";

type SpawnFn = typeof spawn;
type ExecSyncFn = typeof execSync;
type ExecAsyncFn = (
  command: string,
  options?: { encoding?: BufferEncoding }
) => Promise<{ stdout: string; stderr: string }>;
type SocketPathFactory = (threadId: string) => string;

const defaultExecAsyncFn: ExecAsyncFn = promisify(exec) as ExecAsyncFn;

interface StatusClient {
  connect: (endpoint: string) => Promise<void>;
  disconnect: () => void;
  getStatus: () => Promise<Record<string, unknown>>;
  getMessages?: () => Promise<Record<string, unknown>[]>;
  sendRawInput?: (content: string) => Promise<Record<string, unknown>>;
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

export interface StreamSpawnResult {
  stdout: NodeJS.ReadableStream;
  process: ChildProcess;
}

export interface SpawnInvocationDescriptor {
  command: string;
  args: string[];
  provider_args: string[];
  provider_append: string;
  display: string;
}

export interface InstanceManagerOptions {
  agentapiBinPath?: string;
  logDir?: string;
  agentWorkdir?: string;
  spawnFn?: SpawnFn;
  execSyncFn?: ExecSyncFn;
  execAsyncFn?: ExecAsyncFn;
  socketPathFactory?: SocketPathFactory;
  agentapiSocketSupport?: boolean;
  clientFactory?: (threadId: string) => StatusClient;
  modelCatalog?: ProviderModelCatalog;
  now?: () => Date;
  /**
   * Override OS-level PID liveness check. Default uses `process.kill(pid, 0)`.
   * Tests inject `() => true` so fake pids count as live; production uses default.
   */
  pidLivenessFn?: (pid: number) => boolean;
  /** Max attempts for the rehydrate probe before reaping a stuck child. Default 3. */
  rehydrateProbeRetries?: number;
  /** Base delay between rehydrate probe retries (multiplied by attempt count). Default 500ms. */
  rehydrateProbeRetryDelayMs?: number;
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
const INTERRUPT_ESCAPE_SEQUENCE = "\u001b";
const STATELESS_SOCKET_PREFIX = "stateless:";
type SpawnStdioMode = "inherit" | ["ignore", number, number];
type AgentEndpointBinding = {
  endpoint: string;
  listenArg: string;
  transport: "socket" | "http";
};

export class InstanceManager {
  private readonly log = createLogger("instance_mgr");
  private readonly agentapiBinPath: string;
  private readonly logDir: string;
  private readonly agentWorkdir: string;
  private readonly spawnFn: SpawnFn;
  private readonly execSyncFn: ExecSyncFn;
  private readonly execAsyncFn: ExecAsyncFn;
  private readonly socketPathFactory: SocketPathFactory;
  private readonly forcedAgentapiSocketSupport: boolean | null;
  private readonly clientFactory: (threadId: string) => StatusClient;
  private readonly modelCatalog: ProviderModelCatalog;
  private readonly now: () => Date;
  private agentapiSocketSupportCache: boolean | null = null;
  private paneCaptureIntervalMs: number = config.PANE_CAPTURE_INTERVAL_MS;
  private readonly children = new Map<string, ChildProcess>();
  private readonly agentLogFdByThread = new Map<string, number>();
  private readonly sessionThreadBySession = new Map<string, string>();
  private readonly allocatedThreadMaxIndexByType = new Map<AgentType, number>();
  private readonly startupAttempts = 180;
  private readonly startupDelayMs = 250;
  private readonly spawnAttempts = 3;
  private readonly spawnRetryDelayMs = 500;
  private readonly pidLivenessFn: (pid: number) => boolean;
  private readonly rehydrateProbeRetries: number;
  private readonly rehydrateProbeRetryDelayMs: number;
  private onStateChange: (() => void) | null = null;

  constructor(
    private readonly registry: InstanceRegistry,
    options: InstanceManagerOptions = {}
  ) {
    this.agentapiBinPath = options.agentapiBinPath ?? path.resolve(process.cwd(), "bin/agentapi");
    this.logDir = options.logDir ?? DEFAULT_LOG_DIR;
    this.agentWorkdir = this.resolveWorkdir(options.agentWorkdir ?? DEFAULT_AGENT_WORKDIR);
    this.spawnFn = options.spawnFn ?? spawn;
    this.execSyncFn = options.execSyncFn ?? execSync;
    this.execAsyncFn = options.execAsyncFn ?? defaultExecAsyncFn;
    this.socketPathFactory = options.socketPathFactory ?? ((threadId: string) => this.formatAgentSocketPath(threadId));
    this.forcedAgentapiSocketSupport = options.agentapiSocketSupport ?? null;
    this.clientFactory =
      options.clientFactory ??
      ((threadId: string) => {
        return new AgentAPIClient({ threadId });
      });
    this.modelCatalog = options.modelCatalog ?? new ProviderModelCatalog();
    this.now = options.now ?? (() => new Date());
    this.pidLivenessFn =
      options.pidLivenessFn ??
      ((pid: number) => {
        if (!Number.isInteger(pid) || pid <= 1) {
          return false;
        }
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          // EPERM means the PID exists but is owned by another user — still alive.
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      });
    this.rehydrateProbeRetries = Math.max(1, options.rehydrateProbeRetries ?? 3);
    this.rehydrateProbeRetryDelayMs = Math.max(0, options.rehydrateProbeRetryDelayMs ?? 500);
  }

  /**
   * Wire a persistence callback that fires after any registry mutation that
   * matters for restart recovery (register, unregister, rehydrate complete).
   * Closes the spawn-then-persist race: previously, a hub crash between
   * `registry.register(instance)` and the route()-end persistStateSafely
   * left the agentapi child alive (detached: true) with no on-disk record,
   * producing `thread_id=X is not registered` errors on the next hub
   * generation.
   */
  setOnStateChange(callback: (() => void) | null): void {
    this.onStateChange = callback;
  }

  private notifyStateChange(): void {
    if (!this.onStateChange) {
      return;
    }
    try {
      this.onStateChange();
    } catch (error) {
      this.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "InstanceManager onStateChange callback threw"
      );
    }
  }

  async spawn(
    type: AgentType,
    mode: BridgeMode,
    workingDirectory?: string,
    modelId?: string,
    autoApprove?: boolean,
    reasoningEffort?: ReasoningEffort,
    spawnTraceId?: string | null,
    integrationProfile?: string,
    sandboxMode?: SandboxMode,
    caller?: CallerIdentity,
    resolvedCredential?: ResolvedCredential | null
  ): Promise<string> {
    return await this.spawnWithRetry(
      type,
      mode,
      undefined,
      workingDirectory,
      modelId,
      autoApprove,
      reasoningEffort,
      spawnTraceId,
      integrationProfile,
      sandboxMode,
      caller,
      resolvedCredential ?? null
    );
  }

  spawnStreamAgent(
    threadId: string,
    agentType: AgentType,
    args: string[],
    prompt: string,
    traceId?: string | null
  ): StreamSpawnResult {
    if (args.length === 0 || !args[0]) {
      throw new Error(`Cannot spawn stream agent for thread_id=${threadId}: missing command`);
    }

    const instance = this.registry.get(threadId);
    const spawnWorkdir = this.resolveWorkdir(instance?.working_dir ?? this.agentWorkdir);
    const childEnv = this.buildChildEnv();
    const [command, ...commandArgs] = args;

    this.log.info(
      {
        operation: "stream_spawn_launch",
        trace_id: traceId ?? null,
        thread_id: threadId,
        agent_type: agentType,
        working_directory: spawnWorkdir,
        command,
        args: commandArgs,
        child_path: this.summarizePath(childEnv.PATH)
      },
      "Launching direct stream agent process"
    );

    const child = this.spawnFn(command, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      cwd: spawnWorkdir
    });

    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error(`Failed to capture stdio for stream agent thread_id=${threadId}`);
    }

    child.stdin.end(prompt);
    return {
      stdout: child.stdout,
      process: child
    };
  }

  async kill(threadId: string): Promise<void> {
    await this.killInternal(threadId, false);
  }

  async interrupt(threadId: string): Promise<string> {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot interrupt; thread_id=${threadId} is not registered`);
    }

    if (instance.mode === "stateless_call") {
      this.log.info(
        {
          operation: "interrupt",
          thread_id: threadId,
          mode: instance.mode,
          pid: instance.pid,
          status: instance.status
        },
        "No active AgentAPI process exists for stateless instance interrupt"
      );
      return `No active stateless run to interrupt for ${threadId}.`;
    }

    const client = this.clientFactory(threadId);
    await client.connect(instance.socket_path);
    try {
      if (!client.sendRawInput) {
        throw new Error("AgentAPI client does not support raw terminal input");
      }
      await client.sendRawInput(INTERRUPT_ESCAPE_SEQUENCE);
    } finally {
      client.disconnect();
    }

    this.log.info(
      {
        operation: "interrupt",
        thread_id: threadId,
        mode: instance.mode,
        socket_path: instance.socket_path,
        pid: instance.pid,
        status: instance.status
      },
      "Sent interrupt to agent instance"
    );

    return `Sent interrupt to ${threadId}.`;
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
      existing.auto_approve,
      existing.reasoning_effort,
      null,
      existing.integration_profile,
      existing.sandbox_mode
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
    const registeredInstance = this.registry.get(threadId);
    if (!registeredInstance) {
      throw new Error(`Cannot list models; thread_id=${threadId} is not registered`);
    }

    let instance = registeredInstance;
    if (!instance.model_id) {
      try {
        instance = (await this.status(threadId)).instance;
      } catch (error) {
        this.log.debug(
          {
            operation: "list_models_status_probe_failed",
            thread_id: threadId,
            socket_path: instance.socket_path,
            pid: instance.pid,
            err: error instanceof Error ? error.message : String(error)
          },
          "Continuing model catalog lookup without a live current-model backfill"
        );
      }
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
    throw new Error(
      `Thread ${threadId} is running in mode=${instance.mode}; terminal_input (${rawInput}) is no longer supported (pane_bridge removed).`
    );
  }

  snapshotState(): PersistedHubState {
    return buildPersistedHubState(
      this.now().toISOString(),
      this.registry.list(),
      Object.fromEntries(this.sessionThreadBySession.entries())
    );
  }

  async rehydrateFromState(state: PersistedHubState): Promise<RehydrationResult> {
    // Allocator counter is intentionally NOT seeded from persisted state.
    // Carrying the historical max across a service restart preserves the
    // running counter even though every original agent process is dead —
    // the user never requested cumulative thread_id numbering, only that
    // *currently-alive* threads keep stable ids. We seed the allocator
    // below from instances that actually rehydrate (registry.list() is
    // also consulted by nextThreadId as a floor), so live ids stay
    // collision-free while purged ids do not extend the counter.
    this.allocatedThreadMaxIndexByType.clear();
    this.registry.clear();
    this.children.clear();
    this.sessionThreadBySession.clear();

    const restoredThreadIds: string[] = [];
    const prunedThreadIds: string[] = [];
    const liveThreadIds = new Set<string>();

    // Probe persisted instances in parallel. Serial probes would multiply
    // the worst-case rehydrate wallclock (n × per-probe timeout) and was
    // a contributing factor to pm2 SIGKILL'ing hub past kill_timeout when
    // many instances were unhealthy after a restart.
    const persistedInstances = state.instances ?? [];
    const rehydrated = await Promise.all(
      persistedInstances.map(async (persistedInstance) => ({
        persisted: persistedInstance,
        hydrated: await this.rehydrateInstance(persistedInstance)
      }))
    );

    for (const { persisted, hydrated } of rehydrated) {
      if (!hydrated) {
        prunedThreadIds.push(persisted.thread_id);
        continue;
      }

      this.registry.register(hydrated);
      this.rememberAllocatedThreadId(hydrated.thread_id, hydrated.agent_type);
      restoredThreadIds.push(hydrated.thread_id);
      liveThreadIds.add(hydrated.thread_id);
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

    // Flush the rehydrated state so the next hub generation reads a
    // post-prune state.json (with the reaped orphans already absent),
    // not the pre-restart snapshot that still references dead PIDs.
    this.notifyStateChange();

    return {
      restored_thread_ids: restoredThreadIds,
      pruned_thread_ids: prunedThreadIds
    };
  }

  async switchModel(
    threadId: string,
    nextModelId: string,
    reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    const existing = this.registry.get(threadId);
    if (!existing) {
      throw new Error(`Cannot switch model; thread_id=${threadId} is not registered`);
    }
    const nextReasoningEffort = reasoningEffort ?? existing.reasoning_effort;

    if (existing.model_id === nextModelId && existing.reasoning_effort === nextReasoningEffort) {
      return threadId;
    }

    const previousStatus = existing.status;
    const previousModelId = existing.model_id ?? null;
    const previousReasoningEffort = existing.reasoning_effort;
    await this.killInternal(threadId, true);
    const restartedThreadId = await this.spawnWithRetry(
      existing.agent_type,
      existing.mode,
      threadId,
      existing.working_dir,
      nextModelId,
      existing.auto_approve,
      nextReasoningEffort,
      null,
      existing.integration_profile,
      existing.sandbox_mode
    );
    const current = this.registry.get(restartedThreadId);

    this.log.info(
      {
        operation: "switch_model",
        thread_id: restartedThreadId,
        agent_type: existing.agent_type,
        from_model_id: previousModelId,
        to_model_id: nextModelId,
        from_reasoning_effort: previousReasoningEffort,
        to_reasoning_effort: nextReasoningEffort,
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

    if (instance.mode === "stateless_call") {
      return {
        instance,
        agent_status: {
          status: instance.status,
          mode: "stateless_call",
          stateless: true,
          current_model_id: instance.model_id ?? null
        }
      };
    }

    const client = this.clientFactory(threadId);
    await client.connect(instance.socket_path);

    try {
      const rawStatus = await client.getStatus();
      const enrichedStatus = await this.enrichRawStatusWithLiveModel(rawStatus, client);
      const updatedInstance = this.applyLiveStatus(threadId, instance, enrichedStatus);

      this.log.debug(
        {
          operation: "status",
          thread_id: threadId,
          pid: updatedInstance.pid,
          socket_path: updatedInstance.socket_path,
          prev_status: instance.status,
          next_status: updatedInstance.status,
          prev_model_id: instance.model_id ?? null,
          next_model_id: updatedInstance.model_id ?? null
        },
        "Agent status fetched"
      );

      return {
        instance: updatedInstance,
        agent_status: enrichedStatus
      };
    } finally {
      client.disconnect();
    }
  }

  list(): AgentInstance[] {
    return this.registry.list();
  }

  describeSpawnInvocation(instance: AgentInstance): SpawnInvocationDescriptor {
    if (instance.mode === "stateless_call") {
      const providerArgs = buildCodexExecArgs(
        instance.model_id,
        false,
        instance.reasoning_effort,
        "read-only"
      );
      return {
        command: providerArgs[0] ?? "codex",
        args: providerArgs,
        provider_args: providerArgs,
        provider_append: this.formatCommand(providerArgs),
        display: this.formatCommand(providerArgs)
      };
    }

    const listenArg = instance.socket_path.startsWith("http://") || instance.socket_path.startsWith("https://")
      ? `--url=${instance.socket_path}`
      : `--socket=${instance.socket_path}`;
    const args = this.buildSpawnArgs(
      instance.agent_type,
      instance.mode,
      listenArg,
      instance.model_id,
      instance.auto_approve,
      instance.reasoning_effort,
      instance.sandbox_mode
    );
    const providerSeparator = args.indexOf("--");
    const providerArgs = providerSeparator >= 0 ? args.slice(providerSeparator + 1) : [];
    const command = this.agentapiBinPath;
    const display = this.formatCommand([command, ...args]);
    return {
      command,
      args,
      provider_args: providerArgs,
      provider_append: this.formatCommand(providerArgs),
      display
    };
  }

  private async spawnWithRetry(
    type: AgentType,
    mode: BridgeMode,
    threadIdOverride?: string,
    workingDirectory?: string,
    modelId?: string,
    autoApprove?: boolean,
    reasoningEffort?: ReasoningEffort,
    spawnTraceId?: string | null,
    integrationProfile?: string,
    sandboxMode?: SandboxMode,
    caller?: CallerIdentity,
    resolvedCredential?: ResolvedCredential | null
  ): Promise<string> {
    let lastError: unknown;
    const reservedThreadId = threadIdOverride ?? this.nextThreadId(type);
    this.rememberAllocatedThreadId(reservedThreadId, type);

    for (let attempt = 1; attempt <= this.spawnAttempts; attempt += 1) {
      try {
        return await this.spawnInternal(
          type,
          mode,
          reservedThreadId,
          workingDirectory,
          modelId,
          autoApprove,
          reasoningEffort,
          spawnTraceId,
          integrationProfile,
          sandboxMode,
          caller,
          resolvedCredential ?? null
        );
      } catch (error) {
        lastError = error;
        if (!this.shouldRetrySpawn(error) || attempt >= this.spawnAttempts) {
          throw error;
        }

        this.log.warn(
          {
            operation: "spawn_retry",
            trace_id: spawnTraceId ?? null,
            thread_id: reservedThreadId,
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
    autoApprove?: boolean,
    reasoningEffort?: ReasoningEffort,
    spawnTraceId?: string | null,
    integrationProfile?: string,
    sandboxMode?: SandboxMode,
    caller?: CallerIdentity,
    resolvedCredential?: ResolvedCredential | null
  ): Promise<string> {
    const threadId = threadIdOverride ?? this.nextThreadId(type);
    const traceId = spawnTraceId ?? null;
    const spawnWorkdir = this.resolveWorkdir(workingDirectory ?? this.agentWorkdir);
    if (mode === "stateless_call") {
      return this.spawnStatelessInstance(
        type,
        threadId,
        spawnWorkdir,
        modelId,
        reasoningEffort,
        traceId,
        integrationProfile,
        sandboxMode,
        caller,
        resolvedCredential ?? null
      );
    }
    if (sandboxMode === "read-only" && type !== "codex" && type !== "claude") {
      throw new Error("Agent type does not support read-only sandbox mode");
    }
    const endpointBinding = await this.resolveAgentEndpointBinding(threadId);
    const socketPath = endpointBinding.endpoint;
    if (endpointBinding.transport === "socket") {
      await this.removeSocketPath(socketPath);
    }
    const args = this.buildSpawnArgs(type, mode, endpointBinding.listenArg, modelId, autoApprove, reasoningEffort, sandboxMode);
    const childEnv = this.buildChildEnv(resolvedCredential ?? null);

    const stdio = this.buildSpawnStdio(threadId);
    this.log.info(
      {
        operation: "spawn_launch",
        trace_id: traceId,
        mode,
        thread_id: threadId,
        socket_path: socketPath,
        working_directory: spawnWorkdir,
        command: this.agentapiBinPath,
        args,
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
        trace_id: traceId,
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
      reasoning_effort: reasoningEffort,
      integration_profile: integrationProfile,
      sandbox_mode: sandboxMode,
      auto_approve: autoApprove,
      supportsStream: this.supportsStreaming(type),
      mode,
      socket_path: socketPath,
      working_dir: spawnWorkdir,
      pid: child.pid,
      status: "idle",
      created_at: this.now().toISOString(),
      restart_safe: true,
      spawn_trace_id: traceId,
      spawned_by: caller,
      credential_id: resolvedCredential?.credential_id ?? null
    };

    this.registry.register(instance);
    if (autoApprove === true) {
      this.registry.setAutoApprove(threadId, true);
    }
    this.children.set(threadId, child);
    this.maybeUnrefChild(child, stdio);
    this.watchChildProcess(threadId, child);
    // Persist now, BEFORE the readiness wait — closes the spawn-then-persist
    // race that leaves a detached agentapi child orphaned across hub restart.
    this.notifyStateChange();
    try {
      await this.assertAgentReady(threadId, socketPath, traceId);
    } catch (error) {
      await this.killInternal(threadId, false).catch(() => undefined);
      throw error;
    }

    this.log.info(
      {
        operation: "spawn",
        trace_id: traceId,
        mode,
        thread_id: threadId,
        pid: child.pid,
        socket_path: socketPath,
        prev_status: null,
        next_status: "idle"
      },
      "Agent instance spawned"
    );

    return threadId;
  }

  private spawnStatelessInstance(
    type: AgentType,
    threadId: string,
    spawnWorkdir: string,
    modelId?: string,
    reasoningEffort?: ReasoningEffort,
    spawnTraceId?: string | null,
    integrationProfile?: string,
    sandboxMode?: SandboxMode,
    caller?: CallerIdentity,
    resolvedCredential?: ResolvedCredential | null
  ): string {
    if (type !== "codex") {
      throw new Error("stateless_call mode is only supported for codex");
    }
    if (sandboxMode && sandboxMode !== "read-only") {
      throw new Error("stateless_call mode requires read-only sandbox mode");
    }

    const instance: AgentInstance = {
      thread_id: threadId,
      agent_type: type,
      model_id: modelId,
      reasoning_effort: reasoningEffort,
      integration_profile: integrationProfile,
      sandbox_mode: "read-only",
      auto_approve: false,
      supportsStream: true,
      mode: "stateless_call",
      socket_path: `${STATELESS_SOCKET_PREFIX}${threadId}`,
      working_dir: spawnWorkdir,
      pid: 0,
      status: "idle",
      created_at: this.now().toISOString(),
      restart_safe: true,
      spawn_trace_id: spawnTraceId ?? null,
      spawned_by: caller,
      credential_id: resolvedCredential?.credential_id ?? null
    };

    this.registry.register(instance);
    this.notifyStateChange();
    this.log.info(
      {
        operation: "spawn",
        trace_id: spawnTraceId ?? null,
        mode: "stateless_call",
        thread_id: threadId,
        working_directory: spawnWorkdir,
        prev_status: null,
        next_status: "idle"
      },
      "Stateless Codex instance registered"
    );

    return threadId;
  }

  private async assertAgentReady(threadId: string, endpoint: string, traceId?: string | null): Promise<void> {
    let lastError: string | null = null;

    for (let attempt = 0; attempt < this.startupAttempts; attempt += 1) {
      const child = this.children.get(threadId);
      if (!child || !this.isChildRunning(child)) {
        const exitCode = child?.exitCode ?? null;
        const signal = child?.signalCode ?? null;
        this.log.warn(
          {
            operation: "readiness_child_not_running",
            trace_id: traceId ?? null,
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
              trace_id: traceId ?? null,
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
    if (instance.mode === "stateless_call") {
      // Stateless calls are ephemeral by definition — the agent process exits
      // as soon as the single Codex/Claude exec completes. A persisted
      // stateless_call entry that survives into a Hub restart describes a
      // process that was alive at the snapshot time but cannot be revived;
      // there is no socket to reattach to and no tmux pane to inherit.
      //
      // Previously this branch unconditionally re-registered the instance
      // with `pid: 0` and the original status, producing zombies that:
      //   - kept showing in `/api/instances` (status !== "stopped" passes
      //     `shouldListInstance`), so dismissed stateless cards revived
      //     immediately on restart
      //   - seeded `nextThreadId`'s `registry.list()` floor, so the thread
      //     allocator counter never actually started fresh after a restart
      //     even with the prior allocator-counter fix.
      //
      // Drop them entirely. Conversation history is a separate persisted
      // field and continues to back the GUI replay on its own.
      this.log.info(
        {
          operation: "rehydrate_drop_stateless",
          thread_id: instance.thread_id,
          socket_path: instance.socket_path,
          pid: instance.pid,
          prev_status: instance.status
        },
        "Dropping persisted stateless_call instance on rehydrate (ephemeral)"
      );
      return null;
    }

    // Fast-path PID liveness check. If the OS has reaped the PID, no probe
    // can succeed and there is no orphan to reap. Clean the leftover socket
    // file and prune. This shortcuts the per-restart storm where stale
    // entries used to consume probe budget and emit confusing "probe failed"
    // warnings for already-dead workers.
    if (!this.pidLivenessFn(instance.pid)) {
      this.log.info(
        {
          operation: "rehydrate_pid_dead_pruned",
          thread_id: instance.thread_id,
          socket_path: instance.socket_path,
          pid: instance.pid,
          prev_status: instance.status
        },
        "Pruning persisted agent instance because PID is no longer alive"
      );
      void this.cleanupOrphanSocket(instance.socket_path);
      return null;
    }

    // PID-alive path: probe with retries. agentapi can take several seconds
    // to be ready after spawn (or after its own pm2-style restart). A single
    // shot at probe time used to permanently prune any instance whose
    // agentapi was mid-boot — the exact mechanism behind §C-2(b) of the
    // architectural learning. Retries make the prune decision evidence-based.
    const client = this.clientFactory(instance.thread_id);
    let lastError: unknown = null;
    try {
      for (let attempt = 1; attempt <= this.rehydrateProbeRetries; attempt += 1) {
        try {
          await client.connect(instance.socket_path);
          const rawStatus = await client.getStatus();
          const enrichedStatus = await this.enrichRawStatusWithLiveModel(rawStatus, client);
          const reportedStatus = this.normalizeAgentapiStatus(enrichedStatus.status);
          const reportedModelId = this.extractReportedModelId(enrichedStatus);
          if (attempt > 1) {
            this.log.info(
              {
                operation: "rehydrate_probe_succeeded_after_retry",
                thread_id: instance.thread_id,
                socket_path: instance.socket_path,
                pid: instance.pid,
                attempt
              },
              "Rehydrate probe succeeded after retry"
            );
          }
          return {
            ...instance,
            status: reportedStatus ?? instance.status,
            ...(reportedModelId ? { model_id: reportedModelId } : {})
          };
        } catch (error) {
          lastError = error;
          if (attempt < this.rehydrateProbeRetries) {
            client.disconnect();
            await new Promise<void>((resolve) => {
              setTimeout(resolve, this.rehydrateProbeRetryDelayMs * attempt);
            });
          }
        }
      }
    } finally {
      client.disconnect();
    }

    // All probe attempts failed but the PID is still alive. This is a true
    // orphan: a process holding a socket that no longer responds to /status.
    // Reap it so it does not (a) remain on the host as a resource leak, and
    // (b) cause the next spawn that reuses this socket path to collide with
    // the dead agentapi's socket file. Reap is fire-and-forget — startup
    // does not block on it.
    this.log.warn(
      {
        operation: "rehydrate_probe_failed",
        thread_id: instance.thread_id,
        socket_path: instance.socket_path,
        pid: instance.pid,
        attempts: this.rehydrateProbeRetries,
        err: lastError instanceof Error ? lastError.message : String(lastError)
      },
      "Skipping persisted agent instance because readiness probe failed; reaping orphan"
    );
    void this.reapRehydrateOrphan(instance);
    return null;
  }

  private async cleanupOrphanSocket(socketPath: string): Promise<void> {
    if (!socketPath || !socketPath.startsWith("/")) {
      return;
    }
    try {
      await fs.promises.unlink(socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      this.log.warn(
        { socket_path: socketPath, err: (error as Error).message },
        "Failed to unlink orphan socket during rehydrate cleanup"
      );
    }
  }

  private async reapRehydrateOrphan(instance: AgentInstance): Promise<void> {
    if (!this.pidLivenessFn(instance.pid)) {
      await this.cleanupOrphanSocket(instance.socket_path);
      return;
    }
    try {
      // SIGTERM first via process kill; escalate to SIGKILL on the process
      // group if it does not exit promptly. agentapi was spawned detached,
      // so its pgid equals its pid — `-pid` reaches the whole subtree.
      try {
        process.kill(instance.pid, "SIGTERM");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          this.log.warn(
            { thread_id: instance.thread_id, pid: instance.pid, err: (error as Error).message },
            "SIGTERM to rehydrate orphan failed"
          );
        }
      }
      await this.waitForPidExit(instance.pid, instance.thread_id, 2_000);
      this.log.info(
        {
          operation: "rehydrate_orphan_reaped",
          thread_id: instance.thread_id,
          pid: instance.pid,
          socket_path: instance.socket_path
        },
        "Rehydrate orphan reaped"
      );
    } finally {
      await this.cleanupOrphanSocket(instance.socket_path);
    }
  }

  private async killInternal(threadId: string, preserveBindings: boolean): Promise<void> {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot kill; thread_id=${threadId} is not registered`);
    }

    if (instance.mode === "stateless_call") {
      this.registry.unregister(threadId);

      if (!preserveBindings) {
        this.clearSessionBindingsForThread(threadId);
      }

      this.notifyStateChange();
      this.log.info(
        {
          operation: "kill",
          trace_id: instance.spawn_trace_id ?? null,
          thread_id: threadId,
          pid: instance.pid,
          socket_path: instance.socket_path,
          prev_status: instance.status,
          next_status: "stopped"
        },
        "Stateless agent instance removed"
      );
      return;
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
      // Wait for the process to actually exit before proceeding with cleanup.
      // This prevents race conditions when a thread is killed then immediately
      // re-spawned — the old process may still hold the socket or pane.
      await this.waitForChildExit(child, threadId);
    } else {
      try {
        process.kill(instance.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
      // For PID-only kills, poll until the process is gone.
      await this.waitForPidExit(instance.pid, threadId);
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
    this.registry.unregister(threadId);

    if (!preserveBindings) {
      this.clearSessionBindingsForThread(threadId);
    }

    this.notifyStateChange();
    this.log.info(
      {
        operation: "kill",
        trace_id: instance.spawn_trace_id ?? null,
        thread_id: threadId,
        pid: instance.pid,
        socket_path: instance.socket_path,
        prev_status: instance.status,
        next_status: "stopped"
      },
      "Agent instance killed"
    );
  }

  /**
   * SIGKILL the process group of a detached child PID. agentapi is spawned
   * with `detached: true` (it is its own process group leader), so a negative
   * pid SIGKILL reaches every descendant — agentapi itself, the codex/claude
   * CLI subprocess it launched, and any tool processes underneath. Without
   * this escalation, a SIGTERM that the PTY wrapper or CLI swallows leaves
   * the worker producing output after kill, while Hub has already
   * unregistered the thread.
   */
  private escalateToSigkill(pid: number, threadId: string): void {
    if (!Number.isInteger(pid) || pid <= 1) {
      return;
    }
    let groupKilled = false;
    try {
      process.kill(-pid, "SIGKILL");
      groupKilled = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") {
        this.log.warn(
          { thread_id: threadId, pid, error: (error as Error).message },
          "Kill escalation: process-group SIGKILL failed"
        );
      }
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        this.log.warn(
          { thread_id: threadId, pid, error: (error as Error).message },
          "Kill escalation: SIGKILL failed"
        );
      }
    }
    this.log.warn(
      { thread_id: threadId, pid, group_killed: groupKilled },
      "Kill escalated to SIGKILL after SIGTERM grace expired"
    );
  }

  /** Wait for a managed child process to exit, escalating to SIGKILL on timeout. */
  private async waitForChildExit(child: ChildProcess, threadId: string, timeoutMs = 10_000): Promise<void> {
    // Do NOT short-circuit on `child.killed`. Node sets it to true as soon as
    // child.kill(sig) successfully *delivers* a signal — it does not indicate
    // the process actually exited. killInternal sends SIGTERM immediately
    // before this wait, so checking child.killed would return instantly every
    // time and the SIGKILL escalation below would never fire.
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });

    if (exited) {
      return;
    }

    if (typeof child.pid === "number") {
      this.escalateToSigkill(child.pid, threadId);
      await this.waitForPidExit(child.pid, threadId, 2_000, /*alreadyEscalated*/ true);
    } else {
      this.log.warn(
        { thread_id: threadId, timeout_ms: timeoutMs },
        "Kill exit wait timed out; child has no pid to escalate"
      );
    }
  }

  /** Poll until a PID is no longer alive; escalate to SIGKILL on timeout. */
  private async waitForPidExit(
    pid: number,
    threadId: string,
    timeoutMs = 10_000,
    alreadyEscalated = false
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 200;
    while (Date.now() < deadline) {
      try {
        // Signal 0 checks if process exists without sending a signal.
        process.kill(pid, 0);
      } catch {
        // Process is gone.
        return;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    if (alreadyEscalated) {
      this.log.warn(
        { thread_id: threadId, pid, timeout_ms: timeoutMs },
        "Kill PID exit wait timed out after SIGKILL; proceeding with cleanup"
      );
      return;
    }
    this.escalateToSigkill(pid, threadId);
    const reapDeadline = Date.now() + 2_000;
    while (Date.now() < reapDeadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    this.log.warn(
      { thread_id: threadId, pid, timeout_ms: timeoutMs },
      "Kill PID exit wait timed out after SIGKILL; proceeding with cleanup"
    );
  }

  private watchChildProcess(threadId: string, child: ChildProcess): void {
    child.once("exit", (code, signal) => {
      this.children.delete(threadId);
      this.releaseAgentLogFd(threadId);

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
          trace_id: instance.spawn_trace_id ?? null,
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
          trace_id: instance.spawn_trace_id ?? null,
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


  private rememberAllocatedThreadId(threadId: string, fallbackType?: AgentType): void {
    const index = this.extractThreadIndex(threadId);
    if (index === null) {
      return;
    }

    const type = fallbackType ?? this.inferAgentTypeFromThreadId(threadId);
    if (!type) {
      return;
    }

    const currentIndex = this.allocatedThreadMaxIndexByType.get(type) ?? 0;
    if (index > currentIndex) {
      this.allocatedThreadMaxIndexByType.set(type, index);
    }
  }

  private inferAgentTypeFromThreadId(threadId: string): AgentType | null {
    const match = /^(.+)_(\d+)$/.exec(threadId);
    const parsed = match ? AgentTypeSchema.safeParse(match[1]) : null;
    return parsed?.success ? parsed.data : null;
  }

  private extractThreadIndex(threadId: string): number | null {
    const match = /^.+_(\d+)$/.exec(threadId);
    const index = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(index) && index > 0 ? index : null;
  }

  private nextThreadId(type: AgentType): string {
    let maxIndex = this.allocatedThreadMaxIndexByType.get(type) ?? 0;
    for (const instance of this.registry.list()) {
      if (instance.agent_type !== type) {
        continue;
      }

      const index = this.extractThreadIndex(instance.thread_id);
      if (index !== null && index > maxIndex) {
        maxIndex = index;
      }
    }
    const nextIndex = maxIndex + 1;
    this.allocatedThreadMaxIndexByType.set(type, nextIndex);
    return `${type}_${String(nextIndex).padStart(2, "0")}`;
  }

  private supportsStreaming(type: AgentType): boolean {
    return type === "claude" || type === "codex" || type === "gemini";
  }

  private buildSpawnArgs(
    type: AgentType,
    mode: BridgeMode,
    listenArg: string,
    modelId?: string,
    autoApprove?: boolean,
    reasoningEffort?: ReasoningEffort,
    sandboxMode?: SandboxMode
  ): string[] {
    if (type === "codex") {
      return buildCodexSpawnArgs(mode, null, listenArg, modelId, autoApprove, reasoningEffort, sandboxMode);
    }
    if (type === "claude") {
      return buildClaudeSpawnArgs(mode, null, listenArg, modelId, autoApprove, reasoningEffort);
    }
    if (type === "gemini") {
      return buildGeminiSpawnArgs(mode, null, listenArg, modelId);
    }
    return buildCursorSpawnArgs(mode, null, listenArg, modelId);
  }

  private formatCommand(args: string[]): string {
    return args.map((arg) => this.shellQuote(arg)).join(" ");
  }

  private shellQuote(arg: string): string {
    if (/^[A-Za-z0-9_./:=@%+,\-"\\]+$/.test(arg)) {
      return arg;
    }
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
  }

  getPaneCaptureIntervalMs(): number {
    return this.paneCaptureIntervalMs;
  }

  setPaneCaptureIntervalMs(intervalMs: number): void {
    const clamped = Math.max(2000, Math.min(30000, Math.floor(intervalMs)));
    this.paneCaptureIntervalMs = clamped;
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

  private buildChildEnv(resolvedCredential?: ResolvedCredential | null): NodeJS.ProcessEnv {
    return buildChildEnvImpl(process.env, resolvedCredential ?? null, this.log);
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

  private normalizeAgentapiStatus(candidate: unknown): AgentInstanceStatus | null {
    if (typeof candidate !== "string") {
      return null;
    }

    const normalized = candidate.trim().toLowerCase();
    if (normalized === "stable" || normalized === "done" || normalized === "completed") {
      return "waiting";
    }

    if (!VALID_INSTANCE_STATUSES.has(normalized as AgentInstanceStatus)) {
      return null;
    }
    return normalized as AgentInstanceStatus;
  }

  private applyLiveStatus(
    threadId: string,
    instance: AgentInstance,
    rawStatus: Record<string, unknown>
  ): AgentInstance {
    let updatedInstance = instance;
    const reportedStatus = this.normalizeAgentapiStatus(rawStatus.status);
    if (reportedStatus && reportedStatus !== updatedInstance.status) {
      updatedInstance = this.registry.setStatus(threadId, reportedStatus) ?? updatedInstance;
    }

    const reportedModelId = this.extractReportedModelId(rawStatus);
    if (reportedModelId && reportedModelId !== updatedInstance.model_id) {
      updatedInstance =
        this.registry.setModelId(threadId, reportedModelId) ??
        {
          ...updatedInstance,
          model_id: reportedModelId
        };
    }

    return updatedInstance;
  }

  private async enrichRawStatusWithLiveModel(
    rawStatus: Record<string, unknown>,
    client: Pick<StatusClient, "getMessages">
  ): Promise<Record<string, unknown>> {
    if (this.extractReportedModelId(rawStatus) || typeof client.getMessages !== "function") {
      return rawStatus;
    }

    try {
      const messages = await client.getMessages();
      const reportedModelId = this.extractReportedModelIdFromMessages(messages);
      if (!reportedModelId) {
        return rawStatus;
      }

      return {
        ...rawStatus,
        current_model_id: reportedModelId
      };
    } catch {
      return rawStatus;
    }
  }

  private extractReportedModelId(rawStatus: Record<string, unknown>): string | null {
    const directModelId = this.readNonEmptyString(rawStatus, [
      "current_model_id",
      "model_id",
      "model",
      "currentModelId",
      "modelId"
    ]);
    if (directModelId) {
      return directModelId;
    }

    const currentModel = rawStatus.current_model;
    if (currentModel && typeof currentModel === "object") {
      return this.readNonEmptyString(currentModel as Record<string, unknown>, ["id", "model_id", "model", "name"]);
    }

    return null;
  }

  private extractReportedModelIdFromMessages(messages: Record<string, unknown>[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const directModelId = this.extractReportedModelId(candidate);
      if (directModelId) {
        return directModelId;
      }

      const nestedMessage = candidate.message;
      if (nestedMessage && typeof nestedMessage === "object") {
        const nestedModelId = this.extractReportedModelId(nestedMessage as Record<string, unknown>);
        if (nestedModelId) {
          return nestedModelId;
        }
      }

      const contentCandidate =
        typeof candidate.content === "string"
          ? candidate.content
          : typeof candidate.message === "string"
            ? candidate.message
            : "";
      const contentModelId = this.extractReportedModelIdFromText(contentCandidate);
      if (contentModelId) {
        return contentModelId;
      }
    }

    return null;
  }

  private extractReportedModelIdFromText(content: string): string | null {
    const normalized = content.replace(/\u00a0/g, " ");
    const labelledMatch = normalized.match(
      /(?:^|\n)\s*[|│]?\s*(?:model|current model)\s*:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)/i
    );
    if (labelledMatch?.[1]) {
      return labelledMatch[1];
    }

    const footerMatches = normalized.matchAll(
      /(?:^|\n)\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(?:low|medium|high|xhigh)\s+[·•]/g
    );
    let footerModelId: string | null = null;
    for (const match of footerMatches) {
      footerModelId = match[1] ?? footerModelId;
    }
    if (footerModelId) {
      return footerModelId;
    }

    const claudeBannerMatch = normalized.match(/(Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)*)\s+[·•]\s+Claude\b/i);
    if (claudeBannerMatch?.[1] && claudeBannerMatch[2]) {
      const family = claudeBannerMatch[1].toLowerCase();
      const version = claudeBannerMatch[2].replace(/\./g, "-");
      return `claude-${family}-${version}`;
    }

    return null;
  }

  private readNonEmptyString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "string") {
        continue;
      }
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }
}

interface BuildChildEnvLogger {
  warn: (obj: Record<string, unknown>, message: string) => void;
}

/**
 * Module-level helper that constructs the child env for a spawned agent process.
 *
 * Exported for unit testing. The class method `InstanceManager.buildChildEnv` is a
 * thin wrapper that supplies `process.env` and the class logger.
 *
 * Semantics:
 * - Always copies `baseEnv`, deletes TMUX, and prepends fnm-aliases bin to PATH
 *   if present on disk (preserves prior behavior).
 * - If `resolvedCredential` is non-null, sets `CODEX_HOME` to its codex_home, and
 *   merges `env_overrides` on top of the ambient env. If an override replaces a
 *   different ambient value, emits a warning-level log line.
 * - When `resolvedCredential` is null, the env is identical to the prior behavior
 *   (no `CODEX_HOME` injection, no override merging).
 */
export function buildChildEnvImpl(
  baseEnv: Record<string, string | undefined>,
  resolvedCredential: ResolvedCredential | null,
  logger?: BuildChildEnvLogger
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.TMUX;
  const home = env.HOME ?? baseEnv.HOME;
  if (home) {
    const fnmAliasBin = path.join(home, ".local", "share", "fnm", "aliases", "default", "bin");
    if (fs.existsSync(fnmAliasBin)) {
      const segments = (env.PATH ?? "")
        .split(path.delimiter)
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (!segments.includes(fnmAliasBin)) {
        segments.unshift(fnmAliasBin);
      }
      env.PATH = segments.join(path.delimiter);
    }
  }
  if (resolvedCredential) {
    env.CODEX_HOME = resolvedCredential.codex_home;
    for (const [k, v] of Object.entries(resolvedCredential.env_overrides)) {
      const ambient = baseEnv[k];
      if (ambient !== undefined && ambient !== v && logger) {
        logger.warn(
          {
            operation: "spawn_env_override",
            env_key: k,
            credential_id: resolvedCredential.credential_id
          },
          `Ambient ${k} replaced by credential ${resolvedCredential.credential_id}`
        );
      }
      env[k] = v;
    }
  }
  return env;
}
