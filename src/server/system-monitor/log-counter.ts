import * as fs from "node:fs/promises";

export interface LogPatternDefinition {
  key: string;
  pattern: RegExp;
  windowMs: number;
}

export interface LogCounterOptions {
  tailBytes?: number;
  cacheTtlMs?: number;
  maxLogBytes?: number;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  expiresAtMs: number;
  counts: Map<string, number>;
}

export const MONITOR_LOG_PATTERNS: LogPatternDefinition[] = [
  { key: "terminal_cleanup_kill_failed", pattern: /terminal worker cleanup kill failed/i, windowMs: 5 * 60 * 1000 },
  { key: "a2a_registration_retry", pattern: /A2A client registration failed; retrying/i, windowMs: 5 * 60 * 1000 },
  { key: "validator_transport_stall", pattern: /validator_run_transport_stall_codex_alive/i, windowMs: 10 * 60 * 1000 },
  { key: "pm_resolver_started", pattern: /pm_resolver_started/i, windowMs: 30 * 60 * 1000 },
  { key: "watchdog_stall_detected", pattern: /Watchdog detected stalled dispatcher/i, windowMs: 5 * 60 * 1000 },
  { key: "launch_breaker_tripped", pattern: /DispatcherLaunchBreaker tripped/i, windowMs: 5 * 60 * 1000 },
  { key: "worker_breaker_tripped", pattern: /DispatcherWorkerBreaker tripped/i, windowMs: 30 * 60 * 1000 },
  // Emitted once per (dispatch_plan, worker) by the dispatcher watchdog when
  // a worker is stuck on manual_intervention_required and its PM resolver
  // is terminal (failed, or completed-and-escalated). The 24h window keeps
  // the signal visible while operator action is pending; any non-zero count
  // means a dispatcher needs human attention.
  { key: "dispatcher_pm_resolver_exhausted", pattern: /dispatcher_pm_resolver_exhausted/i, windowMs: 24 * 60 * 60 * 1000 },
  { key: "lifecycle_auto_force_complete", pattern: /lifecycle_auto_force_complete/i, windowMs: 24 * 60 * 60 * 1000 },
  // Hub log markers shipped by meridian-hub PR #90 (storm three-windows fix).
  // Routed to system-monitor cards G2/G3/G4 to verify the fix in production.
  { key: "rehydrate_orphan_reaped", pattern: /rehydrate_orphan_reaped/i, windowMs: 24 * 60 * 60 * 1000 },
  { key: "rehydrate_probe_succeeded_after_retry", pattern: /rehydrate_probe_succeeded_after_retry/i, windowMs: 24 * 60 * 60 * 1000 },
  { key: "rehydrate_pid_dead_pruned", pattern: /rehydrate_pid_dead_pruned/i, windowMs: 24 * 60 * 60 * 1000 }
];

/** Time window after a Hub-router-init line inside which "is not registered" errors are attributed to a fresh rehydrate. */
export const HUB_RESTART_WINDOW_MS = 60 * 1000;

/** Default analysis window (events older than this are not counted). */
const POST_INIT_ANALYSIS_WINDOW_MS = 24 * 60 * 60 * 1000;

const HUB_ROUTER_INIT_PATTERN = /Hub router state initialized/i;
const IS_NOT_REGISTERED_PATTERN = /thread_id=\S+ is not registered/i;

export class LogPatternCounter {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: LogCounterOptions = {}) {}

  async count(filePath: string, nowMs = Date.now()): Promise<Map<string, number>> {
    const tailBytes = this.options.tailBytes ?? Number(process.env.MONITOR_LOG_TAIL_BYTES ?? 2 * 1024 * 1024);
    const cacheTtlMs = this.options.cacheTtlMs ?? 30_000;
    const maxLogBytes = this.options.maxLogBytes ?? 1024 * 1024 * 1024;
    const stat = await fs.stat(filePath);

    if (stat.size > maxLogBytes) {
      throw new Error(`Refusing to scan monitor log larger than ${maxLogBytes} bytes: ${filePath}`);
    }

    const cached = this.cache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.expiresAtMs > nowMs) {
      return new Map(cached.counts);
    }

    const text = await readTail(filePath, stat.size, tailBytes);
    const counts = countPatternsInText(text, nowMs);
    counts.set("is_not_registered_post_hub_init", countIsNotRegisteredPostHubInit(text, nowMs));
    this.cache.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      expiresAtMs: nowMs + cacheTtlMs,
      counts
    });
    return new Map(counts);
  }
}

/**
 * Count `thread_id=X is not registered` hub-log lines whose timestamp falls
 * within `restartWindowMs` AFTER a `Hub router state initialized` line.
 *
 * This is the load-bearing end-state check for the storm fix shipped in
 * meridian-hub PR #90 (the "three windows" architectural fix). If this
 * count stays at zero, the spawn-then-persist race + rehydrate one-shot
 * probe + missing-shutdown-flush windows are all closed in production.
 * A non-zero count is the trigger to investigate §C-2 candidate (d) —
 * a fourth code path that emits "is not registered" without going through
 * the rehydration race the PR #90 fixes addressed.
 */
export function countIsNotRegisteredPostHubInit(
  text: string,
  nowMs: number,
  restartWindowMs = HUB_RESTART_WINDOW_MS,
  windowMs = POST_INIT_ANALYSIS_WINDOW_MS
): number {
  const lines = text.split(/\r?\n/);
  const initTimestamps: number[] = [];

  // First pass: collect Hub-router-init timestamps inside the analysis window.
  for (const line of lines) {
    if (!line || !HUB_ROUTER_INIT_PATTERN.test(line)) {
      continue;
    }
    const t = extractLineTimeMs(line);
    if (t === null || nowMs - t > windowMs) {
      continue;
    }
    initTimestamps.push(t);
  }

  if (initTimestamps.length === 0) {
    return 0;
  }
  initTimestamps.sort((a, b) => a - b);

  // Second pass: count is-not-registered lines that follow any init within
  // restartWindowMs. A single init can attribute multiple subsequent errors;
  // a single error attributes to at most one init (the nearest prior).
  let count = 0;
  for (const line of lines) {
    if (!line || !IS_NOT_REGISTERED_PATTERN.test(line)) {
      continue;
    }
    const t = extractLineTimeMs(line);
    if (t === null || nowMs - t > windowMs) {
      continue;
    }
    // Find the most-recent init that occurred at or before t.
    let lo = 0;
    let hi = initTimestamps.length - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const initT = initTimestamps[mid];
      if (initT === undefined) {
        break;
      }
      if (initT <= t) {
        candidate = initT;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (candidate !== -1 && t - candidate <= restartWindowMs) {
      count += 1;
    }
  }

  return count;
}

export function countPatternsInText(text: string, nowMs: number, patterns = MONITOR_LOG_PATTERNS): Map<string, number> {
  const counts = new Map(patterns.map((pattern) => [pattern.key, 0]));
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line) {
      continue;
    }
    for (const pattern of patterns) {
      if (!pattern.pattern.test(line)) {
        continue;
      }
      // A matching line without a parseable timestamp cannot be window-judged,
      // so don't count it. The previous behavior over-counted: every match
      // inside the read tail with no ISO/numeric time field accumulated into
      // the windowed indicator, even when the events were hours old (e.g.
      // C1 in PR #236 still reported thousands of "Terminal-cleanup kill
      // failed" events after the matcher fix landed because the pre-fix log
      // lines had no timestamps). Skipping here is the conservative answer;
      // the upstream fix is to emit timestamps from the logger.
      const lineTimeMs = extractLineTimeMs(line);
      if (lineTimeMs === null || nowMs - lineTimeMs > pattern.windowMs) {
        continue;
      }
      counts.set(pattern.key, (counts.get(pattern.key) ?? 0) + 1);
    }
  }

  return counts;
}

async function readTail(filePath: string, fileSize: number, tailBytes: number): Promise<string> {
  const start = Math.max(0, fileSize - tailBytes);
  const length = fileSize - start;
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function extractLineTimeMs(line: string): number | null {
  const iso = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (iso) {
    const parsed = Date.parse(iso[0]);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const numeric = line.match(/"(?:time|timestamp)"\s*:\s*(\d{10,13})/);
  if (numeric) {
    const parsed = Number.parseInt(numeric[1] ?? "", 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }

  return null;
}
