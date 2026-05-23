import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const GITIGNORE_CONTENT = [
  "*",
  "!/.gitignore",
  "!/structured/",
  "!/structured/**",
  "!/turns/",
  "!/turns/**",
  "",
  "# Durable memory excludes",
  "**/.cache/**",
  "**/cache/**",
  "**/tmp/**",
  "**/*.tmp",
  "**/*.zip",
  "**/*.tar",
  "**/*.tar.gz",
  "**/*.tgz",
  "**/*.gz",
  "**/*.docx",
  "**/*.pdf",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.mp3",
  "**/*.mp4",
  "**/*.mov",
  "**/*.wav",
  "**/*.bin",
  "**/*.sqlite",
  "**/*.db",
  ""
].join("\n");

export type MumuMemoryGitEventKind =
  | "structured_write"
  | "structured_delete"
  | "turn_write"
  | "direct_write"
  | "restore_write";

export type MumuMemoryGitEventSource = "chatter" | "ads_direct" | "restore";

export interface MumuMemoryGitSyncEvent {
  memoryRoot: string;
  userId: string;
  eventKind: MumuMemoryGitEventKind;
  source: MumuMemoryGitEventSource;
  recordType?: string;
  key?: string;
}

export interface MumuMemoryGitArchiveMetadata {
  repo_size_bytes: number;
  largest_tracked_file_bytes: number;
  turn_log_bytes_total: number;
  large_file_excluded_count: number;
}

export interface MumuMemoryGitCommitResult {
  memoryRoot: string;
  committed: boolean;
  commitSha: string | null;
  metadata: MumuMemoryGitArchiveMetadata;
}

export interface MumuMemoryGitSyncQueueLike {
  enqueue(event: MumuMemoryGitSyncEvent): void;
}

export interface MumuMemoryGitSyncQueueOptions {
  debounceMs?: number;
  maxFileBytes?: number;
}

interface QueueState {
  events: MumuMemoryGitSyncEvent[];
  timer: NodeJS.Timeout | null;
  running: Promise<MumuMemoryGitCommitResult | null> | null;
  lastResult: MumuMemoryGitCommitResult | null;
}

export class MumuMemoryGitSyncQueue implements MumuMemoryGitSyncQueueLike {
  private readonly debounceMs: number;
  private readonly maxFileBytes: number;
  private readonly roots = new Map<string, QueueState>();

  constructor(options: MumuMemoryGitSyncQueueOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  enqueue(event: MumuMemoryGitSyncEvent): void {
    const memoryRoot = path.resolve(event.memoryRoot);
    const state = this.getState(memoryRoot);
    state.events.push({ ...event, memoryRoot });
    this.schedule(memoryRoot, state);
  }

  async flush(memoryRoot: string): Promise<MumuMemoryGitCommitResult | null> {
    const resolvedRoot = path.resolve(memoryRoot);
    const state = this.getState(resolvedRoot);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (state.running) {
      await state.running;
    }

    if (state.events.length === 0) {
      return state.lastResult;
    }

    const events = state.events.splice(0);
    const run = this.commitMemoryRoot(resolvedRoot, events);
    state.running = run;
    try {
      const result = await run;
      state.lastResult = result;
      return result;
    } finally {
      state.running = null;
      if (state.events.length > 0) {
        this.schedule(resolvedRoot, state);
      }
    }
  }

  snapshotLastResult(memoryRoot: string): MumuMemoryGitCommitResult | null {
    return this.roots.get(path.resolve(memoryRoot))?.lastResult ?? null;
  }

  private getState(memoryRoot: string): QueueState {
    const existing = this.roots.get(memoryRoot);
    if (existing) {
      return existing;
    }
    const state: QueueState = {
      events: [],
      timer: null,
      running: null,
      lastResult: null
    };
    this.roots.set(memoryRoot, state);
    return state;
  }

  private schedule(memoryRoot: string, state: QueueState): void {
    if (state.timer || state.running) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flush(memoryRoot).catch(() => undefined);
    }, this.debounceMs);
    state.timer.unref?.();
  }

  private async commitMemoryRoot(
    memoryRoot: string,
    events: MumuMemoryGitSyncEvent[]
  ): Promise<MumuMemoryGitCommitResult> {
    await fs.mkdir(memoryRoot, { recursive: true });
    await ensureGitRepository(memoryRoot);
    await ensureGitignore(memoryRoot);

    await git(memoryRoot, ["add", "-A"]);
    const largeFileExcludedCount = await applyArchiveGuard(memoryRoot, this.maxFileBytes);
    const metadataBeforeCommit = await collectArchiveMetadata(memoryRoot, largeFileExcludedCount);

    if (await isIndexClean(memoryRoot)) {
      return {
        memoryRoot,
        committed: false,
        commitSha: await readHeadSha(memoryRoot),
        metadata: metadataBeforeCommit
      };
    }

    await git(memoryRoot, ["commit", "-m", commitMessageForEvents(events)]);
    return {
      memoryRoot,
      committed: true,
      commitSha: await readHeadSha(memoryRoot),
      metadata: await collectArchiveMetadata(memoryRoot, largeFileExcludedCount)
    };
  }
}

let defaultQueue: MumuMemoryGitSyncQueue | null = null;

export function getDefaultMumuMemoryGitSyncQueue(): MumuMemoryGitSyncQueue {
  defaultQueue ??= new MumuMemoryGitSyncQueue();
  return defaultQueue;
}

export function isMumuUserMemoryRoot(memoryRoot: string): boolean {
  const normalized = path.resolve(memoryRoot).split(path.sep).join("/");
  return /\/data\/mumu\/users\/[^/]+$/u.test(normalized);
}

async function ensureGitRepository(memoryRoot: string): Promise<void> {
  if (!existsSync(path.join(memoryRoot, ".git"))) {
    try {
      await git(memoryRoot, ["init", "-b", "main"]);
    } catch {
      await git(memoryRoot, ["init"]);
      await git(memoryRoot, ["checkout", "-B", "main"]);
    }
  }
  await git(memoryRoot, ["config", "user.name", "Mumu Memory Archive"]);
  await git(memoryRoot, ["config", "user.email", "mumu-memory-archive@meridian.local"]);
  await git(memoryRoot, ["config", "commit.gpgsign", "false"]);
}

async function ensureGitignore(memoryRoot: string): Promise<void> {
  const gitignorePath = path.join(memoryRoot, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // Created below.
  }
  if (existing !== GITIGNORE_CONTENT) {
    await fs.writeFile(gitignorePath, GITIGNORE_CONTENT, "utf8");
  }
}

async function applyArchiveGuard(memoryRoot: string, maxFileBytes: number): Promise<number> {
  const staged = await listStagedPaths(memoryRoot);
  let excluded = 0;
  for (const relativePath of staged) {
    const verdict = await shouldTrackPath(memoryRoot, relativePath, maxFileBytes);
    if (!verdict.track) {
      if (verdict.large) {
        excluded += 1;
      }
      await git(memoryRoot, ["rm", "--cached", "--ignore-unmatch", "--", relativePath]);
    }
  }
  return excluded;
}

async function shouldTrackPath(
  memoryRoot: string,
  relativePath: string,
  maxFileBytes: number
): Promise<{ track: boolean; large: boolean }> {
  if (relativePath === ".gitignore") {
    return { track: true, large: false };
  }
  if (!isDurableRelativePath(relativePath) || isGeneratedOrBinaryPath(relativePath)) {
    return { track: false, large: false };
  }

  const absolutePath = path.join(memoryRoot, relativePath);
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    return { track: true, large: false };
  }
  if (!stat.isFile()) {
    return { track: false, large: false };
  }
  if (stat.size > maxFileBytes) {
    return { track: false, large: true };
  }
  if (await looksBinary(absolutePath)) {
    return { track: false, large: false };
  }
  return { track: true, large: false };
}

function isDurableRelativePath(relativePath: string): boolean {
  return relativePath.startsWith("structured/") || relativePath.startsWith("turns/");
}

function isGeneratedOrBinaryPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => part === ".cache" || part === "cache" || part === "tmp")) {
    return true;
  }
  const lower = relativePath.toLowerCase();
  return /\.(zip|tar|tar\.gz|tgz|gz|docx|pdf|png|jpe?g|gif|mp3|mp4|mov|wav|bin|sqlite|db)$/u.test(lower);
}

async function looksBinary(absolutePath: string): Promise<boolean> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function listStagedPaths(memoryRoot: string): Promise<string[]> {
  const { stdout } = await git(memoryRoot, ["diff", "--cached", "--name-only", "-z"]);
  return stdout.split("\0").filter(Boolean);
}

async function isIndexClean(memoryRoot: string): Promise<boolean> {
  try {
    await git(memoryRoot, ["diff", "--cached", "--quiet"]);
    return true;
  } catch {
    return false;
  }
}

async function readHeadSha(memoryRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(memoryRoot, ["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function collectArchiveMetadata(
  memoryRoot: string,
  largeFileExcludedCount: number
): Promise<MumuMemoryGitArchiveMetadata> {
  const tracked = await listTrackedPaths(memoryRoot);
  let largest = 0;
  let turnLogBytes = 0;
  for (const relativePath of tracked) {
    const absolutePath = path.join(memoryRoot, relativePath);
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    largest = Math.max(largest, stat.size);
    if (relativePath.startsWith("turns/")) {
      turnLogBytes += stat.size;
    }
  }

  return {
    repo_size_bytes: await directorySize(path.join(memoryRoot, ".git")),
    largest_tracked_file_bytes: largest,
    turn_log_bytes_total: turnLogBytes,
    large_file_excluded_count: largeFileExcludedCount
  };
}

async function listTrackedPaths(memoryRoot: string): Promise<string[]> {
  try {
    const { stdout } = await git(memoryRoot, ["ls-files", "-z"]);
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (entry.isFile()) {
      total += (await fs.stat(fullPath)).size;
    }
  }
  return total;
}

function commitMessageForEvents(events: MumuMemoryGitSyncEvent[]): string {
  const kinds = new Set(events.map((event) => event.eventKind));
  if (kinds.size === 1) {
    switch (events[0]?.eventKind) {
      case "structured_write":
        return "mumu memory structured write";
      case "structured_delete":
        return "mumu memory structured delete";
      case "turn_write":
        return "mumu memory turn write";
      case "direct_write":
        return "mumu memory direct write";
      case "restore_write":
        return "mumu memory restore write";
    }
  }
  return "mumu memory update";
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  }) as Promise<{ stdout: string; stderr: string }>;
}
