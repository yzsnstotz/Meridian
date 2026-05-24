import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAVEPOINT_TAG_PREFIX = "mumu-savepoints";
const SAVEPOINT_REF_PREFIX = `refs/tags/${SAVEPOINT_TAG_PREFIX}`;
const SAVEPOINT_ID_PATTERN = /^sp-[A-Za-z0-9][A-Za-z0-9_-]{1,95}$/u;
const LABEL_MAX_LENGTH = 160;
const RESTORE_RECORD_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

export type MumuMemorySavepointSyncStatus = "local" | "pending" | "pushed" | "paused" | "blocked" | "failed";
export type MumuMemorySnapshotChangeStatus = "added" | "modified" | "deleted";
export type MumuMemoryRestoreScope =
  | { kind: "root" }
  | { kind: "record_type"; record_type: string }
  | { kind: "record"; record_type: string; key: string };

export interface MumuMemorySavepoint {
  id: string;
  label: string | null;
  created_at: string;
  commit_sha: string;
  short_commit: string;
  ref_name: string;
  sync_status: MumuMemorySavepointSyncStatus;
  restore_available: boolean;
}

export interface MumuMemorySnapshotRecord {
  type: string;
  key: string;
  path: string;
  category: string;
  genre: string | null;
  record: unknown;
}

export interface MumuMemoryStyleSnapshotRecord extends MumuMemorySnapshotRecord {
  category: "style";
  genre: string;
  user_authored: unknown;
  agent_observed: unknown;
}

export interface MumuMemorySnapshotChange {
  status: MumuMemorySnapshotChangeStatus;
  type: string;
  key: string;
  path: string;
  category: string;
  genre: string | null;
  before?: unknown;
  after?: unknown;
}

export interface MumuMemoryStyleSnapshotChange extends MumuMemorySnapshotChange {
  category: "style";
  genre: string;
}

export interface MumuMemorySnapshot {
  savepoint: MumuMemorySavepoint;
  records: MumuMemorySnapshotRecord[];
  style_records: MumuMemoryStyleSnapshotRecord[];
  changes: MumuMemorySnapshotChange[];
  style_changes: MumuMemoryStyleSnapshotChange[];
}

export interface MumuMemoryRestoreResult {
  savepoint: MumuMemorySavepoint;
  scope: MumuMemoryRestoreScope;
  previous_head_sha: string | null;
  safety_commit_sha: string | null;
  restore_commit_sha: string;
  restored_paths: string[];
  deleted_paths: string[];
}

export interface CreateMumuMemorySavepointOptions {
  label?: string | null;
  id?: string;
  now?: () => Date;
  syncStatus?: MumuMemorySavepointSyncStatus;
}

export class MumuMemorySavepointError extends Error {
  constructor(
    readonly code:
      | "invalid_savepoint_id"
      | "no_archive_commit"
      | "savepoint_not_found"
      | "invalid_restore_scope"
      | "restore_source_not_found",
    message = code
  ) {
    super(message);
    this.name = "MumuMemorySavepointError";
  }
}

export const isMumuMemorySavepointId = (value: string): boolean => SAVEPOINT_ID_PATTERN.test(value);

export async function createMumuMemorySavepoint(
  memoryRoot: string,
  options: CreateMumuMemorySavepointOptions = {}
): Promise<MumuMemorySavepoint> {
  const root = path.resolve(memoryRoot);
  const id = options.id ?? `sp-${randomUUID()}`;
  assertValidSavepointId(id);
  const commitSha = await readHeadSha(root);
  if (!commitSha) {
    throw new MumuMemorySavepointError("no_archive_commit");
  }

  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const label = normalizeLabel(options.label);
  const metadata = {
    version: 1,
    id,
    created_at: createdAt,
    ...(label ? { label } : {})
  };
  const tagName = tagShortName(id);
  await git(root, ["tag", "-a", tagName, commitSha, "-m", JSON.stringify(metadata)]);
  return {
    id,
    label,
    created_at: createdAt,
    commit_sha: commitSha,
    short_commit: commitSha.slice(0, 12),
    ref_name: savepointRefName(id),
    sync_status: options.syncStatus ?? "local",
    restore_available: true
  };
}

export async function listMumuMemorySavepoints(memoryRoot: string): Promise<MumuMemorySavepoint[]> {
  const root = path.resolve(memoryRoot);
  if (!existsSync(path.join(root, ".git"))) {
    return [];
  }

  let stdout = "";
  try {
    ({ stdout } = await git(root, ["for-each-ref", "--format=%(refname)", SAVEPOINT_REF_PREFIX]));
  } catch {
    return [];
  }

  const savepoints = (
    await Promise.all(
      stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(async (refName) => {
          const id = idFromRefName(refName);
          if (!id) {
            return null;
          }
          try {
            return await readSavepoint(root, id, "local");
          } catch {
            return null;
          }
        })
    )
  ).filter((value): value is MumuMemorySavepoint => Boolean(value));

  return savepoints.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function readMumuMemorySnapshot(
  memoryRoot: string,
  savepointId: string
): Promise<MumuMemorySnapshot> {
  const root = path.resolve(memoryRoot);
  const savepoint = await readSavepoint(root, savepointId, "local");
  const paths = await listStructuredPathsAtCommit(root, savepoint.commit_sha);
  const records = (
    await Promise.all(
      paths.map(async (relativePath): Promise<MumuMemorySnapshotRecord | null> => {
        const descriptor = descriptorFromStructuredPath(relativePath);
        if (!descriptor) {
          return null;
        }
        const record = await readJsonAtCommit(root, savepoint.commit_sha, relativePath);
        if (record === undefined) {
          return null;
        }
        return {
          ...descriptor,
          path: relativePath,
          record
        };
      })
    )
  ).filter((value): value is MumuMemorySnapshotRecord => value !== null);

  const changes = await listSnapshotChanges(root, savepoint.commit_sha);
  const styleRecords = records
    .map(toStyleSnapshotRecord)
    .filter((value): value is MumuMemoryStyleSnapshotRecord => Boolean(value));
  const styleChanges = changes
    .filter((change): change is MumuMemoryStyleSnapshotChange => change.category === "style" && Boolean(change.genre));

  return {
    savepoint,
    records,
    style_records: styleRecords,
    changes,
    style_changes: styleChanges
  };
}

export async function restoreMumuMemorySavepoint(
  memoryRoot: string,
  savepointId: string,
  options: { scope?: MumuMemoryRestoreScope } = {}
): Promise<MumuMemoryRestoreResult> {
  const root = path.resolve(memoryRoot);
  const scope = normalizeRestoreScope(options.scope);
  const savepoint = await readSavepoint(root, savepointId, "local");
  const sourcePaths = await listRestoreSourcePaths(root, savepoint.commit_sha, scope);
  const sourceContents = new Map<string, string>();
  for (const relativePath of sourcePaths) {
    sourceContents.set(relativePath, await readTextAtCommit(root, savepoint.commit_sha, relativePath));
  }

  const previousHeadSha = await readHeadSha(root);
  const safetyCommitSha = await commitSafetySnapshotIfDirty(root);
  const currentPaths = scope.kind === "record" ? [] : await listCurrentRestorePaths(root, scope);
  const sourcePathSet = new Set(sourcePaths);
  const deletedPaths = currentPaths.filter((relativePath) => !sourcePathSet.has(relativePath));

  for (const relativePath of deletedPaths) {
    assertSafeRelativePath(relativePath);
    await fs.rm(path.join(root, relativePath), { force: true });
  }
  for (const [relativePath, content] of sourceContents) {
    assertSafeRelativePath(relativePath);
    const destination = path.join(root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, "utf8");
  }

  await stageRestoreChanges(root, sourcePaths, deletedPaths);
  await git(root, ["commit", "--allow-empty", "-m", `mumu memory restore savepoint ${savepoint.id}`]);
  const restoreCommitSha = await readHeadSha(root);
  if (!restoreCommitSha) {
    throw new MumuMemorySavepointError("restore_source_not_found");
  }

  return {
    savepoint,
    scope,
    previous_head_sha: previousHeadSha,
    safety_commit_sha: safetyCommitSha,
    restore_commit_sha: restoreCommitSha,
    restored_paths: sourcePaths,
    deleted_paths: deletedPaths
  };
}

async function readSavepoint(
  memoryRoot: string,
  savepointId: string,
  syncStatus: MumuMemorySavepointSyncStatus
): Promise<MumuMemorySavepoint> {
  assertValidSavepointId(savepointId);
  const refName = savepointRefName(savepointId);
  let commitSha = "";
  try {
    ({ stdout: commitSha } = await git(memoryRoot, ["rev-parse", `${refName}^{}`]));
  } catch {
    throw new MumuMemorySavepointError("savepoint_not_found");
  }
  const commit = commitSha.trim();
  const tag = await readTagMetadata(memoryRoot, refName);
  return {
    id: savepointId,
    label: tag.label,
    created_at: tag.createdAt,
    commit_sha: commit,
    short_commit: commit.slice(0, 12),
    ref_name: refName,
    sync_status: syncStatus,
    restore_available: Boolean(commit)
  };
}

async function readTagMetadata(memoryRoot: string, refName: string): Promise<{ label: string | null; createdAt: string }> {
  const { stdout } = await git(memoryRoot, ["for-each-ref", "--format=%(taggerdate:iso-strict)%00%(contents)", refName]);
  const nulIndex = stdout.indexOf("\0");
  const taggerDate = nulIndex >= 0 ? stdout.slice(0, nulIndex).trim() : "";
  const contents = nulIndex >= 0 ? stdout.slice(nulIndex + 1).trim() : "";
  const parsed = parseTagMetadata(contents);
  return {
    label: normalizeLabel(parsed.label),
    createdAt: typeof parsed.created_at === "string" && parsed.created_at ? parsed.created_at : taggerDate
  };
}

function parseTagMetadata(contents: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function listStructuredPathsAtCommit(memoryRoot: string, commitSha: string): Promise<string[]> {
  const { stdout } = await git(memoryRoot, ["ls-tree", "-r", "-z", "--name-only", commitSha, "--", "structured"]);
  return stdout
    .split("\0")
    .filter((relativePath) => descriptorFromStructuredPath(relativePath) !== null);
}

async function listRestoreSourcePaths(
  memoryRoot: string,
  commitSha: string,
  scope: MumuMemoryRestoreScope
): Promise<string[]> {
  if (scope.kind === "record") {
    const recordPath = structuredRecordPath(scope.record_type, scope.key);
    try {
      await git(memoryRoot, ["cat-file", "-e", `${commitSha}:${recordPath}`]);
    } catch {
      throw new MumuMemorySavepointError("restore_source_not_found");
    }
    return [recordPath];
  }

  const pathspecs = restorePathspecs(scope);
  const { stdout } = await git(memoryRoot, ["ls-tree", "-r", "-z", "--name-only", commitSha, "--", ...pathspecs]);
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => relativePath.split(path.sep).join("/"))
    .filter(isDurableRestorePath)
    .sort();
}

async function listCurrentRestorePaths(memoryRoot: string, scope: MumuMemoryRestoreScope): Promise<string[]> {
  try {
    const { stdout } = await git(memoryRoot, ["ls-files", "-z", "--", ...restorePathspecs(scope)]);
    return stdout
      .split("\0")
      .filter(Boolean)
      .map((relativePath) => relativePath.split(path.sep).join("/"))
      .filter(isDurableRestorePath)
      .sort();
  } catch {
    return [];
  }
}

async function stageRestoreChanges(memoryRoot: string, restoredPaths: string[], deletedPaths: string[]): Promise<void> {
  const pathspecs = Array.from(new Set([...restoredPaths, ...deletedPaths]));
  if (!pathspecs.length) {
    return;
  }
  await git(memoryRoot, ["add", "-A", "--", ...pathspecs]);
}

async function listSnapshotChanges(memoryRoot: string, commitSha: string): Promise<MumuMemorySnapshotChange[]> {
  const headSha = await readHeadSha(memoryRoot);
  if (!headSha) {
    return [];
  }
  const { stdout } = await git(memoryRoot, ["diff", "--name-status", "-z", `${commitSha}..${headSha}`, "--", "structured"]);
  const parts = stdout.split("\0").filter(Boolean);
  const changes: MumuMemorySnapshotChange[] = [];
  for (let index = 0; index < parts.length;) {
    const statusToken = parts[index++] ?? "";
    const statusCode = statusToken[0] ?? "";
    let relativePath = parts[index++] ?? "";
    if (statusCode === "R" || statusCode === "C") {
      relativePath = parts[index++] ?? relativePath;
    }
    const descriptor = descriptorFromStructuredPath(relativePath);
    if (!descriptor) {
      continue;
    }
    const status = snapshotStatus(statusCode);
    const before = status === "added" ? undefined : await readJsonAtCommit(memoryRoot, commitSha, relativePath);
    const after = status === "deleted" ? undefined : await readJsonFromWorktree(memoryRoot, relativePath);
    changes.push({
      status,
      ...descriptor,
      path: relativePath,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {})
    });
  }
  return changes;
}

function snapshotStatus(statusCode: string): MumuMemorySnapshotChangeStatus {
  if (statusCode === "A") {
    return "added";
  }
  if (statusCode === "D") {
    return "deleted";
  }
  return "modified";
}

function descriptorFromStructuredPath(
  relativePath: string
): Pick<MumuMemorySnapshotRecord, "type" | "key" | "category" | "genre"> | null {
  const normalized = relativePath.split(path.sep).join("/");
  const match = /^structured\/([^/]+)\/([^/]+)\.json$/u.exec(normalized);
  if (!match || match[2] === "_index") {
    return null;
  }
  const type = match[1]!;
  const key = match[2]!;
  const underscore = type.indexOf("_");
  const category = underscore > 0 ? type.slice(0, underscore) : type;
  const genre = underscore > 0 ? type.slice(underscore + 1) : null;
  return { type, key, category, genre };
}

function toStyleSnapshotRecord(record: MumuMemorySnapshotRecord): MumuMemoryStyleSnapshotRecord | null {
  if (record.category !== "style" || !record.genre) {
    return null;
  }
  const body = isRecord(record.record) ? record.record : {};
  return {
    ...record,
    category: "style",
    genre: record.genre,
    user_authored: body.user_authored ?? null,
    agent_observed: body.agent_observed ?? null
  };
}

async function readJsonAtCommit(memoryRoot: string, commitSha: string, relativePath: string): Promise<unknown | undefined> {
  try {
    const { stdout } = await git(memoryRoot, ["show", `${commitSha}:${relativePath}`]);
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

async function readTextAtCommit(memoryRoot: string, commitSha: string, relativePath: string): Promise<string> {
  try {
    const { stdout } = await git(memoryRoot, ["show", `${commitSha}:${relativePath}`]);
    return stdout;
  } catch {
    throw new MumuMemorySavepointError("restore_source_not_found");
  }
}

async function readJsonFromWorktree(memoryRoot: string, relativePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(memoryRoot, relativePath), "utf8"));
  } catch {
    return undefined;
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

async function commitSafetySnapshotIfDirty(memoryRoot: string): Promise<string | null> {
  const { stdout } = await git(memoryRoot, ["status", "--porcelain"]);
  if (!stdout.trim()) {
    return null;
  }
  await git(memoryRoot, ["add", "-A"]);
  try {
    await git(memoryRoot, ["diff", "--cached", "--quiet"]);
    return null;
  } catch {
    await git(memoryRoot, ["commit", "-m", "mumu memory safety before restore"]);
    return readHeadSha(memoryRoot);
  }
}

function normalizeLabel(label: unknown): string | null {
  if (typeof label !== "string") {
    return null;
  }
  const trimmed = label.replace(/\u0000/gu, "").trim();
  return trimmed ? trimmed.slice(0, LABEL_MAX_LENGTH) : null;
}

function assertValidSavepointId(savepointId: string): void {
  if (!SAVEPOINT_ID_PATTERN.test(savepointId)) {
    throw new MumuMemorySavepointError("invalid_savepoint_id");
  }
}

function normalizeRestoreScope(scope: MumuMemoryRestoreScope | undefined): MumuMemoryRestoreScope {
  if (!scope) {
    return { kind: "root" };
  }
  if (scope.kind === "root") {
    return { kind: "root" };
  }
  if (scope.kind === "record_type") {
    assertValidRecordType(scope.record_type);
    return { kind: "record_type", record_type: scope.record_type };
  }
  if (scope.kind === "record") {
    assertValidRecordType(scope.record_type);
    assertValidRecordKey(scope.key);
    return { kind: "record", record_type: scope.record_type, key: scope.key };
  }
  throw new MumuMemorySavepointError("invalid_restore_scope");
}

function assertValidRecordType(recordType: string): void {
  if (!RESTORE_RECORD_TYPE_PATTERN.test(recordType)) {
    throw new MumuMemorySavepointError("invalid_restore_scope");
  }
}

function assertValidRecordKey(key: string): void {
  if (!key || key.includes("/") || key.includes("\\") || key.includes("\0") || key === "." || key === "..") {
    throw new MumuMemorySavepointError("invalid_restore_scope");
  }
}

function structuredRecordPath(recordType: string, key: string): string {
  assertValidRecordType(recordType);
  assertValidRecordKey(key);
  return `structured/${recordType}/${key}.json`;
}

function restorePathspecs(scope: MumuMemoryRestoreScope): string[] {
  if (scope.kind === "root") {
    return ["structured", "turns"];
  }
  if (scope.kind === "record_type") {
    assertValidRecordType(scope.record_type);
    return [`structured/${scope.record_type}`];
  }
  return [structuredRecordPath(scope.record_type, scope.key)];
}

function isDurableRestorePath(relativePath: string): boolean {
  return relativePath.startsWith("structured/") || relativePath.startsWith("turns/");
}

function assertSafeRelativePath(relativePath: string): void {
  const normalized = relativePath.split(path.sep).join("/");
  if (
    !isDurableRestorePath(normalized)
    || normalized.startsWith("/")
    || normalized.includes("\0")
    || normalized.split("/").some((part) => part === "..")
  ) {
    throw new MumuMemorySavepointError("invalid_restore_scope");
  }
}

function savepointRefName(savepointId: string): string {
  return `${SAVEPOINT_REF_PREFIX}/${savepointId}`;
}

function tagShortName(savepointId: string): string {
  return `${SAVEPOINT_TAG_PREFIX}/${savepointId}`;
}

function idFromRefName(refName: string): string | null {
  const prefix = `${SAVEPOINT_REF_PREFIX}/`;
  if (!refName.startsWith(prefix)) {
    return null;
  }
  const id = refName.slice(prefix.length);
  return isMumuMemorySavepointId(id) ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  }) as Promise<{ stdout: string; stderr: string }>;
}
