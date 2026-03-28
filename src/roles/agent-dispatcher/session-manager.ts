import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { StateStore } from "../../state-store";
import { AppStateSchema, type AppState } from "../../types";

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
type FileSystem = Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "unlink" | "readFile">;

export interface ThreadTrackerOptions {
  fileSystem?: FileSystem;
  now?: () => string;
}

export interface SessionManagerOptions {
  dispatchPlanPath?: string;
  stateStore?: PersistableStateStore;
  threadTracker?: ThreadTracker;
  execFile?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

const defaultThreadTrackerFileSystem: FileSystem = fs;

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

export class ThreadTracker {
  readonly dispatchPlanPath: string;

  private readonly fileSystem: FileSystem;
  private readonly now: () => string;

  constructor(dispatchPlanPath: string, options: ThreadTrackerOptions = {}) {
    this.dispatchPlanPath = dispatchPlanPath;
    this.fileSystem = options.fileSystem ?? defaultThreadTrackerFileSystem;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get sidecarPath(): string {
    return path.join(path.dirname(this.dispatchPlanPath), DISPATCH_THREADS_FILENAME);
  }

  async exists(): Promise<boolean> {
    try {
      await this.fileSystem.readFile(this.sidecarPath, "utf8");
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }

      throw error;
    }
  }

  async recordDispatcher(threadId: string): Promise<void> {
    const state = await this.load();
    state.dispatcher_thread_id = threadId;
    await this.save(state);
  }

  async clearDispatcher(): Promise<void> {
    const state = await this.load();
    state.dispatcher_thread_id = null;
    await this.save(state);
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
    try {
      const raw = await this.fileSystem.readFile(this.sidecarPath, "utf8");
      return normalizeDispatchThreadState(JSON.parse(raw));
    } catch (error) {
      if (isMissingFileError(error)) {
        return createEmptyDispatchThreadState();
      }

      throw error;
    }
  }

  async save(state: DispatchThreadState): Promise<void> {
    const normalizedState = normalizeDispatchThreadState(state);
    const sidecarPath = this.sidecarPath;
    const directory = path.dirname(sidecarPath);
    const tempFilePath = `${sidecarPath}.tmp`;
    const payload = `${JSON.stringify(normalizedState, null, 2)}\n`;

    await this.fileSystem.mkdir(directory, { recursive: true });

    try {
      await this.fileSystem.writeFile(tempFilePath, payload, "utf8");
      await this.fileSystem.rename(tempFilePath, sidecarPath);
    } catch (error) {
      await this.fileSystem.unlink(tempFilePath).catch(() => undefined);
      throw error;
    }
  }
}

export class SessionManager {
  private readonly roleThreadId: string;
  private readonly stateStore: PersistableStateStore;
  private readonly execFile: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  private threadTracker: ThreadTracker | null;
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
    this.threadTracker = options.threadTracker ?? null;
    this.dispatchPlanPath = options.threadTracker?.dispatchPlanPath ?? options.dispatchPlanPath ?? null;
    this.pauseStateReady = this.loadPauseState();
  }

  async initSession(dispatcherThreadId: string, dispatchPlanPath: string): Promise<void> {
    await this.pauseStateReady;
    await this.pauseWriteChain;

    const tracker = this.getThreadTracker(dispatchPlanPath);
    await tracker.recordDispatcher(dispatcherThreadId);

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

  async onRestart(): Promise<RestartResult> {
    await this.pauseStateReady;
    await this.pauseWriteChain;

    const tracker = this.getThreadTracker();
    const hadSidecar = await tracker.exists();
    const threadState = await tracker.load();
    const inProgressWorkers = await readWorkersByStatus(this.requireDispatchPlanPath(), "🔄");
    const staleWorkersKilled: string[] = [];
    let sidecarChanged = false;

    if (threadState.dispatcher_thread_id) {
      await this.killThread(threadState.dispatcher_thread_id);
      threadState.dispatcher_thread_id = null;
      sidecarChanged = true;
    }

    for (const workerId of inProgressWorkers) {
      const workerEntry = threadState.workers[workerId];
      if (!workerEntry) {
        continue;
      }

      await this.killThread(workerEntry.thread_id);
      delete threadState.workers[workerId];
      staleWorkersKilled.push(workerId);
      sidecarChanged = true;
    }

    if (hadSidecar && sidecarChanged) {
      await tracker.save(threadState);
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

  private getThreadTracker(dispatchPlanPath?: string): ThreadTracker {
    if (dispatchPlanPath) {
      this.dispatchPlanPath = dispatchPlanPath;
    }

    if (!this.threadTracker) {
      this.threadTracker = new ThreadTracker(this.requireDispatchPlanPath());
      return this.threadTracker;
    }

    if (dispatchPlanPath && this.threadTracker.dispatchPlanPath !== dispatchPlanPath) {
      this.threadTracker = new ThreadTracker(dispatchPlanPath);
    }

    return this.threadTracker;
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
