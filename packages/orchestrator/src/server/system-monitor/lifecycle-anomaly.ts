import * as fs from "node:fs/promises";
import path from "node:path";

import { AgentDispatcherConfigSchema, type AppState, type DispatchThreadStateV2 } from "../../types";
import { ACTIVE_ROLE_STATUS, PAUSED_ROLE_STATUS, type StateStore } from "../../state-store";
import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { isHumanDispatchRow } from "../../roles/agent-dispatcher/service-continuation";
import { parseDispatchPlanRows, type DispatchPlanWorkerRow } from "../../tool-gateway/tools/dispatch-status";

export interface LifecycleMonitorResult {
  terminalThreadIds: Set<string>;
  activeAllTerminalPlans: number;
  activeAllTerminalPlanItems: LifecycleMonitorItem[];
  blockedWorkersOver30m: number;
  blockedWorkerItems: LifecycleMonitorItem[];
  awaitingValidationWithoutValidatorOver30m: number;
  awaitingValidationWithoutValidatorItems: LifecycleMonitorItem[];
  runningThreadCollisions: number;
  runningThreadCollisionItems: LifecycleMonitorItem[];
  humanGateIdlingDispatchers: number;
  humanGateIdlingDispatcherItems: LifecycleMonitorItem[];
  blockedHumanGateLoops: number;
  blockedHumanGateLoopItems: LifecycleMonitorItem[];
  pausedDispatchers: number;
  pausedDispatcherItems: LifecycleMonitorItem[];
  statelessValidatorCards: number;
  statelessValidatorItems: LifecycleMonitorItem[];
  errors: string[];
}

export interface LifecycleMonitorItem {
  label: string;
  detail?: string;
  href?: string;
}

interface ThreadOwner {
  key: string;
  roleId: string;
  label: string;
  detail: string;
  href: string;
}

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const TERMINAL_STATUSES = new Set(["completed", "failed", "abandoned", "skipped"]);
const LIVE_RESERVED_STATUSES = new Set(["running", "blocked", "awaiting_validation", "fix_requested"]);
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export async function inspectLifecycle(
  stateStore: Pick<StateStore, "load">,
  nowMs: number
): Promise<LifecycleMonitorResult> {
  const result: LifecycleMonitorResult = {
    terminalThreadIds: new Set(),
    activeAllTerminalPlans: 0,
    activeAllTerminalPlanItems: [],
    blockedWorkersOver30m: 0,
    blockedWorkerItems: [],
    awaitingValidationWithoutValidatorOver30m: 0,
    awaitingValidationWithoutValidatorItems: [],
    runningThreadCollisions: 0,
    runningThreadCollisionItems: [],
    humanGateIdlingDispatchers: 0,
    humanGateIdlingDispatcherItems: [],
    blockedHumanGateLoops: 0,
    blockedHumanGateLoopItems: [],
    pausedDispatchers: 0,
    pausedDispatcherItems: [],
    statelessValidatorCards: 0,
    statelessValidatorItems: [],
    errors: []
  };
  const activeThreadOwners = new Map<string, Map<string, ThreadOwner>>();

  let state: AppState | null;
  try {
    state = await stateStore.load();
  } catch (error) {
    result.errors.push(`state store load failed: ${getErrorMessage(error)}`);
    return result;
  }

  for (const role of (state ?? { roles: [], promptStore: {} }).roles) {
    if (role.roleType !== "agent-dispatcher") {
      continue;
    }
    const roleHref = roleDetailHref(role.threadId);
    if (role.status === PAUSED_ROLE_STATUS) {
      result.pausedDispatchers += 1;
      result.pausedDispatcherItems.push({
        label: role.threadId,
        href: roleHref,
        detail: "dispatcher role status is paused"
      });
    }

    const parsedConfig = AgentDispatcherConfigSchema.safeParse(role.config);
    if (!parsedConfig.success) {
      result.errors.push(`invalid dispatcher config for ${role.threadId}`);
      continue;
    }
    const config = parsedConfig.data;
    if (config.validator?.enabled && config.validator.mode === "stateless_call") {
      result.statelessValidatorCards += 1;
      result.statelessValidatorItems.push({
        label: role.threadId,
        href: roleHref,
        detail: `validator mode stateless_call; plan ${config.dispatch_plan_path}`
      });
    }

    const lifecyclePath = path.join(path.dirname(config.dispatch_plan_path), DISPATCH_THREADS_FILENAME);
    let lifecycle: DispatchThreadStateV2;
    try {
      lifecycle = new LifecycleStore(lifecyclePath).load();
    } catch (error) {
      result.errors.push(`failed to read lifecycle ${lifecyclePath}: ${getErrorMessage(error)}`);
      continue;
    }

    collectTerminalThreadIds(lifecycle, result.terminalThreadIds);
    collectActiveThreadOwners(role.threadId, config.dispatch_plan_path, lifecycle, activeThreadOwners);

    const workers = Object.values(lifecycle.workers);
    if (
      role.status === ACTIVE_ROLE_STATUS
      && workers.length > 0
      && TERMINAL_STATUSES.has(lifecycle.dispatcher.status)
      && workers.every((worker) => TERMINAL_STATUSES.has(worker.status))
    ) {
      result.activeAllTerminalPlans += 1;
      result.activeAllTerminalPlanItems.push({
        label: role.threadId,
        href: roleHref,
        detail: `dispatcher ${lifecycle.dispatcher.status}; ${workers.length} terminal worker${workers.length === 1 ? "" : "s"}; plan ${config.dispatch_plan_path}`
      });
    }

    for (const [workerId, worker] of Object.entries(lifecycle.workers)) {
      if (worker.status === "blocked" && isOlderThan(worker.last_seen_at, nowMs, THIRTY_MINUTES_MS) && !hasActivePmResolver(lifecycle, workerId)) {
        result.blockedWorkersOver30m += 1;
        result.blockedWorkerItems.push(workerMonitorItem(role.threadId, workerId, worker, "blocked > 30 min without active PM resolver"));
      }
      if (
        worker.status === "awaiting_validation"
        && isOlderThan(worker.last_seen_at, nowMs, THIRTY_MINUTES_MS)
        && !worker.validation?.validator_thread_id?.trim()
      ) {
        result.awaitingValidationWithoutValidatorOver30m += 1;
        result.awaitingValidationWithoutValidatorItems.push(
          workerMonitorItem(role.threadId, workerId, worker, "awaiting_validation > 30 min without validator_thread_id")
        );
      }
    }

    // Drop the ACTIVE-only gate the original E5 indicator had — a dispatcher
    // force-paused by the restart safety hold (after a hub flap or service
    // restart) still has an unresolved HUMAN gate that the operator needs
    // to see. Without surfacing paused-with-open-gate we leave the user
    // staring at a silent paused dispatcher with no signal about what's
    // blocking. Reproducer: agent-dispatcher-98b73906 on 2026-05-19 — V-01-B
    // HUMAN row pending while role.status = paused (restart hold), so the
    // monitor showed E5 = 0 even though that was the actual block.
    const planLoop = await detectBlockedHumanGateLoop(config.dispatch_plan_path);
    if (planLoop.openHumanGate) {
      result.humanGateIdlingDispatchers += 1;
      result.humanGateIdlingDispatcherItems.push({
        label: role.threadId,
        href: roleHref,
        detail: `${role.status} dispatcher has an open HUMAN row in ${config.dispatch_plan_path}`
      });
    }
    if (planLoop.loopWorkers.length > 0) {
      result.blockedHumanGateLoops += 1;
      result.blockedHumanGateLoopItems.push({
        label: role.threadId,
        href: roleHref,
        detail: `BLOCKED HUMAN row(s) ${planLoop.blockedHumanWorkers.join(", ")} with pending non-HUMAN downstream ${planLoop.loopWorkers.join(", ")} in ${config.dispatch_plan_path}`
      });
    }
  }

  const collisionEntries = [...activeThreadOwners.entries()]
    .filter(([, owners]) => owners.size > 1);
  result.runningThreadCollisions = collisionEntries.length;
  result.runningThreadCollisionItems = collisionEntries.map(([threadId, owners]) => {
    const ownerList = [...owners.values()];
    return {
      label: `thread ${threadId}`,
      href: ownerList[0]?.href,
      detail: ownerList.map((owner) => owner.detail).join("; ")
    };
  });

  return result;
}

function collectTerminalThreadIds(lifecycle: DispatchThreadStateV2, terminalThreadIds: Set<string>): void {
  if (lifecycle.dispatcher.thread_id && TERMINAL_STATUSES.has(lifecycle.dispatcher.status)) {
    terminalThreadIds.add(lifecycle.dispatcher.thread_id);
  }
  for (const worker of Object.values(lifecycle.workers)) {
    if (worker.thread_id && TERMINAL_STATUSES.has(worker.status)) {
      terminalThreadIds.add(worker.thread_id);
    }
    for (const history of worker.validation?.history ?? []) {
      if (history.validator_thread_id) {
        terminalThreadIds.add(history.validator_thread_id);
      }
    }
  }
}

function collectActiveThreadOwners(
  roleId: string,
  planPath: string,
  lifecycle: DispatchThreadStateV2,
  activeThreadOwners: Map<string, Map<string, ThreadOwner>>
): void {
  addActiveThreadOwner(
    activeThreadOwners,
    lifecycle.dispatcher.thread_id,
    lifecycle.dispatcher.status === "running",
    threadOwner(roleId, "dispatcher", "DISPATCHER", planPath)
  );
  for (const [workerId, worker] of Object.entries(lifecycle.workers)) {
    addActiveThreadOwner(
      activeThreadOwners,
      worker.thread_id,
      LIVE_RESERVED_STATUSES.has(worker.status),
      threadOwner(roleId, "worker", workerId, planPath)
    );
    addActiveThreadOwner(
      activeThreadOwners,
      worker.validation?.validator_thread_id ?? null,
      worker.status === "awaiting_validation",
      threadOwner(roleId, "validator", workerId, planPath)
    );
  }
  for (const pm of lifecycle.pm_resolvers ?? []) {
    const workerId = pm.issue?.worker_id ?? "";
    addActiveThreadOwner(
      activeThreadOwners,
      pm.thread_id,
      pm.status === "running",
      threadOwner(roleId, "pm_resolver", workerId || "unknown-worker", planPath)
    );
  }
}

function addActiveThreadOwner(
  activeThreadOwners: Map<string, Map<string, ThreadOwner>>,
  threadId: string | null | undefined,
  active: boolean,
  owner: ThreadOwner
): void {
  const trimmed = threadId?.trim();
  if (!active || !trimmed) {
    return;
  }
  let owners = activeThreadOwners.get(trimmed);
  if (!owners) {
    owners = new Map();
    activeThreadOwners.set(trimmed, owners);
  }
  owners.set(owner.key, owner);
}

function hasActivePmResolver(lifecycle: DispatchThreadStateV2, workerId: string): boolean {
  return (lifecycle.pm_resolvers ?? []).some((pm) =>
    pm.status === "running" && pm.issue?.worker_id === workerId
  );
}

interface BlockedHumanGateLoopResult {
  openHumanGate: boolean;
  blockedHumanWorkers: string[];
  loopWorkers: string[];
}

async function detectBlockedHumanGateLoop(planPath: string): Promise<BlockedHumanGateLoopResult> {
  const empty: BlockedHumanGateLoopResult = { openHumanGate: false, blockedHumanWorkers: [], loopWorkers: [] };
  let markdown: string;
  try {
    markdown = await fs.readFile(planPath, "utf8");
  } catch {
    return empty;
  }
  const rows = parseDispatchPlanRows(markdown);
  const openHumanGate = rows.some((row) => isHumanDispatchRow({ model: row.model }) && !isTerminalPlanStatus(row.status));

  // A "blocked-human-gate loop" is the deadlock pattern observed on
  // agent-dispatcher-98b73906 (2026-05-19): a HUMAN row was manually
  // annotated `⛔` (verdict: failed) and the v1.1 append wired the *fix*
  // rows as `depends_on: <that-HUMAN-row>`. Result: the HUMAN row will
  // never reach a terminal lifecycle status on its own, so its downstream
  // pending workers can never be dispatched and the dispatcher idles
  // silently forever. We catch this so the monitor surfaces it as
  // actionable instead of waiting for the operator to notice the silence.
  const blockedHumanWorkers = rows
    .filter((row) => isHumanDispatchRow({ model: row.model }) && isBlockedPlanStatus(row.status))
    .map((row) => row.worker_id);
  if (blockedHumanWorkers.length === 0) {
    return { openHumanGate, blockedHumanWorkers: [], loopWorkers: [] };
  }
  const blockedSet = new Set(blockedHumanWorkers);
  const loopWorkers: string[] = [];
  for (const row of rows) {
    if (isHumanDispatchRow({ model: row.model })) {
      continue;
    }
    if (!isPendingPlanStatus(row.status)) {
      continue;
    }
    if (dependencyChainIncludes(row, rows, blockedSet)) {
      loopWorkers.push(row.worker_id);
    }
  }
  return { openHumanGate, blockedHumanWorkers, loopWorkers };
}

function isBlockedPlanStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "⛔"
    || normalized === "⛔ blocked"
    || normalized === "blocked";
}

function isPendingPlanStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "⬜" || normalized === "pending" || normalized === "";
}

function dependencyChainIncludes(
  row: DispatchPlanWorkerRow,
  rows: DispatchPlanWorkerRow[],
  targets: Set<string>,
  visited: Set<string> = new Set()
): boolean {
  if (visited.has(row.worker_id)) {
    return false;
  }
  visited.add(row.worker_id);

  const rowIndex = rows.findIndex((candidate) => candidate.worker_id === row.worker_id);
  for (const rawDep of row.depends_on) {
    const dep = rawDep.trim();
    if (!dep) {
      continue;
    }
    // ALL-PRIOR expands to every row strictly earlier in the master table.
    if (dep.toUpperCase() === "ALL-PRIOR") {
      for (let i = 0; i < (rowIndex === -1 ? rows.length : rowIndex); i += 1) {
        const prior = rows[i];
        if (!prior) {
          continue;
        }
        if (targets.has(prior.worker_id)) {
          return true;
        }
        if (dependencyChainIncludes(prior, rows, targets, visited)) {
          return true;
        }
      }
      continue;
    }
    if (targets.has(dep)) {
      return true;
    }
    const depRow = rows.find((candidate) => candidate.worker_id === dep);
    if (depRow && dependencyChainIncludes(depRow, rows, targets, visited)) {
      return true;
    }
  }
  return false;
}

function isTerminalPlanStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "✅"
    || normalized === "completed"
    || normalized === "done"
    || normalized === "❌"
    || normalized === "failed"
    || normalized === "⛔ skipped"
    || normalized === "skipped";
}

function isOlderThan(iso: string | null | undefined, nowMs: number, ageMs: number): boolean {
  if (!iso) {
    return false;
  }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && nowMs - parsed > ageMs;
}

function workerMonitorItem(
  roleId: string,
  workerId: string,
  worker: DispatchThreadStateV2["workers"][string],
  reason: string
): LifecycleMonitorItem {
  const thread = worker.thread_id?.trim() || "no thread";
  return {
    label: `${roleId} / ${workerId}`,
    href: roleDetailHref(roleId),
    detail: `${reason}; status ${worker.status}; thread ${thread}; last_seen_at ${worker.last_seen_at}`
  };
}

function threadOwner(roleId: string, kind: string, id: string, planPath: string): ThreadOwner {
  const label = kind === "dispatcher" ? roleId : `${roleId} / ${id}`;
  return {
    key: `${kind}:${roleId}:${id}`,
    roleId,
    label,
    href: roleDetailHref(roleId),
    detail: `${label} (${kind}; plan ${planPath})`
  };
}

function roleDetailHref(roleId: string): string {
  return `/role/${encodeURIComponent(roleId)}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
