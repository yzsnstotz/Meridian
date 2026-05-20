import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { HUB_SOCKET_PATH } from "../../config";
import type { Logger } from "../../roles/base-role";
import { buildProcessSnapshot, type ProcessSnapshotEntry, type ProcessHandlersOptions } from "../process-handlers";
import { probeHubSocket, type HubProbeResult } from "./hub-probe";
import { inspectLifecycle } from "./lifecycle-anomaly";
import { LogPatternCounter } from "./log-counter";
import { statFileSafe, statFilesystemFree, type MonitorFileStat, type MonitorFsStat } from "./system-resources";

export type SystemMonitorProcess = ProcessSnapshotEntry;
export type IndicatorState = "green" | "yellow" | "red" | "unknown" | "info";

export interface SystemMonitorThresholds {
  yellow?: number | string;
  red?: number | string;
}

export interface SystemMonitorIndicatorItem {
  label: string;
  detail?: string;
  href?: string;
}

export interface SystemMonitorIndicator {
  id: string;
  group: string;
  name: string;
  value: number | string | null;
  unit: string | null;
  state: IndicatorState;
  thresholds?: SystemMonitorThresholds;
  source_learning: string;
  detail?: string;
  items?: SystemMonitorIndicatorItem[];
}

export interface SystemMonitorSnapshot {
  polled_at: string;
  any_red: boolean;
  indicators: SystemMonitorIndicator[];
  errors: string[];
}

export interface SystemMonitorHandlers {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export interface BuildSystemMonitorOptions {
  stateStore: ProcessHandlersOptions["stateStore"];
  log?: Logger;
  processSnapshot?: () => Promise<SystemMonitorProcess[]>;
  now?: () => Date;
  probeHub?: () => Promise<HubProbeResult>;
  statFile?: (filePath: string) => Promise<MonitorFileStat | null>;
  statFs?: (filePath: string) => Promise<MonitorFsStat>;
  countLogPatterns?: (filePath: string, nowMs: number) => Promise<Map<string, number>>;
  runtime?: MonitorRuntimeState;
  hubSocketPath?: string;
  hubStatePath?: string;
  rolesLogPath?: string;
  hubLogPath?: string;
  fnmMultishellsPath?: string;
  fetchAgentapiInstanceIndex?: ProcessHandlersOptions["fetchAgentapiInstanceIndex"];
}

interface MonitorRuntimeState {
  hubFailureStreak: number;
  hubLatencies: number[];
  previousProcessTotals: Map<string, number>;
  previousProcessSampleAtMs: number | null;
  previousFileStats: Map<string, { size: number; sampledAtMs: number }>;
}

const DEFAULT_HUB_STATE_PATH = process.env.MERIDIAN_HUB_STATE_PATH
  ?? "/Users/yzliu/work/Meridian/.meridian/state.json";
const DEFAULT_ROLES_LOG_PATH = process.env.MERIDIAN_ROLES_LOG_PATH
  ?? path.resolve(process.cwd(), "logs/meridian-roles.out.log");
const DEFAULT_HUB_LOG_PATH = process.env.MERIDIAN_HUB_LOG_PATH
  ?? path.join(process.env.LOG_DIR ?? "/var/log/hub", "hub.log");
// fnm caches a per-shell symlink dir under ~/.local/state/fnm_multishells/.
// Every codex/agentapi spawn through fnm adds an entry. Without rotation it
// saturates at 65535 (the macOS APFS link-count cap) and shell init (`eval
// "$(fnm env)"`) hangs 10–30s on every new terminal. D6 stat-monitors the
// directory inode size as a fast proxy for entry count — no enumeration.
const DEFAULT_FNM_MULTISHELLS_PATH = process.env.MERIDIAN_FNM_MULTISHELLS_PATH
  ?? path.join(process.env.HOME ?? "/Users/yzliu", ".local/state/fnm_multishells");

const defaultLogCounter = new LogPatternCounter();

export function createSystemMonitorHandlers(options: BuildSystemMonitorOptions): SystemMonitorHandlers {
  const runtime: MonitorRuntimeState = {
    hubFailureStreak: 0,
    hubLatencies: [],
    previousProcessTotals: new Map(),
    previousProcessSampleAtMs: null,
    previousFileStats: new Map()
  };

  return {
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/api/system-monitor") {
        return false;
      }

      try {
        const snapshot = await buildSystemMonitorSnapshot({ ...options, runtime });
        writeJson(response, 200, snapshot);
      } catch (error) {
        options.log?.warn?.("/api/system-monitor failed", {
          error: getErrorMessage(error)
        });
        writeJson(response, 500, { error: "system monitor snapshot failed" });
      }
      return true;
    }
  };
}

export async function buildSystemMonitorSnapshot(options: BuildSystemMonitorOptions): Promise<SystemMonitorSnapshot> {
  const now = options.now?.() ?? new Date();
  const nowMs = now.getTime();
  const runtime = options.runtime;
  const errors: string[] = [];
  const statFile = options.statFile ?? statFileSafe;
  const statFs = options.statFs ?? statFilesystemFree;
  const hubSocketPath = options.hubSocketPath ?? HUB_SOCKET_PATH;
  const hubStatePath = options.hubStatePath ?? DEFAULT_HUB_STATE_PATH;
  const rolesLogPath = options.rolesLogPath ?? DEFAULT_ROLES_LOG_PATH;
  const hubLogPath = options.hubLogPath ?? DEFAULT_HUB_LOG_PATH;
  const fnmMultishellsPath = options.fnmMultishellsPath ?? DEFAULT_FNM_MULTISHELLS_PATH;

  const [
    processes,
    hubProbe,
    lifecycle,
    hubStateStat,
    rolesLogStat,
    hubLogStat,
    diskStat,
    logCounts,
    hubLogCounts,
    fnmMultishellsStat
  ] = await Promise.all([
    loadProcesses(options, errors),
    loadHubProbe(options, hubSocketPath, errors),
    inspectLifecycle(options.stateStore, nowMs),
    loadStat(statFile, hubStatePath, errors),
    loadStat(statFile, rolesLogPath, errors),
    loadStat(statFile, hubLogPath, errors),
    loadFsStat(statFs, rolesLogPath, errors),
    loadLogCounts(options, rolesLogPath, nowMs, errors),
    loadLogCounts(options, hubLogPath, nowMs, errors),
    loadStat(statFile, fnmMultishellsPath, errors)
  ]);
  errors.push(...lifecycle.errors);

  const indicators: SystemMonitorIndicator[] = [];
  const leakProcesses = processes.filter((process) => process.is_leak);
  const leakedTokenTotal = sumLeakedTokens(leakProcesses);
  const tokenVelocity = computeTokenVelocity(processes, nowMs, runtime);
  const completedAliveProcesses = processes.filter((process) =>
    (process.agent_type === "codex" || process.agent_type === "claude")
    && process.thread_id
    && lifecycle.terminalThreadIds.has(process.thread_id)
  );

  push(indicators, aboveIndicator("A1", "process_pressure", "Leaked process count", leakProcesses.length, "processes", 1, 3, "dispatcher/circuit-breaker-defense-in-depth-and-real-pause.md", processItems(leakProcesses)));
  push(indicators, aboveIndicator("A2", "process_pressure", "Leaked process token total", leakedTokenTotal, "tokens", 10_000, 100_000, "dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md", tokenSessionItems(leakProcesses)));
  push(indicators, aboveIndicator("A3", "process_pressure", "Per-process token velocity", Math.round(tokenVelocity), "tokens/min", 5_000, 50_000, "dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md", tokenProcessItems(processes)));
  push(indicators, aboveIndicator("A4", "process_pressure", "Orphan dispatcher-completed codex CLIs", completedAliveProcesses.length, "processes", 1, 5, "dispatcher/settle-time-terminal-thread-cleanup-gap.md", processItems(completedAliveProcesses)));
  // A5 — codex app-server orphans from the model-catalog RPC dance
  // (src/shared/model-catalog.ts::listCodexModelsViaAppServer). Codex
  // app-server does NOT exit on stdin EOF, so every model/list call without
  // an outer `timeout` permanently leaks ~3 processes (shell + node shim +
  // native rust binary). Each spawn re-validates the unsigned NPM codex
  // binary through syspolicyd, pegging that daemon at ~80% CPU and
  // stalling every fork/exec on the box. The `app-server` argv suffix is
  // unique to this path — agentapi-managed codex spawns never use it —
  // so filtering on it cleanly isolates the leak.
  const modelCatalogLeakProcesses = processes.filter(
    (process) => process.agent_type === "codex" && /(?:^|\s)app-server(?:\s|$)/.test(process.command)
  );
  push(indicators, aboveIndicator("A5", "process_pressure", "codex app-server orphans (model-catalog leak)", modelCatalogLeakProcesses.length, "processes", 2, 5, "codex-app-server-no-shutdown-on-stdin-eof.md", processItems(modelCatalogLeakProcesses)));

  const hubFailureStreak = updateHubRuntime(hubProbe, runtime);
  push(indicators, hubReachabilityIndicator(hubProbe, hubFailureStreak));
  const p50 = computeP50(runtime?.hubLatencies ?? (hubProbe.reachable && hubProbe.latency_ms !== null ? [hubProbe.latency_ms] : []));
  push(indicators, p50 === null
    ? unknownIndicator("B2", "hub_health", "Hub ping latency p50", "ms", "meridian/hub-list-state-persist-serialization.md")
    : aboveIndicator("B2", "hub_health", "Hub ping latency p50", p50, "ms", 500, 2_000, "meridian/hub-list-state-persist-serialization.md"));
  push(indicators, fileSizeIndicator("B3", "hub_health", "Hub state.json size", hubStateStat, "bytes", 10 * 1024 * 1024, 50 * 1024 * 1024, "meridian/hub-handlelist-sync-persist-serialization.md"));
  push(indicators, mtimeStalenessIndicator("B4", "hub_health", "Hub log mtime staleness", hubLogStat, nowMs, 60, 300, "dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md"));

  push(indicators, aboveIndicator("C1", "loop_detectors", "Terminal-cleanup kill-failure rate", logCount(logCounts, "terminal_cleanup_kill_failed"), "events", 1, 10, "dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md"));
  push(indicators, aboveIndicator("C2", "loop_detectors", "A2A hub-registration retry rate", logCount(logCounts, "a2a_registration_retry"), "events", 3, 30, "dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md"));
  push(indicators, aboveIndicator("C3", "loop_detectors", "Validator transport-stall rate", logCount(logCounts, "validator_transport_stall"), "events", 3, 6, "dispatcher/validator-transport-stall-respawn-storm.md"));
  push(indicators, aboveIndicator("C4", "loop_detectors", "PM resolver respawn cadence", logCount(logCounts, "pm_resolver_started"), "events", 3, 5, "dispatcher/pm-resolver-transport-stall-respawn-storm.md"));
  push(indicators, aboveIndicator("C5", "loop_detectors", "Watchdog stall-detection rate", logCount(logCounts, "watchdog_stall_detected"), "events", 10, 50, "dispatcher/run-tool-ipc-bridge-error-spawn-storm.md"));
  push(indicators, aboveIndicator("C6", "loop_detectors", "Launch-breaker trips", logCount(logCounts, "launch_breaker_tripped"), "events", 1, 3, "dispatcher/circuit-breaker-defense-in-depth-and-real-pause.md"));
  push(indicators, aboveIndicator("C7", "loop_detectors", "Worker-breaker trips", logCount(logCounts, "worker_breaker_tripped"), "events", 1, 3, "dispatcher/circuit-breaker-defense-in-depth-and-real-pause.md"));

  push(indicators, belowIndicator("D1", "system_resources", "Disk free on log volume", diskStat.freeBytes, "bytes", 5 * 1024 * 1024 * 1024, 1024 * 1024 * 1024, "session/2026-05-18-enospc.md"));
  push(indicators, fileSizeIndicator("D2", "system_resources", "meridian-roles log size", rolesLogStat, "bytes", 100 * 1024 * 1024, 500 * 1024 * 1024, "session/2026-05-18-enospc.md"));
  push(indicators, aboveIndicator("D3", "system_resources", "meridian-roles log growth rate", Math.round(computeGrowthRate(rolesLogPath, rolesLogStat, nowMs, runtime)), "bytes/s", 20 * 1024, 200 * 1024, "session/2026-05-18-enospc.md"));
  push(indicators, fileSizeIndicator("D4", "system_resources", "meridian hub log size", hubLogStat, "bytes", 100 * 1024 * 1024, 500 * 1024 * 1024, "session/2026-05-18-enospc.md"));
  push(indicators, aboveIndicator("D5", "system_resources", "meridian hub log growth rate", Math.round(computeGrowthRate(hubLogPath, hubLogStat, nowMs, runtime)), "bytes/s", 20 * 1024, 200 * 1024, "hub-list-zombie-eviction-and-probe-storm.md"));
  // D6 — fnm multishells dir block size, stat'd via inode size (no enumeration).
  // Saturation cap on macOS APFS is 65535 entries (~85 MB block); this caused
  // 30s terminal spawns on 2026-05-20. Hourly launchd agent
  // (com.meridian.fnm-multishell-clean) rotates above 1 MB.
  push(indicators, fileSizeIndicator("D6", "system_resources", "fnm multishells dir block size", fnmMultishellsStat, "bytes", 1024 * 1024, 10 * 1024 * 1024, "maintenance-hub-restart-pm2-and-socket-race.md"));

  push(indicators, aboveIndicator("E1", "lifecycle_anomaly", "Active role with all-terminal plan", lifecycle.activeAllTerminalPlans, "roles", 1, 3, "dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md", lifecycle.activeAllTerminalPlanItems));
  push(indicators, aboveIndicator("E2", "lifecycle_anomaly", "Workers stuck blocked > 30 min", lifecycle.blockedWorkersOver30m, "workers", 1, 3, "dispatcher/watchdog-pm-evicted-failed-seenissuekeys-cache-respawn-gap.md", lifecycle.blockedWorkerItems));
  push(indicators, aboveIndicator("E3", "lifecycle_anomaly", "Workers stuck awaiting_validation > 30 min without validator", lifecycle.awaitingValidationWithoutValidatorOver30m, "workers", 1, 3, "dispatcher/validator-thread-error-status-not-classified-as-inactive.md", lifecycle.awaitingValidationWithoutValidatorItems));
  push(indicators, aboveIndicator("E4", "lifecycle_anomaly", "Cross-plan running thread_id collision", lifecycle.runningThreadCollisions, "collisions", 1, 1, "dispatcher/cross-plan-dispatcher-thread-id-reservation-gap.md", lifecycle.runningThreadCollisionItems));
  push(indicators, aboveIndicator("E5", "lifecycle_anomaly", "Dispatchers idling on open HUMAN row", lifecycle.humanGateIdlingDispatchers, "roles", 1, 3, "dispatcher/dispatcher-human-row-open-gate-idle.md", lifecycle.humanGateIdlingDispatcherItems));
  push(indicators, aboveIndicator("E6", "lifecycle_anomaly", "Blocked HUMAN row with pending downstream (dep loop)", lifecycle.blockedHumanGateLoops, "roles", 1, 1, "dispatcher/dispatcher-human-row-open-gate-idle.md", lifecycle.blockedHumanGateLoopItems));

  push(indicators, infoIndicator("F1", "wedge_staleness", "Pre-existing test-suite failures on main", "not checked", null, "meridian/targeted-test-invocation.md"));
  push(indicators, infoIndicator("F2", "wedge_staleness", "Restart-hold paused dispatcher count", lifecycle.pausedDispatchers, "dispatchers", "dispatcher/circuit-breaker-defense-in-depth-and-real-pause.md", lifecycle.pausedDispatcherItems));
  push(indicators, infoIndicator("F3", "wedge_staleness", "Stateless-mode validator card count", lifecycle.statelessValidatorCards, "validators", "dispatcher/validator-thread-error-status-not-classified-as-inactive.md", lifecycle.statelessValidatorItems));

  push(indicators, infoIndicator("G1", "cure_metrics", "Auto-force-complete events (24h)", logCount(logCounts, "lifecycle_auto_force_complete"), "events", "storm-recurrence-architectural-root-cause.md"));
  // Three new cure_metrics cards (G2/G3/G4) track the storm-fix shipped by
  // meridian-hub PR #90. Each maps to one of the three windows now closed:
  //   - G2 rehydrate_orphan_reaped       → Window B reap path firing in prod
  //   - G3 rehydrate_probe_succeeded_after_retry → Window B retry budget being used
  //   - G4 rehydrate_pid_dead_pruned     → Baseline restart cleanup
  // E7 is the load-bearing end-state indicator: "is not registered" within
  // 60s of any "Hub router state initialized" line. Non-zero here means
  // §C-2 candidate (d) — a fourth code path the PR #90 fix did not cover.
  push(indicators, infoIndicator("G2", "cure_metrics", "Rehydrate orphan reaped (24h)", logCount(hubLogCounts, "rehydrate_orphan_reaped"), "events", "storm-recurrence-architectural-root-cause.md"));
  push(indicators, infoIndicator("G3", "cure_metrics", "Rehydrate probe succeeded after retry (24h)", logCount(hubLogCounts, "rehydrate_probe_succeeded_after_retry"), "events", "storm-recurrence-architectural-root-cause.md"));
  push(indicators, infoIndicator("G4", "cure_metrics", "Rehydrate PID-dead pruned (24h)", logCount(hubLogCounts, "rehydrate_pid_dead_pruned"), "events", "storm-recurrence-architectural-root-cause.md"));
  push(indicators, aboveIndicator("E7", "lifecycle_anomaly", "\"is not registered\" within 60s of hub restart", logCount(hubLogCounts, "is_not_registered_post_hub_init"), "events", 1, 5, "storm-recurrence-architectural-root-cause.md"));

  return {
    polled_at: now.toISOString(),
    any_red: indicators.some((indicator) => indicator.state === "red"),
    indicators,
    errors
  };
}

async function loadProcesses(options: BuildSystemMonitorOptions, errors: string[]): Promise<SystemMonitorProcess[]> {
  try {
    if (options.processSnapshot) {
      return await options.processSnapshot();
    }
    return await buildProcessSnapshot({
      stateStore: options.stateStore,
      log: options.log,
      fetchAgentapiInstanceIndex: options.fetchAgentapiInstanceIndex
    });
  } catch (error) {
    errors.push(`process snapshot failed: ${getErrorMessage(error)}`);
    return [];
  }
}

async function loadHubProbe(options: BuildSystemMonitorOptions, socketPath: string, errors: string[]): Promise<HubProbeResult> {
  try {
    return options.probeHub ? await options.probeHub() : await probeHubSocket(socketPath);
  } catch (error) {
    const message = getErrorMessage(error);
    errors.push(`hub probe failed: ${message}`);
    return { reachable: false, latency_ms: null, error: message };
  }
}

async function loadStat(
  statFile: (filePath: string) => Promise<MonitorFileStat | null>,
  filePath: string,
  errors: string[]
): Promise<MonitorFileStat | null> {
  try {
    return await statFile(filePath);
  } catch (error) {
    errors.push(`stat failed for ${filePath}: ${getErrorMessage(error)}`);
    return null;
  }
}

async function loadFsStat(
  statFs: (filePath: string) => Promise<MonitorFsStat>,
  filePath: string,
  errors: string[]
): Promise<MonitorFsStat> {
  try {
    return await statFs(filePath);
  } catch (error) {
    errors.push(`statfs failed for ${filePath}: ${getErrorMessage(error)}`);
    return { freeBytes: 0 };
  }
}

async function loadLogCounts(
  options: BuildSystemMonitorOptions,
  filePath: string,
  nowMs: number,
  errors: string[]
): Promise<Map<string, number>> {
  try {
    return options.countLogPatterns
      ? await options.countLogPatterns(filePath, nowMs)
      : await defaultLogCounter.count(filePath, nowMs);
  } catch (error) {
    errors.push(`log counter failed for ${filePath}: ${getErrorMessage(error)}`);
    return new Map();
  }
}

function updateHubRuntime(hubProbe: HubProbeResult, runtime: MonitorRuntimeState | undefined): number {
  if (!runtime) {
    return hubProbe.reachable ? 0 : 1;
  }
  if (!hubProbe.reachable) {
    runtime.hubFailureStreak += 1;
    return runtime.hubFailureStreak;
  }
  runtime.hubFailureStreak = 0;
  if (hubProbe.latency_ms !== null) {
    runtime.hubLatencies.push(hubProbe.latency_ms);
    runtime.hubLatencies = runtime.hubLatencies.slice(-60);
  }
  return 0;
}

function computeP50(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function sumLeakedTokens(leakProcesses: SystemMonitorProcess[]): number {
  const perSession = new Map<string, number>();
  for (const process of leakProcesses) {
    if (!process.token_usage) {
      continue;
    }
    perSession.set(process.token_usage.session_file, process.token_usage.total_tokens);
  }
  return [...perSession.values()].reduce((sum, value) => sum + value, 0);
}

function computeTokenVelocity(processes: SystemMonitorProcess[], nowMs: number, runtime: MonitorRuntimeState | undefined): number {
  if (!runtime) {
    return 0;
  }
  const current = new Map<string, number>();
  for (const process of processes) {
    if (!process.token_usage || (process.agent_type !== "codex" && process.agent_type !== "claude")) {
      continue;
    }
    current.set(process.token_usage.session_file, process.token_usage.total_tokens);
  }
  const previousAt = runtime.previousProcessSampleAtMs;
  const previous = runtime.previousProcessTotals;
  runtime.previousProcessTotals = current;
  runtime.previousProcessSampleAtMs = nowMs;

  if (previousAt === null || nowMs <= previousAt) {
    return 0;
  }

  const minutes = (nowMs - previousAt) / 60_000;
  let maxVelocity = 0;
  for (const [sessionFile, total] of current) {
    const prior = previous.get(sessionFile);
    if (prior === undefined || total <= prior) {
      continue;
    }
    maxVelocity = Math.max(maxVelocity, (total - prior) / minutes);
  }
  return maxVelocity;
}

function computeGrowthRate(
  filePath: string,
  stat: MonitorFileStat | null,
  nowMs: number,
  runtime: MonitorRuntimeState | undefined
): number {
  if (!runtime || !stat) {
    return 0;
  }
  const previous = runtime.previousFileStats.get(filePath);
  runtime.previousFileStats.set(filePath, { size: stat.size, sampledAtMs: nowMs });
  if (!previous || nowMs <= previous.sampledAtMs || stat.size <= previous.size) {
    return 0;
  }
  return (stat.size - previous.size) / ((nowMs - previous.sampledAtMs) / 1000);
}

function hubReachabilityIndicator(hubProbe: HubProbeResult, failureStreak: number): SystemMonitorIndicator {
  return {
    id: "B1",
    group: "hub_health",
    name: "Hub socket reachable",
    value: hubProbe.reachable ? "reachable" : "unreachable",
    unit: null,
    state: hubProbe.reachable ? "green" : failureStreak >= 3 ? "red" : "yellow",
    thresholds: { yellow: "unreachable for 1 poll", red: "unreachable for 3 polls" },
    source_learning: "dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md",
    detail: hubProbe.error
  };
}

function fileSizeIndicator(
  id: string,
  group: string,
  name: string,
  stat: MonitorFileStat | null,
  unit: string,
  yellow: number,
  red: number,
  source: string
): SystemMonitorIndicator {
  if (!stat) {
    return unknownIndicator(id, group, name, unit, source);
  }
  return aboveIndicator(id, group, name, stat.size, unit, yellow, red, source);
}

function mtimeStalenessIndicator(
  id: string,
  group: string,
  name: string,
  stat: MonitorFileStat | null,
  nowMs: number,
  yellowSeconds: number,
  redSeconds: number,
  source: string
): SystemMonitorIndicator {
  if (!stat) {
    return unknownIndicator(id, group, name, "seconds", source);
  }
  const seconds = Math.max(0, Math.round((nowMs - stat.mtimeMs) / 1000));
  return aboveIndicator(id, group, name, seconds, "seconds", yellowSeconds, redSeconds, source);
}

function aboveIndicator(
  id: string,
  group: string,
  name: string,
  value: number,
  unit: string,
  yellow: number,
  red: number,
  source: string,
  items?: SystemMonitorIndicatorItem[]
): SystemMonitorIndicator {
  return withItems({
    id,
    group,
    name,
    value,
    unit,
    state: value >= red ? "red" : value >= yellow ? "yellow" : "green",
    thresholds: { yellow, red },
    source_learning: source
  }, items);
}

function belowIndicator(
  id: string,
  group: string,
  name: string,
  value: number,
  unit: string,
  yellow: number,
  red: number,
  source: string,
  items?: SystemMonitorIndicatorItem[]
): SystemMonitorIndicator {
  return withItems({
    id,
    group,
    name,
    value,
    unit,
    state: value <= red ? "red" : value <= yellow ? "yellow" : "green",
    thresholds: { yellow, red },
    source_learning: source
  }, items);
}

function unknownIndicator(id: string, group: string, name: string, unit: string | null, source: string): SystemMonitorIndicator {
  return {
    id,
    group,
    name,
    value: null,
    unit,
    state: "unknown",
    source_learning: source
  };
}

function infoIndicator(
  id: string,
  group: string,
  name: string,
  value: number | string,
  unit: string | null,
  source: string,
  items?: SystemMonitorIndicatorItem[]
): SystemMonitorIndicator {
  return withItems({
    id,
    group,
    name,
    value,
    unit,
    state: "info",
    source_learning: source
  }, items);
}

function logCount(counts: Map<string, number>, key: string): number {
  return counts.get(key) ?? 0;
}

function push(indicators: SystemMonitorIndicator[], indicator: SystemMonitorIndicator): void {
  indicators.push(indicator);
}

function withItems(indicator: SystemMonitorIndicator, items?: SystemMonitorIndicatorItem[]): SystemMonitorIndicator {
  const cleanItems = (items ?? []).filter((item) => item.label.trim().length > 0);
  if (cleanItems.length === 0) {
    return indicator;
  }
  return { ...indicator, items: cleanItems.slice(0, 50) };
}

function processItems(processes: SystemMonitorProcess[]): SystemMonitorIndicatorItem[] {
  return processes.map((process) => ({
    label: `pid ${process.pid} ${process.agent_type ?? "unknown"}`,
    href: process.binding?.dispatcher_role_id ? roleDetailHref(process.binding.dispatcher_role_id) : undefined,
    detail: processDetail(process)
  }));
}

function tokenProcessItems(processes: SystemMonitorProcess[]): SystemMonitorIndicatorItem[] {
  return processes
    .filter((process) => process.token_usage)
    .map((process) => ({
      label: `pid ${process.pid} ${process.agent_type ?? "unknown"} ${process.token_usage?.total_tokens.toLocaleString()} tokens`,
      href: process.binding?.dispatcher_role_id ? roleDetailHref(process.binding.dispatcher_role_id) : undefined,
      detail: processDetail(process)
    }));
}

function tokenSessionItems(processes: SystemMonitorProcess[]): SystemMonitorIndicatorItem[] {
  const sessions = new Map<string, { tokens: number; pids: number[]; href?: string; detailParts: string[] }>();
  for (const process of processes) {
    if (!process.token_usage) {
      continue;
    }
    const key = process.token_usage.session_file;
    const current = sessions.get(key) ?? {
      tokens: process.token_usage.total_tokens,
      pids: [],
      href: process.binding?.dispatcher_role_id ? roleDetailHref(process.binding.dispatcher_role_id) : undefined,
      detailParts: []
    };
    current.tokens = Math.max(current.tokens, process.token_usage.total_tokens);
    current.pids.push(process.pid);
    current.detailParts.push(processDetail(process));
    if (!current.href && process.binding?.dispatcher_role_id) {
      current.href = roleDetailHref(process.binding.dispatcher_role_id);
    }
    sessions.set(key, current);
  }
  return [...sessions.entries()].map(([sessionFile, session]) => ({
    label: `${path.basename(sessionFile)} ${session.tokens.toLocaleString()} tokens`,
    href: session.href,
    detail: `session ${sessionFile}; pids ${session.pids.join(", ")}; ${session.detailParts.join(" | ")}`
  }));
}

function processDetail(process: SystemMonitorProcess): string {
  const binding = process.binding
    ? `binding ${process.binding.dispatcher_role_id}/${process.binding.worker_id} ${process.binding.role} ${process.binding.status}`
    : "no binding";
  const tokenUsage = process.token_usage
    ? `${process.token_usage.total_tokens.toLocaleString()} tokens in ${process.token_usage.session_file}`
    : "no token usage";
  return [
    `origin ${process.origin}`,
    `thread ${process.thread_id || "none"}`,
    `etime ${process.etime || "unknown"}`,
    binding,
    tokenUsage,
    `command ${truncate(process.command, 180)}`
  ].join("; ");
}

function roleDetailHref(roleId: string): string {
  return `/role/${encodeURIComponent(roleId)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(body)}\n`);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
