import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { StateStore } from "../../state-store";
import { AppStateSchema, type AppState, type DispatchThreadStateV2 } from "../../types";
import { LifecycleStore } from "./lifecycle-store";

const ACTIVE_STATUS = "active";
const AGENT_DISPATCHER_ROLE_TYPE = "agent-dispatcher";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const MERIDIAN_TOOL_ENTRYPOINT = "src/bin/meridian-tool.ts";
const PAUSED_STATUS = "paused";
const EMPTY_APP_STATE: AppState = {
  roles: [],
  promptStore: {}
};

const WorkerThreadEntrySchema = z.object({
  thread_id: z.string().min(1),
  started_at: z.string().datetime()
});

const DispatchThreadFileSchema = z.object({
  dispatcher_thread_id: z.string().min(1).nullable().optional(),
  workers: z
    .record(z.string(), z.union([z.string().min(1), WorkerThreadEntrySchema]))
    .default({})
});

export type WorkerThreadEntry = z.infer<typeof WorkerThreadEntrySchema>;

export interface DispatchThreadState {
  dispatcher_thread_id: string | null;
  workers: Record<string, WorkerThreadEntry>;
}

export interface RestartResult {
  staleWorkersKilled: string[];
  dispatcherRestarted: boolean;
}

type PersistableStateStore = Pick<StateStore, "load" | "save">;
type LifecycleStoreLike = Pick<
  LifecycleStore,
  "load" | "save" | "recordDispatcher" | "getWorkersInState" | "markAbandoned"
>;

export interface DispatchThreadViewOptions {
  lifecycleStore?: LifecycleStore;
  now?: () => string;
}

export interface SessionManagerOptions {
  dispatchPlanPath?: string;
  stateStore?: PersistableStateStore;
  lifecycleStore?: LifecycleStoreLike;
  execFile?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

const defaultExecFile = (command: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    nodeExecFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });

export class DispatchThreadView {
  readonly dispatchPlanPath: string;

  private readonly lifecycleStore: LifecycleStore;
  private readonly now: () => string;

  constructor(dispatchPlanPath: string, options: DispatchThreadViewOptions = {}) {
    this.dispatchPlanPath = dispatchPlanPath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.lifecycleStore = options.lifecycleStore ?? new LifecycleStore(this.sidecarPath, {
      now: this.now
    });
  }

  get sidecarPath(): string {
    return path.join(path.dirname(this.dispatchPlanPath), DISPATCH_THREADS_FILENAME);
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.sidecarPath);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }

      throw error;
    }
  }

  async recordDispatcher(threadId: string): Promise<void> {
    this.lifecycleStore.recordDispatcher(threadId);
  }

  async clearDispatcher(): Promise<void> {
    const lifecycleState = this.lifecycleStore.load();
    lifecycleState.dispatcher = buildPendingDispatcherState();
    this.lifecycleStore.save(lifecycleState);
  }

  async recordWorker(workerId: string, threadId: string): Promise<void> {
    const state = await this.load();
    state.workers[workerId] = {
      thread_id: threadId,
      started_at: this.now()
    };
    await this.save(state);
  }

  async removeWorker(workerId: string): Promise<void> {
    const state = await this.load();
    delete state.workers[workerId];
    await this.save(state);
  }

  async getAll(): Promise<DispatchThreadState> {
    return this.load();
  }

  async load(): Promise<DispatchThreadState> {
    return toDispatchThreadState(this.lifecycleStore.load());
  }

  async save(state: DispatchThreadState): Promise<void> {
    const normalizedState = normalizeDispatchThreadState(state);
    const previousState = this.lifecycleStore.load();
    this.lifecycleStore.save(mergeDispatchThreadState(previousState, normalizedState));
  }
}

export class SessionManager {
  private readonly roleThreadId: string;
  private readonly stateStore: PersistableStateStore;
  private readonly execFile: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  private lifecycleStore: LifecycleStoreLike | null;
  private dispatchPlanPath: string | null;
  private dispatcherThreadId: string | null = null;
  private paused = false;
  private pauseStateReady: Promise<void>;
  private pauseWriteChain: Promise<void> = Promise.resolve();

  constructor(roleThreadId: string, options: SessionManagerOptions = {}) {
    this.roleThreadId = roleThreadId;
    this.stateStore = options.stateStore ?? {
      load: async () => EMPTY_APP_STATE,
      save: async () => undefined
    };
    this.execFile = options.execFile ?? defaultExecFile;
    this.lifecycleStore = options.lifecycleStore ?? null;
    this.dispatchPlanPath = options.dispatchPlanPath ?? null;
    this.pauseStateReady = this.loadPauseState();
  }

  async initSession(dispatcherThreadId: string, dispatchPlanPath: string): Promise<void> {
    await this.pauseStateReady;
    await this.pauseWriteChain;

    const lifecycleStore = this.getLifecycleStore(dispatchPlanPath);
    lifecycleStore.recordDispatcher(dispatcherThreadId);

    this.dispatcherThreadId = dispatcherThreadId;
    await this.writeRoleStatus(this.paused ? PAUSED_STATUS : ACTIVE_STATUS);
  }

  getDispatcherThreadId(): string | null {
    return this.dispatcherThreadId;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;

    const status = paused ? PAUSED_STATUS : ACTIVE_STATUS;
    const persist = async () => {
      await this.pauseStateReady;
      await this.writeRoleStatus(status);
    };

    this.pauseWriteChain = this.pauseWriteChain.then(persist, persist);
    void this.pauseWriteChain.catch(() => undefined);
  }

  /**
   * Best-effort kill of any Hub dispatcher thread recorded on disk or in memory,
   * reset the lifecycle sidecar dispatcher row to pending, and clear the in-memory thread id.
   * Use before launching a fresh dispatcher Hub session without deactivating the role.
   */
  async prepareFreshDispatcherLaunch(): Promise<void> {
    await this.pauseStateReady;
    await this.pauseWriteChain;

    const lifecycleStore = this.getLifecycleStore();
    const lifecycleState = lifecycleStore.load();
    const diskThreadId = lifecycleState.dispatcher.thread_id?.trim() || null;
    const memoryThreadId = this.dispatcherThreadId?.trim() || null;
    const toKill = [...new Set([diskThreadId, memoryThreadId].filter((id): id is string => Boolean(id)))];
    for (const hubThreadId of toKill) {
      await this.killThread(hubThreadId);
    }

    const nextState = lifecycleStore.load();
    nextState.dispatcher = buildPendingDispatcherState();
    lifecycleStore.save(nextState);
    this.dispatcherThreadId = null;
  }

  async onRestart(): Promise<RestartResult> {
    await this.pauseStateReady;
    await this.pauseWriteChain;

    const lifecycleStore = this.getLifecycleStore();
    const lifecycleState = lifecycleStore.load();
    const runningWorkers = lifecycleStore.getWorkersInState("running");
    const staleWorkersKilled: string[] = [];
    let dispatcherCleared = false;

    if (lifecycleState.dispatcher.thread_id) {
      await this.killThread(lifecycleState.dispatcher.thread_id);
      dispatcherCleared = true;
    }

    for (const worker of runningWorkers) {
      await this.killThread(worker.thread_id);
      staleWorkersKilled.push(worker.worker_id);
      // Do NOT mark abandoned here. The thread is killed, but the worker's true
      // outcome (completed with outputs, genuinely abandoned, etc.) must be
      // determined by the reconciler which checks hub_result, expected outputs,
      // and stale timeout. Blindly stamping "abandoned" would erase workers that
      // actually completed successfully before the restart.
    }

    if (dispatcherCleared) {
      const nextState = lifecycleStore.load();
      nextState.dispatcher = buildPendingDispatcherState();
      lifecycleStore.save(nextState);
    }

    this.dispatcherThreadId = null;

    return {
      staleWorkersKilled,
      dispatcherRestarted: true
    };
  }

  private async loadPauseState(): Promise<void> {
    const state = await this.loadAppState();
    const roleState = state.roles.find((role) => role.threadId === this.roleThreadId);
    this.paused = roleState?.status === PAUSED_STATUS;
  }

  private async loadAppState(): Promise<AppState> {
    return AppStateSchema.parse((await this.stateStore.load()) ?? EMPTY_APP_STATE);
  }

  private async writeRoleStatus(status: string): Promise<void> {
    const state = await this.loadAppState();
    const nextRoles = [...state.roles];
    const existingRoleIndex = nextRoles.findIndex((role) => role.threadId === this.roleThreadId);

    if (existingRoleIndex === -1) {
      nextRoles.push({
        threadId: this.roleThreadId,
        roleType: AGENT_DISPATCHER_ROLE_TYPE,
        status
      });
    } else {
      nextRoles[existingRoleIndex] = {
        ...nextRoles[existingRoleIndex],
        status
      };
    }

    await this.stateStore.save({
      roles: nextRoles,
      promptStore: state.promptStore
    });
  }

  private getLifecycleStore(dispatchPlanPath?: string): LifecycleStoreLike {
    if (dispatchPlanPath) {
      this.dispatchPlanPath = dispatchPlanPath;
    }

    if (!this.lifecycleStore) {
      this.lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(this.requireDispatchPlanPath()));
    }

    if (dispatchPlanPath && this.lifecycleStore instanceof LifecycleStore) {
      const expectedPath = resolveDispatchThreadPath(dispatchPlanPath);
      if (this.lifecycleStore.filePath !== expectedPath) {
        this.lifecycleStore = new LifecycleStore(expectedPath);
      }
    }

    return this.lifecycleStore;
  }

  private requireDispatchPlanPath(): string {
    if (!this.dispatchPlanPath) {
      throw new Error("dispatchPlanPath is required before using SessionManager");
    }

    return this.dispatchPlanPath;
  }

  private async killThread(threadId: string): Promise<void> {
    try {
      await this.execFile("npx", [
        "tsx",
        MERIDIAN_TOOL_ENTRYPOINT,
        "kill",
        "--thread-id",
        threadId
      ]);
    } catch {
      // Restart recovery is best-effort. Continue even if kill fails.
    }
  }
}

export async function readWorkersByStatus(dispatchPlanPath: string, status: string): Promise<string[]> {
  const markdown = await fs.readFile(dispatchPlanPath, "utf8");
  return parseWorkersByStatus(markdown, status);
}

export function parseWorkersByStatus(markdown: string, status: string): string[] {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const statusColumn = headerCells.indexOf("Status");
    const workerColumn = headerCells.indexOf("Worker");
    if (statusColumn === -1 || workerColumn === -1) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    const workers: string[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      if (rowCells[statusColumn] === status) {
        workers.push(rowCells[workerColumn]);
      }
    }

    return workers;
  }

  return [];
}

function normalizeDispatchThreadState(value: unknown): DispatchThreadState {
  const parsed = DispatchThreadFileSchema.parse(value);
  const workers = Object.fromEntries(
    Object.entries(parsed.workers).map(([workerId, entry]) => [
      workerId,
      typeof entry === "string"
        ? {
            thread_id: entry,
            started_at: new Date(0).toISOString()
          }
        : entry
    ])
  );

  return {
    dispatcher_thread_id: parsed.dispatcher_thread_id ?? null,
    workers
  };
}

function createEmptyDispatchThreadState(): DispatchThreadState {
  return {
    dispatcher_thread_id: null,
    workers: {}
  };
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

function toDispatchThreadState(lifecycleState: DispatchThreadStateV2): DispatchThreadState {
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

function mergeDispatchThreadState(
  previousState: DispatchThreadStateV2,
  nextThreadState: DispatchThreadState
): DispatchThreadStateV2 {
  const nextWorkers = Object.fromEntries(
    Object.entries(previousState.workers)
      .filter(([, worker]) => worker.status !== "running")
      .map(([workerId, worker]) => [
        workerId,
        cloneLifecycleWorkerState(worker)
      ])
  );

  Object.entries(nextThreadState.workers).forEach(([workerId, worker]) => {
    const previousWorker = previousState.workers[workerId];
    nextWorkers[workerId] = {
      thread_id: worker.thread_id,
      trace_id: previousWorker?.trace_id ?? null,
      started_at: worker.started_at,
      last_seen_at: previousWorker?.last_seen_at ?? worker.started_at,
      status: "running",
      expected_outputs: [...(previousWorker?.expected_outputs ?? [])],
      hub_result: previousWorker?.hub_result ? cloneHubResult(previousWorker.hub_result) : null,
      command_preamble: previousWorker?.command_preamble ?? null
    };
  });

  return {
    ...previousState,
    dispatcher: nextThreadState.dispatcher_thread_id
      ? {
          thread_id: nextThreadState.dispatcher_thread_id,
          started_at: previousState.dispatcher.thread_id === nextThreadState.dispatcher_thread_id
            ? previousState.dispatcher.started_at
            : new Date().toISOString(),
          status: "running"
        }
      : buildPendingDispatcherState(),
    workers: nextWorkers
  };
}

function buildPendingDispatcherState(): DispatchThreadStateV2["dispatcher"] {
  return {
    thread_id: null,
    started_at: null,
    status: "pending"
  };
}

function cloneLifecycleWorkerState(
  worker: DispatchThreadStateV2["workers"][string]
): DispatchThreadStateV2["workers"][string] {
  return {
    ...worker,
    expected_outputs: [...worker.expected_outputs],
    hub_result: worker.hub_result ? cloneHubResult(worker.hub_result) : null
  };
}

function cloneHubResult(hubResult: NonNullable<DispatchThreadStateV2["workers"][string]["hub_result"]>) {
  return {
    ...hubResult,
    attachments: hubResult.attachments.map((attachment) => ({ ...attachment }))
  };
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }

  const withoutLeadingPipe = trimmed.slice(1);
  const normalized = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return normalized.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
