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
  stat?: (p: string) => { mtimeMs: number; size: number; birthtimeMs?: number } | null;
  codexSessionsRoot?: string;     // default: ~/.codex/sessions
  claudeProjectsRoot?: string;    // default: ~/.claude/projects
  now?: () => Date;
}

interface FileUsageCacheEntry {
  mtimeMs: number;
  size: number;
  usage: TokenUsage;
}

interface PidResolution {
  filePath: string | null;
  // ms-since-epoch when the most recent resolution attempt ran. Used only for
  // negative entries to decide whether the TTL has elapsed; positive entries
  // are kept forever regardless.
  attemptedAtMs: number;
}

// Codex creates the rollout file shortly after process start (we observed
// delays up to ~45s while the first turn warms up). Allow a generous window
// to avoid false negatives. False positives are still bounded by cwd match.
const CODEX_SESSION_OPEN_WINDOW_MS = 5 * 60 * 1000;

// Claude similarly takes a few seconds to materialise its project jsonl on
// first turn. Same window logic.
const CLAUDE_SESSION_OPEN_WINDOW_MS = 5 * 60 * 1000;

// Negative pid→file resolutions used to bypass the cache entirely so a freshly
// spawned codex (which writes its rollout ~14s after process start) would
// be re-resolved on each poll. That contract is preserved, but with a TTL: a
// negative result is cached for NEGATIVE_RESOLUTION_TTL_MS before the next
// re-resolution runs. Otherwise, every orphan/transient PID (short stateless
// validators, codex children mid-warmup, recently-died PIDs not yet evicted)
// pays the full ps+lsof exec + N×64KB-rollout-head-read cost on EVERY poll.
// At K open GUI tabs × M unresolved PIDs × N rollouts per day, that fan-out
// saturates syspolicyd/trustd and stalls system-wide exec — root-caused
// 2026-05-21 (see learnings/token-usage-orphan-pid-rollout-fanout-storm.md).
const NEGATIVE_RESOLUTION_TTL_MS = 30_000;

export class TokenUsageCollector {
  private readonly deps: Required<Omit<CollectorDeps, "codexSessionsRoot" | "claudeProjectsRoot">> & {
    codexSessionsRoot: string;
    claudeProjectsRoot: string;
  };

  // pid -> { filePath, attemptedAtMs }. Positive entries (filePath !== null)
  // are kept for the PID's lifetime — codex/claude pids do not switch sessions
  // mid-flight. Negative entries (filePath === null) are kept until the TTL
  // elapses, then re-resolved; this preserves the rollout-warmup retry
  // contract while bounding repeated ps+lsof+N-rollout-scan cost per orphan
  // PID to O(1 / TTL) instead of O(every poll).
  private readonly pidToFile = new Map<number, PidResolution>();

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

  lookup(pid: number, agentType: "codex" | "claude", command?: string): TokenUsage | null {
    // Positive resolutions are cached for the PID's lifetime — codex/claude
    // pids don't switch sessions mid-flight. Negative resolutions are cached
    // for NEGATIVE_RESOLUTION_TTL_MS, then re-resolved: the rollout-warmup
    // retry contract is preserved (codex creates the rollout ~14s after spawn,
    // so the first poll often legitimately misses), but a stable orphan PID
    // can't keep paying the full ps+lsof+N-rollout-scan cost every poll. At
    // K open GUI tabs × M orphan PIDs × N rollouts/day, that fan-out was
    // saturating syspolicyd/trustd and stalling system-wide exec.
    //
    // `command` is the live argv. For codex it disambiguates `codex exec --json`
    // (stateless, source="exec" rollouts) from interactive/agentapi-bound
    // codex (source="cli" rollouts). Without this filter, an interactive
    // codex that hasn't written its rollout yet would mis-attribute to a
    // nearby stateless exec rollout in the same cwd.
    const nowMs = this.deps.now().getTime();
    const cached = this.pidToFile.get(pid);

    let filePath: string | null;
    const cachedIsFresh = cached !== undefined && (
      cached.filePath !== null ||
      (nowMs - cached.attemptedAtMs) < NEGATIVE_RESOLUTION_TTL_MS
    );
    if (cachedIsFresh) {
      filePath = cached!.filePath;
    } else {
      const attrs = this.deps.getProcessAttrs(pid);
      filePath = attrs
        ? agentType === "codex"
          ? this.resolveCodexSessionFile(attrs, command ?? "")
          : this.resolveClaudeSessionFile(attrs)
        : null;
      this.pidToFile.set(pid, { filePath, attemptedAtMs: nowMs });
    }

    if (!filePath) return null;
    return this.readUsage(filePath, agentType);
  }

  // codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-with-dashes>-<uuid>.jsonl.
  // The first line is `session_meta` with the canonical session start
  // timestamp, cwd, and source ("exec" for stateless `codex exec --json`,
  // "cli" for interactive TUI / agentapi-bound). We pick the matching
  // session file by:
  //   1. listing rollout files whose path date is on or after pid_start_date,
  //   2. peeking the session_meta line for each candidate,
  //   3. requiring source ↔ argv match (live argv has `exec` ⇒ source="exec";
  //      otherwise ⇒ source="cli") AND cwd match AND session_meta.timestamp
  //      within [start - 1s, start + window],
  //   4. among survivors, choosing the one with the smallest |meta.ts - pid.start|.
  //
  // The source-↔-argv filter matters when multiple codex sessions share a
  // cwd. The hub can fork every codex from the same configured work root regardless of
  // whether it's agentapi-bound (interactive `cli`) or a stateless
  // `codex exec --json` (`exec`) validator/pm-resolver call. Live obs
  // 2026-05-17 (agent-dispatcher-00f759ff): codex_01 dispatcher (pid 77365)
  // and codex_02 worker (pid 77505) hadn't yet processed a turn, so no
  // `source=cli` rollouts existed. A stateless exec call at 14:48:09
  // wrote a `source=exec` rollout in the same cwd. Without the source
  // filter, all interactive shims and the stateless pair (77539/77540)
  // collapsed onto that one rollout's totals — every row showed
  // identical 92.6k tokens. With the filter, interactive shims correctly
  // resolve to null (no rollout yet) and only the stateless exec pair
  // shows its real totals.
  private resolveCodexSessionFile(attrs: ProcessAttrs, command: string): string | null {
    if (!attrs.cwd) return null;

    const resumeSessionId = extractCodexResumeSessionId(command);
    if (resumeSessionId) {
      const resumed = this.resolveCodexSessionFileById(attrs, resumeSessionId);
      if (resumed) {
        return resumed;
      }
    }

    const wantSource: "exec" | "cli" = isCodexExecCommand(command) ? "exec" : "cli";
    const candidates = listCodexRolloutFiles(this.deps.codexSessionsRoot, attrs.startMs, this.deps.listDir);
    let best: { path: string; delta: number } | null = null;
    for (const filePath of candidates) {
      const meta = peekCodexSessionMeta(filePath, this.deps.readHead);
      if (!meta) continue;
      if (meta.cwd !== attrs.cwd) continue;
      // Source filter: only enforce when the rollout actually carries one.
      // Older rollout schemas may omit `source`; allow them through so we
      // don't regress historical data.
      if (meta.source !== null && meta.source !== wantSource) continue;
      if (meta.timestampMs < attrs.startMs - 1_000) continue;
      if (meta.timestampMs > attrs.startMs + CODEX_SESSION_OPEN_WINDOW_MS) continue;
      const delta = Math.abs(meta.timestampMs - attrs.startMs);
      if (best === null || delta < best.delta) {
        best = { path: filePath, delta };
      }
    }
    return best?.path ?? null;
  }

  private resolveCodexSessionFileById(attrs: ProcessAttrs, sessionId: string): string | null {
    if (!attrs.cwd) return null;

    const candidates = listCodexRolloutFilesBySessionId(
      this.deps.codexSessionsRoot,
      sessionId,
      this.deps.listDir
    );
    let best: { path: string; mtimeMs: number } | null = null;
    for (const filePath of candidates) {
      const meta = peekCodexSessionMeta(filePath, this.deps.readHead);
      if (!meta || meta.id !== sessionId || meta.cwd !== attrs.cwd) {
        continue;
      }
      const st = this.deps.stat(filePath);
      const mtimeMs = st?.mtimeMs ?? meta.timestampMs;
      if (best === null || mtimeMs > best.mtimeMs) {
        best = { path: filePath, mtimeMs };
      }
    }
    return best?.path ?? null;
  }

  // claude writes ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, one
  // jsonl per session. The encoded-cwd is the absolute cwd with `/` replaced
  // by `-`. We list jsonl files in that directory whose birthtime falls inside
  // the open window around pid.startMs and pick the closest by birthtime.
  //
  // Why birthtime, not mtime: an active claude session is rewritten on every
  // turn, so its mtime drifts forward indefinitely. A session that started
  // 23h ago and is still being typed in has mtime ≈ now and mtime - startMs
  // ≈ 23h, far outside the 5-min open window — so it would resolve to null
  // and never show token totals. Birthtime is the session-creation moment and
  // stays constant; matching against it is robust across session lifetimes.
  // On platforms where birthtime is unavailable (some Linux filesystems),
  // we fall back to mtime to preserve previous behavior.
  private resolveClaudeSessionFile(attrs: ProcessAttrs): string | null {
    if (!attrs.cwd) return null;
    const dir = path.join(this.deps.claudeProjectsRoot, encodeClaudeProjectPath(attrs.cwd));
    let entries: string[];
    try {
      entries = this.deps.listDir(dir);
    } catch {
      return null;
    }

    let best: { path: string; createdMs: number } | null = null;
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      const st = this.deps.stat(full);
      if (!st) continue;
      const createdMs = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
      // Session file should be created at or after pid start; tolerate small
      // clock skew. Outside [start - 1s, start + window] can't be this session.
      if (createdMs < attrs.startMs - 1_000) continue;
      if (createdMs > attrs.startMs + CLAUDE_SESSION_OPEN_WINDOW_MS) continue;
      if (best === null || Math.abs(createdMs - attrs.startMs) < Math.abs(best.createdMs - attrs.startMs)) {
        best = { path: full, createdMs };
      }
    }
    return best?.path ?? null;
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

// codex rollout filenames embed the session start timestamp as
// `rollout-YYYY-MM-DDTHH-mm-ss-<uuid>.jsonl` (dashes for the time portion in
// place of colons). Some Codex builds write this timestamp as UTC, while
// current live rollouts on this host write local wall time. The on-disk
// `session_meta.payload.timestamp` remains the authoritative UTC timestamp;
// filename parsing is only a pre-read prune to avoid open()/readSync across
// dozens of clearly out-of-window rollouts per unresolved PID.
const ROLLOUT_FILENAME_TS_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/;

export function listCodexRolloutFiles(
  root: string,
  pidStartMs: number,
  listDir: (dir: string) => string[],
  options: { localTimezoneOffsetMinutes?: number } = {}
): string[] {
  // Search the day of pidStart and the day after — covers UTC/local boundary
  // and codex sessions that span midnight.
  const startDate = new Date(pidStartMs);
  const minTsMs = pidStartMs - 1_000;
  const maxTsMs = pidStartMs + CODEX_SESSION_OPEN_WINDOW_MS;
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
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      // Filename-window prune. peekCodexSessionMeta enforces the same window
      // against meta.timestampMs after reading the file head; mirroring it
      // here against the filename's encoded timestamp drops the I/O entirely
      // for out-of-window candidates. Because the filename timestamp may be
      // UTC or local wall time, only prune when every plausible interpretation
      // falls outside the window. Non-conforming filenames (e.g. test fixtures
      // named `rollout-A.jsonl`) fall through to peek by design.
      if (!codexRolloutFilenameOverlapsWindow(name, minTsMs, maxTsMs, options.localTimezoneOffsetMinutes)) continue;
      candidates.push(path.join(dayDir, name));
    }
  }
  return candidates;
}

export function listCodexRolloutFilesBySessionId(
  root: string,
  sessionId: string,
  listDir: (dir: string) => string[]
): string[] {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId || trimmedSessionId.includes("/") || trimmedSessionId.includes("\\")) {
    return [];
  }

  const out: string[] = [];
  let years: string[];
  try {
    years = listDir(root);
  } catch {
    return out;
  }

  for (const year of years.filter((name) => /^\d{4}$/.test(name))) {
    const yearDir = path.join(root, year);
    let months: string[];
    try {
      months = listDir(yearDir);
    } catch {
      continue;
    }
    for (const month of months.filter((name) => /^\d{2}$/.test(name))) {
      const monthDir = path.join(yearDir, month);
      let days: string[];
      try {
        days = listDir(monthDir);
      } catch {
        continue;
      }
      for (const day of days.filter((name) => /^\d{2}$/.test(name))) {
        const dayDir = path.join(monthDir, day);
        let names: string[];
        try {
          names = listDir(dayDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
          if (!name.includes(trimmedSessionId)) continue;
          out.push(path.join(dayDir, name));
        }
      }
    }
  }
  return out;
}

export function codexRolloutFilenameOverlapsWindow(
  name: string,
  minTsMs: number,
  maxTsMs: number,
  localTimezoneOffsetMinutes?: number
): boolean {
  const candidates = codexRolloutFilenameTimestampCandidates(name, localTimezoneOffsetMinutes);
  if (candidates.length === 0) return true;
  return candidates.some((tsMs) => tsMs >= minTsMs && tsMs <= maxTsMs);
}

function codexRolloutFilenameTimestampCandidates(name: string, localTimezoneOffsetMinutes?: number): number[] {
  const m = ROLLOUT_FILENAME_TS_RE.exec(name);
  if (!m) return [];

  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const utcMs = Date.UTC(year, monthIndex, day, hour, minute, second);
  if (!Number.isFinite(utcMs)) return [];

  const localMs = localTimezoneOffsetMinutes === undefined
    ? new Date(year, monthIndex, day, hour, minute, second).getTime()
    : utcMs + localTimezoneOffsetMinutes * 60_000;

  if (!Number.isFinite(localMs) || localMs === utcMs) return [utcMs];
  return [utcMs, localMs];
}

interface CodexSessionMeta {
  id: string | null;
  cwd: string;
  timestampMs: number;
  // "exec" for stateless `codex exec --json`, "cli" for interactive (TUI /
  // agentapi-bound). Older rollout schemas may not include this field; null
  // means "unknown, do not filter on source".
  source: "exec" | "cli" | null;
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
  let obj: { type?: string; payload?: { id?: string; cwd?: string; timestamp?: string; source?: string } };
  try {
    obj = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (obj.type !== "session_meta" || !obj.payload) return null;
  const ts = obj.payload.timestamp ? Date.parse(obj.payload.timestamp) : NaN;
  if (!Number.isFinite(ts) || !obj.payload.cwd) return null;
  const rawSource = obj.payload.source;
  const source: "exec" | "cli" | null = rawSource === "exec" || rawSource === "cli" ? rawSource : null;
  return { id: obj.payload.id ?? null, cwd: obj.payload.cwd, timestampMs: ts, source };
}

// Detect `codex exec` invocations (e.g. `codex exec --json -c ...`). The
// `exec` subcommand is the canonical stateless one-shot mode the Meridian
// Hub spawns for validators and PM-resolvers. Live argv that contains it
// must only match rollouts with source="exec"; everything else must match
// source="cli" (interactive / agentapi-bound).
export function isCodexExecCommand(command: string): boolean {
  return /(?:^|[\s/])codex\s+exec(?:\s|$)/.test(command);
}

export function extractCodexResumeSessionId(command: string): string | null {
  const match = command.match(/(?:^|[\s/])codex\s+exec\s+resume\s+([^\s]+)(?:\s|$)/);
  return match?.[1]?.trim() || null;
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

function defaultStat(p: string): { mtimeMs: number; size: number; birthtimeMs?: number } | null {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs };
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
