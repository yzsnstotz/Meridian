import * as fs from "node:fs";
import path from "node:path";

import { resolveMeridianPaths } from "@meridian/contracts";

const DISPATCH_DOCS_ANCHOR = "/docs/branch/";
const INTERNAL_DOCS_SEGMENT = "/docs";
const DETACHED_DOCS_REPO_MARKERS = new Set(["project", "projects"]);
const PROJECT_REPO_DIRECTORY_NAMES = ["projects", "Projects"];

export interface DispatchPathConfigLike {
  dispatch_plan_path?: string | null;
  command_file_path?: string | null;
  dispatch_repo_root?: string | null;
  docs_root?: string | null;
}

export function resolveDispatchRepoRoot(paths: Array<string | null | undefined>): string {
  const resolved = resolveDispatchRepoRootOrNull(paths);
  if (!resolved) {
    return resolveMeridianPaths().workRoot;
  }

  return resolved;
}

export function resolveRequiredDispatchRepoRoot(paths: Array<string | null | undefined>): string {
  const resolved = resolveDispatchRepoRootOrNull(paths);
  if (resolved) {
    return resolved;
  }

  throw new Error("Failed to resolve dispatch repo root from dispatch artifacts");
}

function resolveDispatchRepoRootOrNull(paths: Array<string | null | undefined>): string | null {
  for (const candidate of paths) {
    const resolvedRoot = resolveCandidateRepoRoot(candidate);
    if (resolvedRoot) {
      return resolvedRoot;
    }
  }

  return null;
}

function resolveCandidateRepoRoot(candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return null;
  }

  const resolvedPath = path.resolve(trimmed);
  const detachedDocsRepoRoot = resolveDetachedDocsRepoRoot(resolvedPath);
  if (detachedDocsRepoRoot) {
    return detachedDocsRepoRoot;
  }

  const docsBranchRoot = resolveDocsBranchRoot(resolvedPath);
  if (docsBranchRoot) {
    return docsBranchRoot;
  }

  const startDirectory = resolveExistingDirectory(resolvedPath);
  const gitRoot = findNearestGitRoot(startDirectory);
  if (gitRoot) {
    return gitRoot;
  }

  return startDirectory;
}

export function resolveConfiguredDispatchRepoRoot(config: DispatchPathConfigLike): string {
  const explicitRoot = normalizeExplicitPath(config.dispatch_repo_root);
  if (explicitRoot) {
    return explicitRoot;
  }

  return resolveDispatchRepoRoot([config.dispatch_plan_path, config.command_file_path]);
}

export function resolveConfiguredDocsRoot(config: DispatchPathConfigLike): string {
  const explicitRoot = normalizeExplicitPath(config.docs_root);
  if (explicitRoot) {
    return explicitRoot;
  }

  const inferredDocsRoot = resolveDispatchDocsRootOrNull([config.dispatch_plan_path, config.command_file_path]);
  if (inferredDocsRoot) {
    return inferredDocsRoot;
  }

  const portablePaths = resolveMeridianPaths();
  if (portablePaths.docsRoot) {
    return portablePaths.docsRoot;
  }

  const taskSpecDocsRoot = resolveDispatchDocsRootOrNull([portablePaths.taskSpecRoot]);
  if (taskSpecDocsRoot) {
    return taskSpecDocsRoot;
  }

  throw new Error(
    "docs_root_required: set docs_root or MERIDIAN_DOCS_ROOT, or provide a TaskSpec path under a Docs tree"
  );
}

function resolveExistingDirectory(candidatePath: string): string {
  try {
    const stat = fs.statSync(candidatePath);
    if (stat.isDirectory()) {
      return candidatePath;
    }
  } catch {
    // Fall through to dirname when the path does not exist yet.
  }

  return path.dirname(candidatePath);
}

function findNearestGitRoot(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function resolveDocsBranchRoot(candidatePath: string): string | null {
  const normalized = candidatePath.replace(/\\/g, "/");
  const anchorIndex = normalized.toLowerCase().lastIndexOf(DISPATCH_DOCS_ANCHOR);
  if (anchorIndex <= 0) {
    return null;
  }

  return path.normalize(normalized.slice(0, anchorIndex));
}

function resolveDispatchDocsRootOrNull(paths: Array<string | null | undefined>): string | null {
  for (const candidate of paths) {
    const resolvedDocsRoot = resolveCandidateDocsRoot(candidate);
    if (resolvedDocsRoot) {
      return resolvedDocsRoot;
    }
  }

  return null;
}

function resolveCandidateDocsRoot(candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return null;
  }

  const resolvedPath = path.resolve(trimmed);
  const detachedDocsRoot = resolveDetachedDocsRoot(resolvedPath);
  if (detachedDocsRoot) {
    return detachedDocsRoot;
  }

  const repoDocsRoot = resolveRepoDocsRoot(resolvedPath);
  if (repoDocsRoot) {
    return repoDocsRoot;
  }

  return null;
}

function resolveRepoDocsRoot(candidatePath: string): string | null {
  const normalized = candidatePath.replace(/\\/g, "/");
  const anchorIndex = normalized.toLowerCase().lastIndexOf(DISPATCH_DOCS_ANCHOR);
  if (anchorIndex <= 0) {
    return null;
  }

  return path.normalize(normalized.slice(0, anchorIndex + INTERNAL_DOCS_SEGMENT.length));
}

function resolveDetachedDocsRepoRoot(candidatePath: string): string | null {
  const detachedCandidate = parseDetachedDocsCandidate(candidatePath);
  if (!detachedCandidate) {
    return null;
  }

  const { workspaceRoot, repoName } = detachedCandidate;
  for (const repoDirectoryName of PROJECT_REPO_DIRECTORY_NAMES) {
    const repoRootCandidate = path.join(workspaceRoot, repoDirectoryName, repoName);
    const canonicalRepoRoot = resolveCanonicalDirectory(repoRootCandidate);
    if (!canonicalRepoRoot) {
      continue;
    }

    return findNearestGitRoot(canonicalRepoRoot) ?? canonicalRepoRoot;
  }

  return null;
}

function resolveDetachedDocsRoot(candidatePath: string): string | null {
  const detachedCandidate = parseDetachedDocsCandidate(candidatePath);
  if (!detachedCandidate) {
    return null;
  }

  const docsRootCandidate = path.join(detachedCandidate.workspaceRoot, detachedCandidate.docsDirectoryName);
  return resolveCanonicalDirectory(docsRootCandidate) ?? path.resolve(docsRootCandidate);
}

function parseDetachedDocsCandidate(candidatePath: string): {
  workspaceRoot: string;
  docsDirectoryName: string;
  repoName: string;
} | null {
  const normalized = candidatePath.replace(/\\/g, "/");
  const segments = normalized.split("/");

  for (let index = 0; index <= segments.length - 4; index += 1) {
    const docsDirectoryName = segments[index];
    const docsSegment = docsDirectoryName?.toLowerCase();
    const projectSegment = segments[index + 1]?.toLowerCase();
    const repoName = segments[index + 2];
    const branchSegment = segments[index + 3]?.toLowerCase();

    if (
      docsSegment !== "docs"
      || !DETACHED_DOCS_REPO_MARKERS.has(projectSegment ?? "")
      || !repoName
      || branchSegment !== "branch"
    ) {
      continue;
    }

    const workspaceRoot = normalizeSegmentPrefix(segments.slice(0, index));
    if (!workspaceRoot) {
      continue;
    }

    return {
      workspaceRoot,
      docsDirectoryName: docsDirectoryName ?? "Docs",
      repoName
    };
  }

  return null;
}

function normalizeSegmentPrefix(segments: string[]): string | null {
  if (segments.length === 0) {
    return null;
  }

  const joined = segments.join("/");
  return joined.length > 0 ? path.normalize(joined) : path.sep;
}

function directoryExists(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function resolveCanonicalDirectory(candidatePath: string): string | null {
  if (!directoryExists(candidatePath)) {
    return null;
  }

  try {
    return fs.realpathSync.native(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

function normalizeExplicitPath(candidatePath: string | null | undefined): string | null {
  const trimmed = candidatePath?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}
