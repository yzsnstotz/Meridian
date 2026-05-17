import * as fs from "node:fs/promises";
import path from "node:path";

import { AgentDispatcherConfigSchema, type AppState, type DispatchThreadStateV2 } from "../../types";
import { ACTIVE_ROLE_STATUS, PAUSED_ROLE_STATUS, type StateStore } from "../../state-store";
import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { isHumanDispatchRow } from "../../roles/agent-dispatcher/service-continuation";
import { parseDispatchPlanRows } from "../../tool-gateway/tools/dispatch-status";

export interface LifecycleMonitorResult {
  terminalThreadIds: Set<string>;
  activeAllTerminalPlans: number;
  blockedWorkersOver30m: number;
  awaitingValidationWithoutValidatorOver30m: number;
  runningThreadCollisions: number;
  humanGateIdlingDispatchers: number;
  pausedDispatchers: number;
  statelessValidatorCards: number;
  errors: string[];
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
    blockedWorkersOver30m: 0,
    awaitingValidationWithoutValidatorOver30m: 0,
    runningThreadCollisions: 0,
    humanGateIdlingDispatchers: 0,
    pausedDispatchers: 0,
    statelessValidatorCards: 0,
    errors: []
  };
  const activeThreadOwners = new Map<string, Set<string>>();

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
    if (role.status === PAUSED_ROLE_STATUS) {
      result.pausedDispatchers += 1;
    }

    const parsedConfig = AgentDispatcherConfigSchema.safeParse(role.config);
    if (!parsedConfig.success) {
      result.errors.push(`invalid dispatcher config for ${role.threadId}`);
      continue;
    }
    const config = parsedConfig.data;
    if (config.validator?.enabled && config.validator.mode === "stateless_call") {
      result.statelessValidatorCards += 1;
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
    collectActiveThreadOwners(config.dispatch_plan_path, lifecycle, activeThreadOwners);

    const workers = Object.values(lifecycle.workers);
    if (
      role.status === ACTIVE_ROLE_STATUS
      && workers.length > 0
      && TERMINAL_STATUSES.has(lifecycle.dispatcher.status)
      && workers.every((worker) => TERMINAL_STATUSES.has(worker.status))
    ) {
      result.activeAllTerminalPlans += 1;
    }

    for (const [workerId, worker] of Object.entries(lifecycle.workers)) {
      if (worker.status === "blocked" && isOlderThan(worker.last_seen_at, nowMs, THIRTY_MINUTES_MS) && !hasActivePmResolver(lifecycle, workerId)) {
        result.blockedWorkersOver30m += 1;
      }
      if (
        worker.status === "awaiting_validation"
        && isOlderThan(worker.last_seen_at, nowMs, THIRTY_MINUTES_MS)
        && !worker.validation?.validator_thread_id?.trim()
      ) {
        result.awaitingValidationWithoutValidatorOver30m += 1;
      }
    }

    if (role.status === ACTIVE_ROLE_STATUS && await hasOpenHumanGate(config.dispatch_plan_path)) {
      result.humanGateIdlingDispatchers += 1;
    }
  }

  result.runningThreadCollisions = [...activeThreadOwners.values()]
    .filter((owners) => owners.size > 1)
    .length;

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
  planPath: string,
  lifecycle: DispatchThreadStateV2,
  activeThreadOwners: Map<string, Set<string>>
): void {
  addActiveThreadOwner(activeThreadOwners, lifecycle.dispatcher.thread_id, lifecycle.dispatcher.status === "running", planPath);
  for (const [workerId, worker] of Object.entries(lifecycle.workers)) {
    addActiveThreadOwner(activeThreadOwners, worker.thread_id, LIVE_RESERVED_STATUSES.has(worker.status), `${planPath}#${workerId}`);
    addActiveThreadOwner(
      activeThreadOwners,
      worker.validation?.validator_thread_id ?? null,
      worker.status === "awaiting_validation",
      `${planPath}#validator:${workerId}`
    );
  }
  for (const pm of lifecycle.pm_resolvers ?? []) {
    addActiveThreadOwner(activeThreadOwners, pm.thread_id, pm.status === "running", `${planPath}#pm:${pm.issue?.worker_id ?? ""}`);
  }
}

function addActiveThreadOwner(
  activeThreadOwners: Map<string, Set<string>>,
  threadId: string | null | undefined,
  active: boolean,
  owner: string
): void {
  const trimmed = threadId?.trim();
  if (!active || !trimmed) {
    return;
  }
  let owners = activeThreadOwners.get(trimmed);
  if (!owners) {
    owners = new Set();
    activeThreadOwners.set(trimmed, owners);
  }
  owners.add(owner);
}

function hasActivePmResolver(lifecycle: DispatchThreadStateV2, workerId: string): boolean {
  return (lifecycle.pm_resolvers ?? []).some((pm) =>
    pm.status === "running" && pm.issue?.worker_id === workerId
  );
}

async function hasOpenHumanGate(planPath: string): Promise<boolean> {
  let markdown: string;
  try {
    markdown = await fs.readFile(planPath, "utf8");
  } catch {
    return false;
  }
  const rows = parseDispatchPlanRows(markdown);
  return rows.some((row) => isHumanDispatchRow({ model: row.model }) && !isTerminalPlanStatus(row.status));
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
