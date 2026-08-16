import { execFileSync } from "node:child_process";

export interface WorkerCommitMatch {
  sha: string;
  subject: string;
  committerDateMs: number;
}

export interface ScanRecentCommitsOptions {
  windowDays?: number;
  cwd?: string;
  now?: () => number;
  // Test seam — defaults to a wrapper around execFileSync. Returning a string;
  // throw or return empty if git is unavailable / the branch doesn't exist.
  execFile?: (command: string, args: string[], opts: { cwd?: string }) => string;
}

const DEFAULT_WINDOW_DAYS = 7;
const SHA_FIELD_REGEX = /^[0-9a-f]{7,40}$/i;

// Strict, narrow prefix match against `[WORKER_ID]` so `[W-1]` never absorbs
// `[W-10]`. The character immediately after `]` must be EOL or a space-class
// separator — refuses `[W-1]x` style false matches that a simple substring
// search would accept.
export function subjectMatchesWorkerPrefix(subject: string, workerId: string): boolean {
  if (!subject || !workerId) return false;
  const cleaned = subject.replace(/^\s+/, "");
  const prefix = `[${workerId}]`;
  if (!cleaned.startsWith(prefix)) return false;
  const next = cleaned.charAt(prefix.length);
  return next === "" || next === " " || next === "\t" || next === ":" || next === "-";
}

export function scanRecentCommitsForWorker(
  baseBranch: string,
  workerId: string,
  options: ScanRecentCommitsOptions = {}
): WorkerCommitMatch[] {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const exec = options.execFile ?? defaultExecFile;
  const nowMs = options.now?.() ?? Date.now();
  const sinceIso = new Date(nowMs - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Refuse obviously hostile branch inputs even though we already use
  // execFile (no shell). A leading `-` would be parsed as a git flag.
  if (!baseBranch || baseBranch.startsWith("-")) {
    return [];
  }

  let output: string;
  try {
    output = exec(
      "git",
      ["log", baseBranch, `--since=${sinceIso}`, "--format=%H%x09%ct%x09%s"],
      { cwd: options.cwd }
    );
  } catch {
    return [];
  }

  const matches: WorkerCommitMatch[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;

    const sha = line.slice(0, firstTab);
    if (!SHA_FIELD_REGEX.test(sha)) continue;

    const ctSeconds = Number.parseInt(line.slice(firstTab + 1, secondTab), 10);
    if (!Number.isFinite(ctSeconds)) continue;

    const subject = line.slice(secondTab + 1);
    if (!subjectMatchesWorkerPrefix(subject, workerId)) continue;

    matches.push({
      sha,
      subject,
      committerDateMs: ctSeconds * 1000
    });
  }

  return matches;
}

function defaultExecFile(command: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(command, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}
