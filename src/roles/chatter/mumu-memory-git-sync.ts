import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_PUSH_RETRY_DELAYS_MS = [250, 1_000] as const;
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
  remoteArchive?: MumuMemoryRemoteArchive;
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
  remote?: MumuMemoryGitRemotePushResult;
}

export interface MumuMemoryGitSyncQueueLike {
  enqueue(event: MumuMemoryGitSyncEvent): void;
}

export interface MumuMemoryGitSyncQueueOptions {
  debounceMs?: number;
  maxFileBytes?: number;
  serviceGithubToken?: string;
  fetchImpl?: typeof fetch;
  gitPush?: MumuMemoryGitPushFunction;
  statusReporter?: MumuMemoryGitStatusReporter;
  pushRetryDelaysMs?: readonly number[];
}

export type MumuMemoryRemoteArchiveState = "ready" | "blocked" | "disabled";

export interface MumuMemoryRemoteArchive {
  push_enabled: boolean;
  state: MumuMemoryRemoteArchiveState;
  owner: string;
  repo_name: string;
  repo_full_name: string;
  private: boolean | null;
  status_callback_url?: string;
}

export type MumuMemoryGitRemoteStatus =
  | "skipped"
  | "pushed"
  | "blocked"
  | "conflict_pending"
  | "failed";

export interface MumuMemoryGitRemotePushResult {
  status: MumuMemoryGitRemoteStatus;
  repoFullName: string;
  lastPushedCommit: string | null;
  lastErrorClass: string | null;
  blockedReason: string | null;
}

export interface MumuMemoryGitPushRequest {
  memoryRoot: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  commitSha: string;
  refspecs: string[];
}

export interface MumuMemoryGitPushOutcome {
  ok: boolean;
  errorClass?: string;
  conflict?: boolean;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export type MumuMemoryGitPushFunction = (request: MumuMemoryGitPushRequest) => Promise<MumuMemoryGitPushOutcome>;

export interface MumuMemoryGitRemoteStatusUpdate {
  userId: string;
  repoFullName: string;
  status: MumuMemoryGitRemoteStatus;
  lastPushedCommit: string | null;
  lastErrorClass: string | null;
  remoteBlockedReason: string | null;
}

export type MumuMemoryGitStatusReporter = (status: MumuMemoryGitRemoteStatusUpdate) => Promise<void>;

interface QueueState {
  events: MumuMemoryGitSyncEvent[];
  timer: NodeJS.Timeout | null;
  running: Promise<MumuMemoryGitCommitResult | null> | null;
  lastResult: MumuMemoryGitCommitResult | null;
}

export class MumuMemoryGitSyncQueue implements MumuMemoryGitSyncQueueLike {
  private readonly debounceMs: number;
  private readonly maxFileBytes: number;
  private readonly serviceGithubToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly gitPush?: MumuMemoryGitPushFunction;
  private readonly statusReporter?: MumuMemoryGitStatusReporter;
  private readonly pushRetryDelaysMs: readonly number[];
  private readonly roots = new Map<string, QueueState>();

  constructor(options: MumuMemoryGitSyncQueueOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.serviceGithubToken = options.serviceGithubToken ?? process.env.MUMU_SERVICE_GITHUB_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gitPush = options.gitPush;
    this.statusReporter = options.statusReporter;
    this.pushRetryDelaysMs = options.pushRetryDelaysMs ?? DEFAULT_PUSH_RETRY_DELAYS_MS;
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
      const result = {
        memoryRoot,
        committed: false,
        commitSha: await readHeadSha(memoryRoot),
        metadata: metadataBeforeCommit
      };
      return this.withRemotePush(memoryRoot, events, result);
    }

    await git(memoryRoot, ["commit", "-m", commitMessageForEvents(events)]);
    const result = {
      memoryRoot,
      committed: true,
      commitSha: await readHeadSha(memoryRoot),
      metadata: await collectArchiveMetadata(memoryRoot, largeFileExcludedCount)
    };
    return this.withRemotePush(memoryRoot, events, result);
  }

  private async withRemotePush(
    memoryRoot: string,
    events: MumuMemoryGitSyncEvent[],
    result: Omit<MumuMemoryGitCommitResult, "remote">
  ): Promise<MumuMemoryGitCommitResult> {
    const remoteArchive = latestRemoteArchive(events);
    if (!remoteArchive) {
      return result;
    }

    const remote = await this.pushRemoteArchive(
      memoryRoot,
      events[events.length - 1]?.userId ?? "",
      result,
      remoteArchive
    );
    return { ...result, remote };
  }

  private async pushRemoteArchive(
    memoryRoot: string,
    userId: string,
    result: Omit<MumuMemoryGitCommitResult, "remote">,
    remoteArchive: MumuMemoryRemoteArchive
  ): Promise<MumuMemoryGitRemotePushResult> {
    const blocked = (
      blockedReason: string,
      lastErrorClass: string | null = blockedReason
    ): MumuMemoryGitRemotePushResult => ({
      status: "blocked",
      repoFullName: remoteArchive.repo_full_name,
      lastPushedCommit: null,
      lastErrorClass,
      blockedReason
    });
    const failed = (lastErrorClass: string): MumuMemoryGitRemotePushResult => ({
      status: "failed",
      repoFullName: remoteArchive.repo_full_name,
      lastPushedCommit: null,
      lastErrorClass,
      blockedReason: null
    });

    let remoteResult: MumuMemoryGitRemotePushResult;
    if (!remoteArchive.push_enabled) {
      remoteResult = {
        status: "skipped",
        repoFullName: remoteArchive.repo_full_name,
        lastPushedCommit: null,
        lastErrorClass: null,
        blockedReason: "push_disabled"
      };
    } else if (remoteArchive.state !== "ready") {
      remoteResult = blocked("not_ready");
    } else if (remoteArchive.private === false) {
      remoteResult = blocked("public_repo");
    } else if (!result.commitSha) {
      remoteResult = blocked("missing_local_commit");
    } else if (await hasBlockedLfsPolicy(memoryRoot)) {
      remoteResult = blocked("blocked_lfs_policy");
    } else if (!this.serviceGithubToken) {
      remoteResult = blocked("missing_service_token");
    } else {
      const verified = await this.verifyRemotePrivate(remoteArchive, this.serviceGithubToken);
      if (!verified.ok) {
        remoteResult = verified.status === "blocked"
          ? blocked(verified.blockedReason, verified.lastErrorClass ?? verified.blockedReason)
          : failed(verified.lastErrorClass);
      } else {
        remoteResult = await this.pushVerifiedRemote(memoryRoot, result.commitSha, remoteArchive, this.serviceGithubToken);
      }
    }

    await this.reportRemoteStatus(userId, remoteArchive, remoteResult);
    return remoteResult;
  }

  private async verifyRemotePrivate(
    remoteArchive: MumuMemoryRemoteArchive,
    serviceGithubToken: string
  ): Promise<
    | { ok: true }
    | { ok: false; status: "blocked"; blockedReason: string; lastErrorClass?: string }
    | { ok: false; status: "failed"; lastErrorClass: string }
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(remoteArchive.owner)}/${encodeURIComponent(remoteArchive.repo_name)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${serviceGithubToken}`
          }
        }
      );
    } catch {
      return { ok: false, status: "failed", lastErrorClass: "github_repo_verify_failed" };
    }

    if (response.status === 404) {
      return { ok: false, status: "blocked", blockedReason: "missing_repo" };
    }
    if (!response.ok) {
      return { ok: false, status: "failed", lastErrorClass: "github_repo_verify_failed" };
    }

    const body = await parseJsonResponse(response);
    const repoPrivate = typeof body.private === "boolean" ? body.private : null;
    const fullName = typeof body.full_name === "string" ? body.full_name : null;
    if (repoPrivate !== true) {
      return { ok: false, status: "blocked", blockedReason: "public_repo" };
    }
    if (fullName && fullName !== remoteArchive.repo_full_name) {
      return { ok: false, status: "blocked", blockedReason: "repo_mismatch" };
    }
    return { ok: true };
  }

  private async pushVerifiedRemote(
    memoryRoot: string,
    commitSha: string,
    remoteArchive: MumuMemoryRemoteArchive,
    serviceGithubToken: string
  ): Promise<MumuMemoryGitRemotePushResult> {
    const request: MumuMemoryGitPushRequest = {
      memoryRoot,
      owner: remoteArchive.owner,
      repoName: remoteArchive.repo_name,
      repoFullName: remoteArchive.repo_full_name,
      commitSha,
      refspecs: await listRemotePushRefspecs(memoryRoot)
    };
    let lastOutcome: MumuMemoryGitPushOutcome | null = null;
    for (let attempt = 0; attempt <= this.pushRetryDelaysMs.length; attempt += 1) {
      lastOutcome = this.gitPush
        ? await this.gitPush(request)
        : await defaultGitPush(request, serviceGithubToken);
      if (lastOutcome.ok) {
        return {
          status: "pushed",
          repoFullName: remoteArchive.repo_full_name,
          lastPushedCommit: commitSha,
          lastErrorClass: null,
          blockedReason: null
        };
      }
      if (lastOutcome.conflict || classifyPushFailure(lastOutcome) === "conflict_pending") {
        break;
      }
      const delayMs = this.pushRetryDelaysMs[attempt];
      if (delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const postFailureVerification = await this.verifyRemotePrivate(remoteArchive, serviceGithubToken);
    if (!postFailureVerification.ok && postFailureVerification.status === "blocked") {
      return {
        status: "blocked",
        repoFullName: remoteArchive.repo_full_name,
        lastPushedCommit: null,
        lastErrorClass: postFailureVerification.lastErrorClass ?? postFailureVerification.blockedReason,
        blockedReason: postFailureVerification.blockedReason
      };
    }

    const errorClass = classifyPushFailure(lastOutcome);
    return {
      status: errorClass === "conflict_pending" ? "conflict_pending" : "failed",
      repoFullName: remoteArchive.repo_full_name,
      lastPushedCommit: null,
      lastErrorClass: errorClass,
      blockedReason: null
    };
  }

  private async reportRemoteStatus(
    userId: string,
    remoteArchive: MumuMemoryRemoteArchive,
    result: MumuMemoryGitRemotePushResult
  ): Promise<void> {
    const update: MumuMemoryGitRemoteStatusUpdate = {
      userId,
      repoFullName: remoteArchive.repo_full_name,
      status: result.status,
      lastPushedCommit: result.lastPushedCommit,
      lastErrorClass: result.lastErrorClass,
      remoteBlockedReason: result.blockedReason
    };
    if (this.statusReporter) {
      await this.statusReporter(update);
      return;
    }
    if (!remoteArchive.status_callback_url || !isLoopbackHttpUrl(remoteArchive.status_callback_url)) {
      return;
    }
    try {
      await this.fetchImpl(remoteArchive.status_callback_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: update.status,
          repo_full_name: update.repoFullName,
          last_pushed_commit: update.lastPushedCommit,
          last_error_class: update.lastErrorClass,
          remote_blocked_reason: update.remoteBlockedReason
        })
      });
    } catch {
      // Local commits and push status must not be undone by ADS status transport failure.
    }
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

function latestRemoteArchive(events: MumuMemoryGitSyncEvent[]): MumuMemoryRemoteArchive | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const remoteArchive = events[index]?.remoteArchive;
    if (remoteArchive) {
      return remoteArchive;
    }
  }
  return null;
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function hasBlockedLfsPolicy(memoryRoot: string): Promise<boolean> {
  try {
    const attributes = await fs.readFile(path.join(memoryRoot, ".gitattributes"), "utf8");
    if (/\b(?:filter|diff|merge)=lfs\b/u.test(attributes)) {
      return true;
    }
  } catch {
    // No attributes file is the normal case.
  }

  for (const relativePath of await listTrackedPaths(memoryRoot)) {
    if (await trackedFileLooksLikeLfsPointer(memoryRoot, relativePath)) {
      return true;
    }
  }
  return false;
}

async function trackedFileLooksLikeLfsPointer(memoryRoot: string, relativePath: string): Promise<boolean> {
  const absolutePath = path.join(memoryRoot, relativePath);
  let handle;
  try {
    handle = await fs.open(absolutePath, "r");
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1");
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function listRemotePushRefspecs(memoryRoot: string): Promise<string[]> {
  const refspecs = ["refs/heads/main:refs/heads/main"];
  const { stdout } = await git(memoryRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/tags",
    "refs/savepoints",
    "refs/mumu/savepoints"
  ]);
  for (const ref of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    refspecs.push(`${ref}:${ref}`);
  }
  return refspecs;
}

async function defaultGitPush(
  request: MumuMemoryGitPushRequest,
  serviceGithubToken: string
): Promise<MumuMemoryGitPushOutcome> {
  const credentialHelper = "!f() { printf 'username=x-access-token\\npassword=%s\\n' \"$MUMU_SERVICE_GITHUB_TOKEN\"; }; f";
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${credentialHelper}`,
        "push",
        `https://github.com/${request.owner}/${request.repoName}.git`,
        ...request.refspecs
      ],
      {
        cwd: request.memoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          MUMU_SERVICE_GITHUB_TOKEN: serviceGithubToken
        },
        maxBuffer: 10 * 1024 * 1024
      }
    ) as { stdout: string; stderr: string };
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const outcome: MumuMemoryGitPushOutcome = {
      ok: false,
      stdout: failure.stdout,
      stderr: failure.stderr,
      message: failure.message
    };
    outcome.errorClass = classifyPushFailure(outcome);
    outcome.conflict = outcome.errorClass === "conflict_pending";
    return outcome;
  }
}

function classifyPushFailure(outcome: MumuMemoryGitPushOutcome | null): string {
  if (!outcome) {
    return "git_push_failed";
  }
  const details = `${outcome.message ?? ""}\n${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`;
  if (/non-fast-forward|fetch first|failed to push some refs|rejected/iu.test(details)) {
    return "conflict_pending";
  }
  if (/authentication failed|permission denied|repository not found|403/u.test(details.toLowerCase())) {
    return "github_auth_failed";
  }
  if (outcome.errorClass && /^[a-z][a-z0-9_]*$/u.test(outcome.errorClass)) {
    return outcome.errorClass;
  }
  return "git_push_failed";
}

function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" && ["127.0.0.1", "::1", "[::1]", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  }) as Promise<{ stdout: string; stderr: string }>;
}
