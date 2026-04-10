import * as fs from "node:fs";
import path from "node:path";

const DISPATCH_DOCS_ANCHOR = "/docs/branch/";

export function resolveDispatchRepoRoot(paths: Array<string | null | undefined>): string {
  const resolved = resolveDispatchRepoRootOrNull(paths);
  if (!resolved) {
    return process.cwd();
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
  const startDirectory = resolveExistingDirectory(resolvedPath);
  const gitRoot = findNearestGitRoot(startDirectory);
  if (gitRoot) {
    return gitRoot;
  }

  const docsBranchRoot = resolveDocsBranchRoot(resolvedPath);
  if (docsBranchRoot) {
    return docsBranchRoot;
  }

  return startDirectory;
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
  const anchorIndex = normalized.lastIndexOf(DISPATCH_DOCS_ANCHOR);
  if (anchorIndex <= 0) {
    return null;
  }

  return path.normalize(normalized.slice(0, anchorIndex));
}
