import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { buildClaudeSpawnArgs } from "../agents/claude";
import { buildCodexSpawnArgs } from "../agents/codex";
import { createLogger } from "../logger";
import { AgentAPIClient } from "../shared/agentapi-client";
import type { AgentInstance, AgentInstanceStatus, AgentType, BridgeMode } from "../types";
import { InstanceRegistry } from "./registry";

type SpawnFn = typeof spawn;
type ExecSyncFn = typeof execSync;

interface StatusClient {
  connect: (socketPath: string) => Promise<void>;
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

export interface InstanceManagerOptions {
  agentapiBinPath?: string;
  logDir?: string;
  spawnFn?: SpawnFn;
  execSyncFn?: ExecSyncFn;
  clientFactory?: (threadId: string) => StatusClient;
  now?: () => Date;
}

const SESSION_THREAD_PLACEHOLDERS = new Set(["active", "all", "global", "pending", "unbound", "none"]);
const AGENT_COMMAND_BY_TYPE: Record<AgentType, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor-agent"
};
const VALID_INSTANCE_STATUSES = new Set<AgentInstanceStatus>([
  "idle",
  "running",
  "waiting",
  "stopped",
  "error"
]);
const DEFAULT_NODE_ENV = process.env.NODE_ENV ?? "development";
const DEFAULT_LOG_DIR = process.env.LOG_DIR ?? "/var/log/hub";

export class InstanceManager {
  private readonly log = createLogger("instance_mgr");
  private readonly agentapiBinPath: string;
  private readonly logDir: string;
  private readonly spawnFn: SpawnFn;
  private readonly execSyncFn: ExecSyncFn;
  private readonly clientFactory: (threadId: string) => StatusClient;
  private readonly now: () => Date;
  private readonly children = new Map<string, ChildProcess>();
  private readonly agentLogFdByThread = new Map<string, number>();
  private readonly sessionThreadBySession = new Map<string, string>();

  constructor(
    private readonly registry: InstanceRegistry,
    options: InstanceManagerOptions = {}
  ) {
    this.agentapiBinPath = options.agentapiBinPath ?? path.resolve(process.cwd(), "bin/agentapi");
    this.logDir = options.logDir ?? DEFAULT_LOG_DIR;
    this.spawnFn = options.spawnFn ?? spawn;
    this.execSyncFn = options.execSyncFn ?? execSync;
    this.clientFactory =
      options.clientFactory ??
      ((threadId: string) => {
        return new AgentAPIClient({ threadId });
      });
    this.now = options.now ?? (() => new Date());
  }

  async spawn(type: AgentType, mode: BridgeMode): Promise<string> {
    return await this.spawnInternal(type, mode);
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
    return previous;
  }

  getAttachedThread(session: string): string | null {
    const normalized = session.trim();
    if (!normalized) {
      return null;
    }
    return this.sessionThreadBySession.get(normalized) ?? null;
  }

  async restart(threadId: string): Promise<string> {
    const existing = this.registry.get(threadId);
    if (!existing) {
      throw new Error(`Cannot restart; thread_id=${threadId} is not registered`);
    }

    const previousStatus = existing.status;
    await this.killInternal(threadId, true);
    const restartedThreadId = await this.spawnInternal(existing.agent_type, existing.mode, threadId);
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

  private async spawnInternal(type: AgentType, mode: BridgeMode, threadIdOverride?: string): Promise<string> {
    const threadId = threadIdOverride ?? this.nextThreadId(type);
    const socketPath = `/tmp/agentapi-${threadId}.sock`;
    const tmuxSession = mode === "pane_bridge" ? `agent_${threadId}` : null;
    const args = this.buildSpawnArgs(type, mode, tmuxSession);

    await fs.promises.unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });

    if (tmuxSession) {
      this.execSyncFn(`tmux new-session -d -s ${tmuxSession}`, {
        stdio: "ignore"
      });
    }

    const stdio = this.buildSpawnStdio(threadId);
    const child = this.spawnFn(this.agentapiBinPath, args, {
      detached: false,
      stdio,
      env: {
        ...process.env,
        AGENTAPI_SOCKET_PATH: socketPath
      }
    });

    if (!child.pid) {
      throw new Error(`Failed to spawn agentapi process for thread_id=${threadId}`);
    }

    const instance: AgentInstance = {
      thread_id: threadId,
      agent_type: type,
      mode,
      socket_path: socketPath,
      pid: child.pid,
      tmux_pane: tmuxSession,
      status: "idle",
      created_at: this.now().toISOString()
    };

    this.registry.register(instance);
    this.children.set(threadId, child);
    this.watchChildProcess(threadId, child);

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

  private async killInternal(threadId: string, preserveBindings: boolean): Promise<void> {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`Cannot kill; thread_id=${threadId} is not registered`);
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

    await fs.promises.unlink(instance.socket_path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });

    this.children.delete(threadId);
    this.releaseAgentLogFd(threadId);
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

      const instance = this.registry.get(threadId);
      if (!instance) {
        return;
      }

      const nextStatus: AgentInstanceStatus = code === 0 || signal === "SIGTERM" ? "stopped" : "error";
      this.registry.setStatus(threadId, nextStatus);

      this.log.warn(
        {
          operation: "process_exit",
          thread_id: threadId,
          pid: instance.pid,
          socket_path: instance.socket_path,
          exit_code: code,
          signal,
          prev_status: instance.status,
          next_status: nextStatus
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

  private buildSpawnArgs(type: AgentType, mode: BridgeMode, tmuxSession: string | null): string[] {
    if (type === "codex") {
      return buildCodexSpawnArgs(mode, tmuxSession);
    }
    if (type === "claude") {
      return buildClaudeSpawnArgs(mode, tmuxSession);
    }

    const args = ["server", `--type=${type}`];
    if (mode === "pane_bridge" && tmuxSession) {
      args.push(`--tmux-session=${tmuxSession}`);
    }
    args.push("--", AGENT_COMMAND_BY_TYPE[type]);
    return args;
  }

  private buildSpawnStdio(threadId: string): "inherit" | ["ignore", number, number] {
    if (DEFAULT_NODE_ENV !== "production") {
      return "inherit";
    }

    fs.mkdirSync(this.logDir, { recursive: true });
    const agentLogPath = path.join(this.logDir, `agentapi-${threadId}.log`);
    const fd = fs.openSync(agentLogPath, "a");
    this.agentLogFdByThread.set(threadId, fd);
    return ["ignore", fd, fd];
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
