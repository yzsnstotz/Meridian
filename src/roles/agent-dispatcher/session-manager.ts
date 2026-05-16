import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import * as fsSync from "node:fs";

import type { StateStore } from "../../state-store";
import { AppStateSchema, type AppState, type DispatchWorkerState, type DispatchThreadStateV2, type LifecycleStatus } from "../../types";
import { LifecycleStore, hubResultContainsBlockSignal, hubResultContainsFailureSignal, hubResultContainsInlineReport } from "./lifecycle-store";
import {
  outputArtifactsContain,
  outputsExist as outputArtifactsExist
} from "./output-artifacts";
import { killAttachedAgentapiThread, type KillResult } from "./thread-killer";
import { buildMeridianToolArgs, MERIDIAN_TOOL_EXECUTABLE } from "./tool-entrypoint";

const ACTIVE_STATUS = "active";
const AGENT_DISPATCHER_ROLE_TYPE = "agent-dispatcher";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const DISPATCHER_WORKER_ID = "DISPATCHER";
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
  // Injected for tests; defaults to the real killAttachedAgentapiThread.
  killAttachedThread?: (threadId: string) => Promise<KillResult>;
  // Injected for tests; receives a structured summary at the end of each pause
  // kill sweep so test assertions don't have to mock console.
  onPauseKillSummary?: (summary: PauseKillSummary) => void;
  // Called on a paused -> active transition with the role's threadId. The
  // src/index.ts wiring uses this to clear circuit-breaker entries so a
  // post-resume run starts with a fresh counter.
  onResume?: (roleThreadId: string) => void;
}

export interface PauseKillSummary {
  dispatcherId: string;
  killedThreadIds: string[];
  perThreadResults: KillResult[];
  durationMs: number;
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
  private readonly killAttachedThread: (threadId: string) => Promise<KillResult>;
  private readonly onPauseKillSummary: ((summary: PauseKillSummary) => void) | null;
  private readonly onResume: ((roleThreadId: string) => void) | null;

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
    this.killAttachedThread = options.killAttachedThread ?? ((threadId) => killAttachedAgentapiThread(threadId));
    this.onPauseKillSummary = options.onPauseKillSummary ?? null;
    this.onResume = options.onResume ?? null;
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

  setPaused(paused: boolean, options?: { skipPersist?: boolean; skipKill?: boolean }): void {
    const wasPaused = this.paused;
    this.paused = paused;

    // `skipPersist` and `skipKill` are independent gates. The role-internal
    // hydration / status-change path passes skipPersist=true because it owns
    // the outer state write — but it still wants real-pause to kill threads.
    // skipKill=true is reserved for tests and future hydration paths that need
    // to mirror on-disk state into the in-memory flag without side effects.
    const shouldKill = paused && !wasPaused && !options?.skipKill;
    const shouldPersist = !options?.skipPersist;
    const isResume = !paused && wasPaused;

    if (isResume && this.onResume) {
      try {
        this.onResume(this.roleThreadId);
      } catch {
        // Resume hooks are best-effort. Never block resume on a callback error.
      }
    }

    if (!shouldKill && !shouldPersist) {
      return;
    }

    const status = paused ? PAUSED_STATUS : ACTIVE_STATUS;
    const work = async () => {
      await this.pauseStateReady;
      if (shouldKill) {
        // Kill before the status flag write so observers in-flight see the
        // dispatcher as still active during the (brief) kill phase, matching
        // the actual on-host reality at that instant.
        await this.killAttachedThreadsForPause();
      }
      if (shouldPersist) {
        await this.writeRoleStatus(status);
      }
    };

    this.pauseWriteChain = this.pauseWriteChain.then(work, work);
    void this.pauseWriteChain.catch(() => undefined);
  }

  /**
   * Test/wiring seam: await any in-flight pause work (kill phase + status
   * write) chained by setPaused. Returns immediately if nothing is queued.
   * Used by the watchdog wiring to confirm the kill sweep completed before
   * sending the operator alert.
   */
  awaitPendingPauseWork(): Promise<void> {
    return this.pauseWriteChain.catch(() => undefined);
  }

  private async killAttachedThreadsForPause(): Promise<void> {
    const startedAt = Date.now();
    const dispatcherId = this.dispatcherThreadId ?? this.roleThreadId;
    const threadIds = await this.enumerateAttachedThreadIds();
    const perThreadResults: KillResult[] = [];
    for (const threadId of threadIds) {
      try {
        const result = await this.killAttachedThread(threadId);
        perThreadResults.push(result);
      } catch (error) {
        perThreadResults.push({
          threadId,
          pidsKilled: [],
          pidsResistedTerm: [],
          socketsRemoved: [],
          errors: [`kill failed: ${asMessage(error)}`]
        });
      }
    }

    if (this.onPauseKillSummary) {
      this.onPauseKillSummary({
        dispatcherId,
        killedThreadIds: threadIds,
        perThreadResults,
        durationMs: Date.now() - startedAt
      });
    }
  }

  /**
   * Collect every thread_id attached to this dispatcher that may have a live
   * agentapi process: the dispatcher controller, every running worker, and
   * every PM resolver / validator currently in `running` lifecycle state.
   * Silent on errors — pause must never hang because the sidecar JSON is bad.
   */
  private async enumerateAttachedThreadIds(): Promise<string[]> {
    const ids: string[] = [];
    let lifecycleStore: LifecycleStoreLike | null = this.lifecycleStore;
    if (!lifecycleStore && this.dispatchPlanPath) {
      try {
        lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(this.dispatchPlanPath));
      } catch {
        return ids;
      }
    }
    if (!lifecycleStore) {
      // Fall back to the in-memory dispatcher thread id; we have no view into
      // workers without a lifecycle store.
      if (this.dispatcherThreadId) {
        ids.push(this.dispatcherThreadId);
      }
      return uniqueNonEmpty(ids);
    }

    try {
      const state = lifecycleStore.load();
      if (state.dispatcher.thread_id) {
        ids.push(state.dispatcher.thread_id);
      }
      for (const worker of Object.values(state.workers)) {
        if (worker.status === "running" && worker.thread_id) {
          ids.push(worker.thread_id);
        }
      }
    } catch {
      // Sidecar unreadable; fall back to the in-memory dispatcher thread id.
      if (this.dispatcherThreadId) {
        ids.push(this.dispatcherThreadId);
      }
    }
    if (this.dispatcherThreadId) {
      ids.push(this.dispatcherThreadId);
    }

    return uniqueNonEmpty(ids);
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
    delete nextState.workers[DISPATCHER_WORKER_ID];
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
    }

    // After killing threads, reconcile each worker's lifecycle status based on
    // the evidence we already have (hub_result, expected_outputs, plan status).
    // The reconciler watchdog would eventually do this, but waiting for the stale
    // timeout (30 min) leaves workers as "running" with dead threads — causing the
    // new dispatcher hub to see them as blocked, and once they become abandoned
    // they get re-dispatched in an infinite loop.
    //
    // The dispatch plan markdown is read as an additional evidence source. When a
    // worker's plan row already shows ✅ (e.g. because the PR was merged), that
    // takes precedence over missing hub_result — preventing a false "abandoned"
    // that would trigger an infinite re-dispatch loop.
    let workersReconciled = false;
    if (staleWorkersKilled.length > 0) {
      const planWorkerStatuses = readPlanWorkerStatuses(this.dispatchPlanPath);
      const freshState = lifecycleStore.load();
      for (const worker of runningWorkers) {
        const workerState = freshState.workers[worker.worker_id];
        if (!workerState || workerState.status !== "running") {
          continue;
        }

        const planStatus = planWorkerStatuses.get(worker.worker_id) ?? null;
        const resolvedStatus = resolveKilledWorkerStatus(workerState, planStatus);
        if (resolvedStatus !== "running") {
          freshState.workers[worker.worker_id] = {
            ...workerState,
            status: resolvedStatus,
            last_seen_at: new Date().toISOString()
          };
          workersReconciled = true;
        }
      }

      if (dispatcherCleared) {
        freshState.dispatcher = buildPendingDispatcherState();
      }

      if (workersReconciled || dispatcherCleared) {
        lifecycleStore.save(freshState);
      }
    } else if (dispatcherCleared) {
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
      await this.execFile(MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
        "kill",
        "--thread-id",
        threadId
      ]));
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
      command_preamble: previousWorker?.command_preamble ?? null,
      retry_count: previousWorker?.retry_count ?? 0
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

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function asMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Determine the correct lifecycle status for a worker whose thread was killed
 * during restart. Uses the same evidence hierarchy as the reconciler but without
 * querying the (now dead) hub thread.
 *
 * Priority:
 * 1. Fresh output report says BLOCKED → blocked
 * 2. Fresh output report says FAILED → failed
 * 2. Plan markdown shows ✅ or ⛔ SKIPPED → trust external evidence (merged PR, etc.)
 * 3. Expected outputs exist on disk → completed
 * 4. Hub result contains inline report → completed
 * 5. Hub result is success/completed → completed (trust the hub; thread is gone)
 * 6. Hub result is error → failed
 * 7. No hub result → abandoned
 */
function resolveKilledWorkerStatus(worker: DispatchWorkerState, planStatus: string | null): LifecycleStatus {
  if (outputArtifactsContainFailureSignal(worker.expected_outputs, worker.started_at)) {
    if (outputArtifactsContainBlockSignal(worker.expected_outputs, worker.started_at)) {
      return "blocked";
    }

    return "failed";
  }

  // The dispatch plan markdown is the authoritative record when external
  // evidence (e.g. a merged PR) has already confirmed completion. A missing
  // hub_result (due to relay timeout, etc.) must not override this.
  if (planStatus === "✅") {
    return "completed";
  }

  if (planStatus === "⛔ SKIPPED") {
    return "skipped";
  }

  if (expectedOutputsExist(worker.expected_outputs, worker.started_at)) {
    return "completed";
  }

  if (worker.hub_result && hubResultContainsInlineReport(worker.hub_result)) {
    return "completed";
  }

  if (
    worker.hub_result?.status === "success"
    && (!worker.hub_result.run_state || worker.hub_result.run_state === "completed")
  ) {
    return "completed";
  }

  if (worker.hub_result?.status === "error") {
    return "failed";
  }

  if (!worker.hub_result) {
    return "abandoned";
  }

  // Timeout or partial results without output evidence — treat as abandoned
  // so the retry path can recover.
  return "abandoned";
}

/**
 * Read the dispatch plan markdown and extract a map of worker ID → plan status symbol.
 * Returns an empty map if the plan cannot be read.
 */
function readPlanWorkerStatuses(dispatchPlanPath: string | null): Map<string, string> {
  const statuses = new Map<string, string>();
  if (!dispatchPlanPath) {
    return statuses;
  }

  let markdown: string;
  try {
    markdown = fsSync.readFileSync(dispatchPlanPath, "utf8");
  } catch {
    return statuses;
  }

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

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      const workerId = rowCells[workerColumn].trim();
      const status = rowCells[statusColumn].trim();
      if (workerId.length > 0 && status.length > 0) {
        statuses.set(workerId, status);
      }
    }

    break;
  }

  return statuses;
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
