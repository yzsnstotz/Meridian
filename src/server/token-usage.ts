import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Per-thread LLM token totals derived from the agent's session file on disk.
//
// The /api/agentapi-processes snapshot lists processes; this module enriches
// each codex/claude process with cumulative token usage for the session that
// process is participating in. The codex npm package runs as TWO OS processes
// (a node shim + a native rust binary, both sharing one session); the agentapi
// parent participates in zero LLM turns. To present a coherent "tokens per
// process" view, both shim and native rows show the same numbers (read off the
// single session file), and the agentapi row stays empty.
//
// Codex and Claude write session files to different places and in different
// shapes, but the *resolution* problem is the same: given a live PID, find the
// on-disk file that captures its model traffic.

export interface TokenUsage {
  source: "codex" | "claude";
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  session_file: string;
  session_id: string | null;
}

// Source of process start time + cwd for a PID. Real impl shells out to `ps`
// and `lsof`; tests inject a stub.
export interface ProcessAttrs {
  startMs: number;          // epoch millis, from `ps -o lstart=`
  cwd: string | null;       // working directory, from `lsof -F cwd`; may be null on platforms where lookup fails
}

export interface CollectorDeps {
  getProcessAttrs?: (pid: number) => ProcessAttrs | null;
  listDir?: (dir: string) => string[];
  readFile?: (p: string) => Buffer;
  // Read at most `length` bytes from the start of the file. Production uses
  // fs.openSync+readSync to avoid pulling 50MB session rollouts just to read
  // the first JSON line; tests can implement via readFile().subarray(0, n).
  readHead?: (p: string, length: number) => Buffer;
  stat?: (p: string) => { mtimeMs: number; size: number } | null;
  codexSessionsRoot?: string;     // default: ~/.codex/sessions
  claudeProjectsRoot?: string;    // default: ~/.claude/projects
  now?: () => Date;
}

interface FileUsageCacheEntry {
  mtimeMs: number;
  size: number;
  usage: TokenUsage;
}

// Codex creates the rollout file shortly after process start (we observed
// delays up to ~45s while the first turn warms up). Allow a generous window
// to avoid false negatives. False positives are still bounded by cwd match.
const CODEX_SESSION_OPEN_WINDOW_MS = 5 * 60 * 1000;

// Claude similarly takes a few seconds to materialise its project jsonl on
// first turn. Same window logic.
const CLAUDE_SESSION_OPEN_WINDOW_MS = 5 * 60 * 1000;

export class TokenUsageCollector {
  private readonly deps: Required<Omit<CollectorDeps, "codexSessionsRoot" | "claudeProjectsRoot">> & {
    codexSessionsRoot: string;
    claudeProjectsRoot: string;
  };

  // pid -> resolved session file path. null = "tried and gave up".
  // Once resolved we never re-resolve for the same pid (codex/claude pids do
  // not switch sessions mid-flight).
  private readonly pidToFile = new Map<number, string | null>();

  // file path -> last-known usage, keyed by (mtime,size). Avoids re-parsing
  // long sessions when the file hasn't grown.
  private readonly fileUsageCache = new Map<string, FileUsageCacheEntry>();

  constructor(deps: CollectorDeps = {}) {
    this.deps = {
      getProcessAttrs: deps.getProcessAttrs ?? defaultGetProcessAttrs,
      listDir: deps.listDir ?? defaultListDir,
      readFile: deps.readFile ?? ((p) => fs.readFileSync(p)),
      readHead: deps.readHead ?? defaultReadHead,
      stat: deps.stat ?? defaultStat,
      now: deps.now ?? (() => new Date()),
      codexSessionsRoot: deps.codexSessionsRoot ?? path.join(os.homedir(), ".codex", "sessions"),
      claudeProjectsRoot: deps.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects")
    };
  }

  // Drop cached attribution for pids that no longer appear. Otherwise a pid
  // recycled by the OS to an unrelated process could inherit a stale lookup.
  retain(livePids: Set<number>): void {
    for (const pid of [...this.pidToFile.keys()]) {
      if (!livePids.has(pid)) {
        this.pidToFile.delete(pid);
      }
    }
  }

  lookup(pid: number, agentType: "codex" | "claude"): TokenUsage | null {
    const cached = this.pidToFile.get(pid);
    let filePath: string | null;
    if (cached === undefined) {
      const attrs = this.deps.getProcessAttrs(pid);
      filePath = attrs
        ? agentType === "codex"
          ? this.resolveCodexSessionFile(attrs)
          : this.resolveClaudeSessionFile(attrs)
        : null;
      this.pidToFile.set(pid, filePath);
    } else {
      filePath = cached;
    }

    if (!filePath) return null;
    return this.readUsage(filePath, agentType);
  }

  // codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-with-dashes>-<uuid>.jsonl.
  // The first line is `session_meta` with the canonical session start
  // timestamp and cwd. We pick the matching session file by:
  //   1. listing rollout files whose path date is on or after pid_start_date,
  //   2. peeking the session_meta line for each candidate,
  //   3. requiring cwd match AND session_meta.timestamp within [start, start+window].
  // First match wins.
  private resolveCodexSessionFile(attrs: ProcessAttrs): string | null {
    if (!attrs.cwd) return null;

    const candidates = listCodexRolloutFiles(this.deps.codexSessionsRoot, attrs.startMs, this.deps.listDir);
    for (const filePath of candidates) {
      const meta = peekCodexSessionMeta(filePath, this.deps.readHead);
      if (!meta) continue;
      if (meta.cwd !== attrs.cwd) continue;
      if (meta.timestampMs < attrs.startMs - 1_000) continue;
      if (meta.timestampMs > attrs.startMs + CODEX_SESSION_OPEN_WINDOW_MS) continue;
      return filePath;
    }
    return null;
  }

  // claude writes ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, one
  // jsonl per session. The encoded-cwd is the absolute cwd with `/` replaced
  // by `-`. We list jsonl files in that directory whose ctime/mtime are after
  // the process start, and pick the one with the smallest start-delta.
  private resolveClaudeSessionFile(attrs: ProcessAttrs): string | null {
    if (!attrs.cwd) return null;
    const dir = path.join(this.deps.claudeProjectsRoot, encodeClaudeProjectPath(attrs.cwd));
    let entries: string[];
    try {
      entries = this.deps.listDir(dir);
    } catch {
      return null;
    }

    let best: { path: string; mtime: number } | null = null;
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      const st = this.deps.stat(full);
      if (!st) continue;
      // Session file should be modified at or after pid start; tolerate small
      // clock skew. Anything ≥30s before the start can't be this session.
      if (st.mtimeMs < attrs.startMs - 30_000) continue;
      if (best === null || Math.abs(st.mtimeMs - attrs.startMs) < Math.abs(best.mtime - attrs.startMs)) {
        best = { path: full, mtime: st.mtimeMs };
      }
    }
    // Require the chosen file to be within the open window — otherwise we're
    // likely picking an unrelated older session that happened to be touched.
    if (best && best.mtime - attrs.startMs <= CLAUDE_SESSION_OPEN_WINDOW_MS) {
      return best.path;
    }
    return null;
  }

  private readUsage(filePath: string, source: "codex" | "claude"): TokenUsage | null {
    const st = this.deps.stat(filePath);
    if (!st) return null;
    const cached = this.fileUsageCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.usage;
    }
    let buf: Buffer;
    try {
      buf = this.deps.readFile(filePath);
    } catch {
      return null;
    }
    const usage = source === "codex"
      ? parseCodexUsage(buf, filePath)
      : parseClaudeUsage(buf, filePath);
    if (!usage) return null;
    this.fileUsageCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, usage });
    return usage;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function encodeClaudeProjectPath(cwd: string): string {
  // Claude Code encoder: replace `/` with `-`, keep everything else.
  // Examples in ~/.claude/projects/ confirm this scheme (e.g. -Users-yzliu-work-Meridian-Meridian-roles).
  return cwd.replace(/\//g, "-");
}

export function listCodexRolloutFiles(
  root: string,
  pidStartMs: number,
  listDir: (dir: string) => string[]
): string[] {
  // Search the day of pidStart and the day after — covers UTC/local boundary
  // and codex sessions that span midnight. (codex writes UTC in the filename.)
  const startDate = new Date(pidStartMs);
  const candidates: string[] = [];
  for (let offset = 0; offset <= 1; offset += 1) {
    const d = new Date(startDate.getTime() + offset * 24 * 60 * 60 * 1000);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const dayDir = path.join(root, yyyy, mm, dd);
    let names: string[];
    try {
      names = listDir(dayDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        candidates.push(path.join(dayDir, name));
      }
    }
  }
  return candidates;
}

interface CodexSessionMeta {
  id: string | null;
  cwd: string;
  timestampMs: number;
}

export function peekCodexSessionMeta(filePath: string, readHead: (p: string, length: number) => Buffer): CodexSessionMeta | null {
  let head: Buffer;
  try {
    head = readHead(filePath, 65536);
  } catch {
    return null;
  }
  const nl = head.indexOf(0x0a);
  const firstLine = nl >= 0 ? head.subarray(0, nl).toString("utf8") : head.toString("utf8");
  let obj: { type?: string; payload?: { id?: string; cwd?: string; timestamp?: string } };
  try {
    obj = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (obj.type !== "session_meta" || !obj.payload) return null;
  const ts = obj.payload.timestamp ? Date.parse(obj.payload.timestamp) : NaN;
  if (!Number.isFinite(ts) || !obj.payload.cwd) return null;
  return { id: obj.payload.id ?? null, cwd: obj.payload.cwd, timestampMs: ts };
}

// Walk lines from the end; the last `token_count` event carries the cumulative
// totals. We don't need to parse the whole file.
export function parseCodexUsage(buf: Buffer, filePath: string): TokenUsage | null {
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  let sessionId: string | null = null;
  let last: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  } | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    // Cheap pre-filter before JSON.parse.
    if (last === null && !line.includes('"token_count"')) {
      // skip unless we still need session_id
      if (sessionId !== null) continue;
    }
    let obj: {
      type?: string;
      payload?: {
        type?: string;
        id?: string;
        info?: {
          total_token_usage?: {
            input_tokens?: number;
            cached_input_tokens?: number;
            output_tokens?: number;
            reasoning_output_tokens?: number;
            total_tokens?: number;
          };
        };
      };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (last === null && obj.type === "event_msg" && obj.payload?.type === "token_count") {
      const totals = obj.payload?.info?.total_token_usage;
      if (totals) {
        last = {
          input_tokens: toNum(totals.input_tokens),
          cached_input_tokens: toNum(totals.cached_input_tokens),
          output_tokens: toNum(totals.output_tokens),
          reasoning_output_tokens: toNum(totals.reasoning_output_tokens),
          total_tokens: toNum(totals.total_tokens)
        };
      }
    }
    if (obj.type === "session_meta" && obj.payload?.id) {
      sessionId = obj.payload.id;
    }
    if (last && sessionId) break;
  }
  if (!last) return null;
  return {
    source: "codex",
    input_tokens: last.input_tokens,
    cached_input_tokens: last.cached_input_tokens,
    output_tokens: last.output_tokens,
    reasoning_output_tokens: last.reasoning_output_tokens,
    total_tokens: last.total_tokens,
    session_file: filePath,
    session_id: sessionId
  };
}

// Claude's jsonl carries one `usage` block per assistant-message line, and
// each block is the usage for THAT turn (not cumulative). Sum to get the
// session total.
export function parseClaudeUsage(buf: Buffer, filePath: string): TokenUsage | null {
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let sessionId: string | null = null;
  let found = false;
  for (const line of lines) {
    if (!line) continue;
    if (!line.includes('"usage"') && !line.includes('"sessionId"')) continue;
    let obj: {
      sessionId?: string;
      message?: {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (sessionId === null && typeof obj.sessionId === "string") {
      sessionId = obj.sessionId;
    }
    const u = obj.message?.usage;
    if (!u) continue;
    input += toNum(u.input_tokens);
    output += toNum(u.output_tokens);
    cacheRead += toNum(u.cache_read_input_tokens);
    cacheCreate += toNum(u.cache_creation_input_tokens);
    found = true;
  }
  if (!found) return null;
  return {
    source: "claude",
    input_tokens: input,
    // Map Claude's cache_read to codex's cached_input_tokens for a uniform
    // GUI column. Cache-creation is a Claude-only concept; surface it via
    // reasoning_output_tokens repurposed-no, keep a separate field via
    // total_tokens. We expose cache_creation through total_tokens math:
    // total_tokens includes cache_creation per Anthropic billing semantics.
    cached_input_tokens: cacheRead,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output + cacheRead + cacheCreate,
    session_file: filePath,
    session_id: sessionId
  };
}

function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ─── default IO impls ───────────────────────────────────────────────────────

function defaultListDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultReadHead(p: string, length: number): Buffer {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function defaultStat(p: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function defaultGetProcessAttrs(pid: number): ProcessAttrs | null {
  let lstart: string;
  try {
    lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000
    }).trim();
  } catch {
    return null;
  }
  if (!lstart) return null;
  const startMs = Date.parse(lstart);
  if (!Number.isFinite(startMs)) return null;

  // cwd via lsof. May fail on Linux when /proc/<pid>/cwd is not readable due
  // to permissions; on macOS lsof is the standard route. Failure is fine —
  // the collector treats null cwd as "give up on attribution".
  let cwd: string | null = null;
  try {
    const out = execFileSync("lsof", ["-F", "cn", "-a", "-d", "cwd", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000
    });
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("n")) {
        cwd = line.slice(1) || null;
        break;
      }
    }
  } catch {
    // leave cwd null
  }
  return { startMs, cwd };
}
