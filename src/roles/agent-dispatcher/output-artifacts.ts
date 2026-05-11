import * as fs from "node:fs";
import path from "node:path";

import { parseMeridianStatusMarker } from "./meridian-status-marker";

export interface OutputArtifactFs {
  existsSync: typeof fs.existsSync;
  statSync: typeof fs.statSync;
  readdirSync: typeof fs.readdirSync;
  readFileSync: typeof fs.readFileSync;
}

export const defaultOutputArtifactFs: OutputArtifactFs = {
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  readdirSync: fs.readdirSync,
  readFileSync: fs.readFileSync
};

export function outputsExist(
  paths: string[],
  startedAt?: string,
  artifactFs: OutputArtifactFs = defaultOutputArtifactFs
): boolean {
  if (paths.length === 0) {
    return false;
  }

  return paths.every((filePath) => findExistingOutputArtifactPaths(filePath, startedAt, artifactFs).length > 0);
}

export function outputArtifactsContain(
  paths: string[],
  predicate: (content: string, artifactPath: string) => boolean,
  startedAt?: string,
  artifactFs: OutputArtifactFs = defaultOutputArtifactFs
): boolean {
  return paths.some((filePath) =>
    findExistingOutputArtifactPaths(filePath, startedAt, artifactFs).some((artifactPath) => {
      try {
        return predicate(artifactFs.readFileSync(artifactPath, "utf8"), artifactPath);
      } catch {
        return false;
      }
    })
  );
}

// Worker-authored MERIDIAN-STATUS marker is the authoritative claim about a
// worker's final outcome. When a report file's current-attempt slice contains
// `role: worker, worker_id: <id>, outcome: complete`, treat that as the truth
// and ignore narrative block/fail words elsewhere in the slice. `allowFenced`
// is true because workers sometimes wrap their final marker in a ``` fence
// for readability — in chat replies that would be ambiguous, but in their own
// report file it is unambiguously their final claim.
export function outputArtifactHasPassingWorkerMarker(content: string, workerId: string): boolean {
  const marker = parseMeridianStatusMarker(content, { allowFenced: true });
  return marker?.role === "worker"
    && marker.worker_id === workerId
    && marker.outcome === "complete";
}

export function outputArtifactHasPassingDecision(content: string): boolean {
  const decision = extractMarkdownSection(content, "Decision");
  if (!decision) {
    return false;
  }

  return decision
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^`|`$/g, ""))
    .filter(Boolean)
    .some((line) => /^(?:PASS_WITH_FINDINGS|PASS\s+WITH\s+FINDINGS|PASSED|PASS)\b/i.test(line));
}

// Worker report convention: `### Outcome` heading whose first non-empty line
// is `complete` / `completed` / `success` / `passed`. The standard worker
// report template emits this even when the worker forgets the trailing
// `<<<MERIDIAN-STATUS>>>` marker. Treat the worker's own outcome claim as
// structured evidence, parallel to validator `## Decision: PASS` and the
// MERIDIAN-STATUS marker. Scans the LAST `Outcome` section so multi-attempt
// reports use the latest attempt's claim; an earlier attempt's
// `### Outcome \n `failed`` still trips STRUCTURED_FAILURE_SIGNAL_PATTERNS.
export function outputArtifactHasPassingOutcome(content: string): boolean {
  const section = extractLastMarkdownSection(content, "Outcome");
  if (!section) {
    return false;
  }

  return section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/`/g, "").trim())
    .filter(Boolean)
    .some((line) => /^(?:COMPLETED?|SUCCESS|PASSED|PASS)\b/i.test(line));
}

export function sliceContentFromStartedAt(content: string, startedAt?: string): string {
  if (!startedAt || !content) {
    return content;
  }

  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    return content;
  }

  const isoPattern = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = isoPattern.exec(content)) !== null) {
    const ts = Date.parse(m[1]!);
    if (!Number.isNaN(ts) && ts >= startedAtMs) {
      return content.slice(m.index);
    }
  }

  return content;
}

export function findExistingOutputArtifactPaths(
  filePath: string,
  startedAt?: string,
  artifactFs: OutputArtifactFs = defaultOutputArtifactFs
): string[] {
  const startedAtMs = parseArtifactFreshnessBaseline(startedAt);
  return [...new Set([
    ...findExistingFileWithSize(filePath, startedAtMs, artifactFs),
    ...findOutputArtifactsInSubdirectories(filePath, startedAtMs, artifactFs),
    ...findOutputArtifactsInSiblingReportDirectories(filePath, startedAtMs, artifactFs)
  ])];
}

function findExistingFileWithSize(
  filePath: string,
  startedAtMs: number | null,
  artifactFs: OutputArtifactFs
): string[] {
  return fileExistsWithSize(filePath, startedAtMs, artifactFs) ? [filePath] : [];
}

function fileExistsWithSize(
  filePath: string,
  startedAtMs: number | null,
  artifactFs: OutputArtifactFs
): boolean {
  if (!artifactFs.existsSync(filePath)) {
    return false;
  }

  try {
    const stats = artifactFs.statSync(filePath);
    return stats.size > 0 && outputArtifactBelongsToAttempt(stats, startedAtMs);
  } catch {
    return false;
  }
}

function findOutputArtifactsInSubdirectories(
  filePath: string,
  startedAtMs: number | null,
  artifactFs: OutputArtifactFs
): string[] {
  return searchDirectoryForBasename(path.dirname(filePath), path.basename(filePath), startedAtMs, artifactFs);
}

/**
 * Search sibling report directories with basename variants. Handles cases
 * where expected output is in `dev_history/` but the actual report is in
 * `reports/` (or vice versa), possibly with different naming conventions
 * (`N-07_report.md` vs `N-07.md`).
 */
function findOutputArtifactsInSiblingReportDirectories(
  filePath: string,
  startedAtMs: number | null,
  artifactFs: OutputArtifactFs
): string[] {
  const directory = path.dirname(filePath);
  const grandparent = path.dirname(directory);
  const dirName = path.basename(directory).toLowerCase();
  const basenameVariants = computeBasenameVariants(path.basename(filePath));

  const siblingDirs = dirName === "reports"
    ? ["dev_history"]
    : ["reports"];

  const matches: string[] = [];
  for (const siblingDir of siblingDirs) {
    const siblingPath = path.join(grandparent, siblingDir);
    for (const variant of basenameVariants) {
      matches.push(...findExistingFileWithSize(path.join(siblingPath, variant), startedAtMs, artifactFs));
      matches.push(...searchDirectoryForBasename(siblingPath, variant, startedAtMs, artifactFs));
    }
  }

  return matches;
}

function searchDirectoryForBasename(
  directory: string,
  basename: string,
  startedAtMs: number | null,
  artifactFs: OutputArtifactFs
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = artifactFs.readdirSync(directory, { withFileTypes: true }) as fs.Dirent[];
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    matches.push(...findExistingFileWithSize(path.join(directory, entry.name, basename), startedAtMs, artifactFs));
  }

  return matches;
}

function parseArtifactFreshnessBaseline(startedAt: string | undefined): number | null {
  if (!startedAt) {
    return null;
  }

  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function outputArtifactBelongsToAttempt(stats: fs.Stats, startedAtMs: number | null): boolean {
  if (startedAtMs === null) {
    return true;
  }

  return stats.mtimeMs >= startedAtMs;
}

/**
 * Generates basename variants for different naming conventions:
 * `N-07_report.md` <-> `N-07.md`
 */
export function computeBasenameVariants(basename: string): string[] {
  const variants = [basename];
  const reportSuffixMatch = basename.match(/^(.+)_report(\.md)$/i);
  if (reportSuffixMatch) {
    variants.push(`${reportSuffixMatch[1]}${reportSuffixMatch[2]}`);
  } else {
    const extMatch = basename.match(/^(.+)(\.md)$/i);
    if (extMatch) {
      variants.push(`${extMatch[1]}_report${extMatch[2]}`);
    }
  }

  if (/^delta-check_report\.md$/i.test(basename)) {
    variants.push("delta_check_report.md");
  }
  if (/^pr-review_report\.md$/i.test(basename)) {
    variants.push("pr_review_report.md");
  }

  return [...new Set(variants)];
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const headingPattern = new RegExp(`(^|\\n)#{1,6}\\s+${escapeRegExp(heading)}\\s*\\n`, "i");
  const match = headingPattern.exec(content);
  if (!match || typeof match.index !== "number") {
    return null;
  }

  const sectionStart = match.index + match[0].length;
  const remaining = content.slice(sectionStart);
  const nextHeading = remaining.search(/\n#{1,6}\s+\S/);
  return nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
}

function extractLastMarkdownSection(content: string, heading: string): string | null {
  const headingPattern = new RegExp(`(^|\\n)#{1,6}\\s+${escapeRegExp(heading)}\\s*\\n`, "gi");
  let lastMatchIndex = -1;
  let lastMatchLength = 0;
  let m: RegExpExecArray | null;
  while ((m = headingPattern.exec(content)) !== null) {
    lastMatchIndex = m.index;
    lastMatchLength = m[0].length;
  }
  if (lastMatchIndex < 0) {
    return null;
  }

  const sectionStart = lastMatchIndex + lastMatchLength;
  const remaining = content.slice(sectionStart);
  const nextHeading = remaining.search(/\n#{1,6}\s+\S/);
  return nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
