import type { DispatchThreadStateV2 } from "../../types";
// Type-only: the gate is INJECTED as a callback rather than constructed here.
// capsule-materialization.ts imports validator-prompt-builder and reads the
// filesystem; importing it for real would make these row resolvers — which are
// pure, synchronous, and used for counting as well as selection — depend on
// disk. A type-only import also keeps the module graph acyclic.
import type { CapsuleMaterializationGate } from "./capsule-materialization";
import {
  findUnreleasedHumanEscalation,
  isFrozenPendingHumanResolution,
  type HumanEscalationFreeze
} from "./human-escalation-freeze";
import {
  hubResultContainsBlockSignal,
  hubResultContainsFailureSignal,
  hubResultContainsHitLimit
} from "./lifecycle-store";

export const MAX_AUTOMATIC_RECOVERY_RETRIES = 2;

export interface DispatchContinuationPlanRow {
  status: string;
  batch?: string | null;
  worker: string;
  model: string | null;
  depends_on: string | string[];
  notes?: string | null;
  branch?: string | null;
}

export interface DispatchContinuationWorkerRow {
  status: string;
  batch?: string | null;
  worker_id: string;
  model: string | null;
  depends_on: string[];
  notes?: string | null;
  branch?: string | null;
}

export interface ResolveEligibleServiceContinueWorkersOptions {
  includeImplicitRunningWorker?: boolean;
  limit?: number;
  /**
   * The dispatch materialization precondition, injected. When supplied, a row
   * whose Context Capsule still carries `⏳ 待物化` is not a launch candidate —
   * it is parked, not queued.
   *
   * Optional so the pure-row unit tests and any caller with no plan path on
   * hand keep working unchanged; the UNCONDITIONAL refusal lives in
   * `continueDispatchWorker`, which every launch funnels through and which
   * always has `dispatch_plan_path`. Omitting the gate therefore costs a wasted
   * candidate slot, never a launch against an unmaterialized capsule.
   */
  capsuleGate?: CapsuleMaterializationGate;
}

export function resolveServiceContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  options: Pick<ResolveEligibleServiceContinueWorkersOptions, "capsuleGate"> = {}
): string | null {
  return resolveEligibleServiceContinueWorkers(rows, lifecycleState, { ...options, limit: 1 })[0] ?? null;
}

export function resolveEligibleServiceContinueWorkers(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  options: ResolveEligibleServiceContinueWorkersOptions = {}
): string[] {
  const limit = options.limit && options.limit > 0
    ? Math.floor(options.limit)
    : Number.POSITIVE_INFINITY;
  const capsuleGate = options.capsuleGate;
  const preflightGateWorker = resolvePreflightGateWorker(rows, lifecycleState, capsuleGate);
  if (preflightGateWorker !== undefined) {
    return preflightGateWorker ? [preflightGateWorker].slice(0, limit) : [];
  }

  const includeImplicitRunningWorker = options.includeImplicitRunningWorker ?? true;
  if (includeImplicitRunningWorker) {
    const implicitWorker = resolveImplicitContinueWorker(rows, lifecycleState, capsuleGate);
    if (implicitWorker) {
      return [implicitWorker].slice(0, limit);
    }
  }

  const rowsByWorker = indexRowsByWorker(rows);
  const eligibleWorkers: string[] = [];
  for (const row of rows) {
    if (!isEligibleServiceContinueRow(row, rows, rowsByWorker, lifecycleState, capsuleGate)) {
      // `continue`, never `return`: one parked row must not cost its unrelated
      // siblings their slots. Same rule the escalation freeze established.
      continue;
    }

    const workerId = row.worker.trim();
    if (workerId.length === 0) {
      continue;
    }

    eligibleWorkers.push(workerId);
    if (eligibleWorkers.length >= limit) {
      break;
    }
  }

  return eligibleWorkers;
}

export function resolveManualInterventionWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  for (const row of rows) {
    if (isHumanDispatchRow(row)) {
      continue;
    }

    const normalizedWorkerId = row.worker.trim();
    if (normalizedWorkerId.length === 0) {
      continue;
    }

    const workerState = resolveLifecycleWorkerState(lifecycleState, row.worker);

    // Lifecycle store is authoritative for terminal & validator-owned
    // states. The plan markdown can lag behind: a worker that emitted a
    // `blocked` marker but was later approved by the validator (or
    // resolved by PM) keeps a stale ⛔ BLOCKED row even though the
    // lifecycle has moved it to completed/skipped or handed it to the
    // validator orchestrator. Asking for manual intervention in those
    // cases would leave the dispatcher permanently stuck. Mirrors the
    // same lifecycle-wins invariant `isImplicitContinueRow` enforces.
    if (
      workerState?.status === "completed"
      || workerState?.status === "skipped"
      || workerState?.status === "awaiting_validation"
      || workerState?.status === "fix_requested"
    ) {
      continue;
    }

    // Validator-decided terminal failure: the worker reached max_fix_cycles
    // and the orchestrator stamped `failed`.
    //
    // This used to skip unconditionally, on the reasoning that the operator
    // owns the verdict from here and PM has no role. Measured against real
    // rounds that is wrong in the common case: a row exhausts its budget
    // precisely when a finding is UNFIXABLE BY THE WORKER — a spec defect, a
    // capsule that never authorised the surface the acceptance needs, or a
    // phantom the worker cannot make go away. Those are exactly PM's job, and
    // the unconditional skip meant nobody was ever told. Observed on
    // agent-dispatcher-abd83457: C-02 and C-09 both burned five cycles and
    // then sat dead and unannounced for hours; C-02's last cycle had already
    // accepted its code and failed it on a phantom missing report, and
    // C-09 was being held to its own gate's verdict on files it did not own.
    //
    // So: route to PM exactly ONCE. The moment any PM resolver entry exists
    // for this (worker, manual_intervention_required) issue, we fall back to
    // the old skip — which preserves the wedge fix this guard was written for
    // (M-01 on agent-dispatcher-9fd97803: re-flagging every tick blocked
    // every downstream worker) and the storm fix below (R-04 on
    // agent-dispatcher-f0953280, 347K log lines over 12 days).
    if (
      workerState?.status === "failed"
      && hasExhaustedValidationCycles(workerState)
      && hasPmResolverBeenRequestedForManualIntervention(lifecycleState, normalizedWorkerId)
    ) {
      continue;
    }

    // PM-resolver exhausted: the watchdog already invoked a PM resolver for
    // the same (worker, manual_intervention_required) issue and that
    // resolver thread reached a terminal lifecycle state without resolving
    // it (failed thread, or completed-and-escalated to a human). The
    // dispatcher's per-issue dedup prevents spawning another PM resolver
    // for the same issue, so re-flagging the worker as
    // manual_intervention_required just causes the watchdog to detect the
    // same stall every interval, fire onDispatcherStalled, log "PM resolver
    // already requested", and repeat forever (observed: R-04 on
    // agent-dispatcher-f0953280 emitting 347K storm lines over 12 days).
    if (isPmResolverExhaustedForManualIntervention(lifecycleState, normalizedWorkerId)) {
      continue;
    }

    if (isBlockedDispatchStatus(row.status)) {
      return normalizedWorkerId;
    }

    if (workerState?.status !== "blocked" && (!workerState?.hub_result || !hubResultRequiresManualIntervention(workerState.hub_result))) {
      continue;
    }

    return normalizedWorkerId;
  }

  return null;
}

/**
 * True when the most recent PM resolver targeting this worker's
 * `manual_intervention_required` issue has reached a terminal lifecycle
 * state without resolving it — i.e. its thread is `failed`, or it
 * `completed` with `marker_outcome: "escalated"` (the PM agent's signal
 * that a human must act). Once this is true, the dispatcher's per-issue
 * dedup prevents a fresh resolver from spawning, so the watchdog should
 * not keep re-detecting the same stall.
 */
/**
 * True when the watchdog has already recorded ANY PM resolver for this
 * worker's `manual_intervention_required` issue — running, completed, or
 * failed.
 *
 * Distinct from {@link isPmResolverExhaustedForManualIntervention}, which asks
 * whether the latest one gave up. This asks only "has PM been told at all",
 * and is what bounds validation-exhaustion routing to a single PM pass.
 */
export function hasPmResolverBeenRequestedForManualIntervention(
  lifecycleState: DispatchThreadStateV2,
  workerId: string
): boolean {
  return (lifecycleState.pm_resolvers ?? []).some(
    (resolver) =>
      resolver.issue.worker_id === workerId
      && resolver.issue.status === "manual_intervention_required"
  );
}

export function isPmResolverExhaustedForManualIntervention(
  lifecycleState: DispatchThreadStateV2,
  workerId: string
): boolean {
  const resolvers = lifecycleState.pm_resolvers ?? [];
  let latestIndex = -1;
  let latestSeenMs = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < resolvers.length; i += 1) {
    const resolver = resolvers[i]!;
    if (resolver.issue.worker_id !== workerId) {
      continue;
    }
    if (resolver.issue.status !== "manual_intervention_required") {
      continue;
    }
    const seenMs = Date.parse(resolver.last_seen_at);
    const sortKey = Number.isFinite(seenMs) ? seenMs : i;
    if (sortKey <= latestSeenMs) {
      continue;
    }
    latestSeenMs = sortKey;
    latestIndex = i;
  }
  if (latestIndex < 0) {
    return false;
  }
  const latest = resolvers[latestIndex]!;
  if (latest.status === "failed") {
    return true;
  }
  if (latest.status === "completed" && latest.marker_outcome === "escalated") {
    return true;
  }
  return false;
}

/**
 * The set of worker IDs that resolveManualInterventionWorker would skip
 * solely because of an exhausted PM resolver. Used by the watchdog to
 * emit a single state-transition log per (dispatch_plan, worker) so the
 * operator knows the dispatcher needs human attention without flooding
 * the log every poll.
 */
export function resolveExhaustedPmResolverWorkers(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string[] {
  const exhausted: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (isHumanDispatchRow(row)) {
      continue;
    }
    const workerId = row.worker.trim();
    if (!workerId || seen.has(workerId)) {
      continue;
    }
    const workerState = resolveLifecycleWorkerState(lifecycleState, row.worker);
    const wouldFlagManual = isBlockedDispatchStatus(row.status)
      || workerState?.status === "blocked"
      || (!!workerState?.hub_result && hubResultRequiresManualIntervention(workerState.hub_result));
    if (!wouldFlagManual) {
      continue;
    }
    if (!isPmResolverExhaustedForManualIntervention(lifecycleState, workerId)) {
      continue;
    }
    exhausted.push(workerId);
    seen.add(workerId);
  }
  return exhausted;
}

/**
 * Every plan row currently parked behind an unreleased `escalate_human`
 * escalation, in plan order.
 *
 * Scoped to the plan's own rows (rather than reading the lifecycle store's
 * pm_resolvers wholesale) so a stale PM entry for a worker that no longer
 * exists in the markdown cannot park anything, and so the operator-facing
 * message names rows they can actually see.
 */
export function resolveHumanEscalationParkedWorkers(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): HumanEscalationFreeze[] {
  const parked: HumanEscalationFreeze[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (isHumanDispatchRow(row)) {
      continue;
    }
    const workerId = row.worker.trim();
    if (!workerId || seen.has(workerId)) {
      continue;
    }
    const freeze = findUnreleasedHumanEscalation(lifecycleState, workerId);
    if (!freeze) {
      continue;
    }
    seen.add(workerId);
    parked.push(freeze);
  }
  return parked;
}

export function resolveHumanEscalationParkedWorkersFromWorkerRows(
  rows: DispatchContinuationWorkerRow[],
  lifecycleState: DispatchThreadStateV2
): HumanEscalationFreeze[] {
  return resolveHumanEscalationParkedWorkers(
    rows.map((row) => ({
      status: row.status,
      batch: row.batch ?? null,
      worker: row.worker_id,
      model: row.model,
      depends_on: row.depends_on,
      notes: row.notes ?? null,
      ...(row.branch ? { branch: row.branch } : {})
    })),
    lifecycleState
  );
}

export function resolveExhaustedPmResolverWorkersFromWorkerRows(
  rows: DispatchContinuationWorkerRow[],
  lifecycleState: DispatchThreadStateV2
): string[] {
  return resolveExhaustedPmResolverWorkers(
    rows.map((row) => ({
      status: row.status,
      batch: row.batch ?? null,
      worker: row.worker_id,
      model: row.model,
      depends_on: row.depends_on,
      notes: row.notes ?? null,
      // Carried through deliberately: the validator resolves the branch it
      // diffs from this field, and dropping it here made every validator fall
      // back to a synthetic `task/<id>` ref that no plan contains.
      ...(row.branch ? { branch: row.branch } : {})
    })),
    lifecycleState
  );
}

export function resolveManualInterventionWorkerFromWorkerRows(
  rows: DispatchContinuationWorkerRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  return resolveManualInterventionWorker(
    rows.map((row) => ({
      status: row.status,
      batch: row.batch ?? null,
      worker: row.worker_id,
      model: row.model,
      depends_on: row.depends_on,
      notes: row.notes ?? null,
      // Carried through deliberately: the validator resolves the branch it
      // diffs from this field, and dropping it here made every validator fall
      // back to a synthetic `task/<id>` ref that no plan contains.
      ...(row.branch ? { branch: row.branch } : {})
    })),
    lifecycleState
  );
}

export function isHumanDispatchRow(row: Pick<DispatchContinuationPlanRow, "model">): boolean {
  const model = row.model?.trim().toUpperCase() ?? "";
  return model === "HUMAN" || model === "PM";
}

export function resolveServiceContinueWorkerFromWorkerRows(
  rows: DispatchContinuationWorkerRow[],
  lifecycleState: DispatchThreadStateV2,
  options: Pick<ResolveEligibleServiceContinueWorkersOptions, "capsuleGate"> = {}
): string | null {
  return resolveServiceContinueWorker(
    rows.map((row) => ({
      status: row.status,
      batch: row.batch ?? null,
      worker: row.worker_id,
      model: row.model,
      depends_on: row.depends_on,
      notes: row.notes ?? null,
      // Carried through deliberately: the validator resolves the branch it
      // diffs from this field, and dropping it here made every validator fall
      // back to a synthetic `task/<id>` ref that no plan contains.
      ...(row.branch ? { branch: row.branch } : {})
    })),
    lifecycleState,
    options
  );
}

export function countEligiblePendingServiceContinueWorkersFromWorkerRows(
  rows: DispatchContinuationWorkerRow[],
  lifecycleState: DispatchThreadStateV2,
  options: Pick<ResolveEligibleServiceContinueWorkersOptions, "capsuleGate"> = {}
): number {
  const normalizedRows = rows.map((row) => ({
    status: row.status,
    batch: row.batch ?? null,
    worker: row.worker_id,
    model: row.model,
    depends_on: row.depends_on,
    notes: row.notes ?? null,
    ...(row.branch ? { branch: row.branch } : {})
  }));
  const rowsByWorker = indexRowsByWorker(normalizedRows);

  return normalizedRows.filter((row) => {
    return row.status.trim() === "⬜"
      && isEligibleServiceContinueRow(row, normalizedRows, rowsByWorker, lifecycleState, options.capsuleGate);
  }).length;
}

export function hasRecoverableDispatchWork(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): boolean {
  if (rows.length === 0) {
    return true;
  }

  if (resolveServiceContinueWorker(rows, lifecycleState)) {
    return true;
  }

  if (resolveManualInterventionWorker(rows, lifecycleState)) {
    return true;
  }

  const rowsByWorker = indexRowsByWorker(rows);
  return rows.some((row) => {
    if (isHumanDispatchRow(row)) {
      return false;
    }

    const workerId = row.worker.trim();
    if (!workerId) {
      return false;
    }

    const worker = resolveLifecycleWorkerState(lifecycleState, workerId);
    if (worker?.status === "awaiting_validation" || worker?.status === "fix_requested") {
      return true;
    }

    if (worker?.status === "completed" || worker?.status === "skipped") {
      return false;
    }

    const status = row.status.trim();
    if (status === "✅" || status === "⛔ SKIPPED" || status === "⛔ BLOCKED") {
      return false;
    }

    if ((status === "❌" || status === "⚠️ ABANDONED") && !isRetryableTerminalWorker(lifecycleState, row.worker)) {
      return false;
    }

    if (isBlockedByOpenHumanGate(row, rows, rowsByWorker, lifecycleState)) {
      return false;
    }

    return status === "⬜"
      || status === "🔄"
      || status === "❌"
      || status === "⚠️ ABANDONED"
      || status.startsWith("🔁");
  });
}

function isBlockedByOpenHumanGate(
  row: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>,
  lifecycleState: DispatchThreadStateV2,
  seenWorkers = new Set<string>()
): boolean {
  const workerId = normalizeWorkerIdentifier(row.worker);
  if (workerId) {
    if (seenWorkers.has(workerId)) {
      return false;
    }
    seenWorkers.add(workerId);
  }

  const dependencyRows = normalizeDependsOnWorkers(row.depends_on)
    .flatMap((dependencyClause) => resolveDependencyRows(dependencyClause, row, rows, rowsByWorker));

  return dependencyRows.some((dependencyRow) => {
    if (isDispatchDependencyTerminal(dependencyRow, lifecycleState)) {
      return false;
    }

    if (isHumanDispatchRow(dependencyRow)) {
      return true;
    }

    return isBlockedByOpenHumanGate(dependencyRow, rows, rowsByWorker, lifecycleState, seenWorkers);
  });
}

function resolveImplicitContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  capsuleGate?: CapsuleMaterializationGate
): string | null {
  const runningRows = rows.filter((row) => row.status === "🔄" && !isHumanDispatchRow(row));
  if (runningRows.length !== 1) {
    return null;
  }

  const [row] = runningRows;
  if (!row) {
    return null;
  }

  return isImplicitContinueRow(row, lifecycleState, capsuleGate)
    ? row.worker.trim()
    : null;
}

function isImplicitContinueRow(
  row: DispatchContinuationPlanRow,
  lifecycleState: DispatchThreadStateV2,
  capsuleGate?: CapsuleMaterializationGate
): boolean {
  if (hasAutomaticDispatchBlocker(row)) {
    return false;
  }

  // Materialization precondition. The implicit path relaunches a lone 🔄 row
  // whose lifecycle thread died — which is exactly the shape an unmaterialized
  // row leaves behind after it self-reports `blocked` and gets killed. Without
  // this it would be relaunched against the same `⏳` capsule every tick.
  if (capsuleGate?.(row.worker)) {
    return false;
  }

  // Escalation freeze. The implicit path is the one that picks up a lone 🔄
  // row whose lifecycle thread died — exactly the shape a parked-and-killed
  // escalated worker leaves behind — so it must honour the freeze too.
  if (isFrozenPendingHumanResolution(lifecycleState, row.worker)) {
    return false;
  }

  const worker = resolveLifecycleWorkerState(lifecycleState, row.worker);
  if (worker?.status === "running" && worker.thread_id.trim().length > 0) {
    return false;
  }

  // Don't re-dispatch workers that already reached a terminal success state.
  // The plan markdown may still show 🔄 due to a stale sync, but the lifecycle
  // store is authoritative. Re-dispatching a completed/skipped worker would
  // reset it to pending and cause an infinite re-dispatch loop.
  if (worker?.status === "completed" || worker?.status === "skipped") {
    return false;
  }

  if (worker?.status === "blocked") {
    return false;
  }

  if (hasExhaustedValidationCycles(worker)) {
    return false;
  }

  // Validation-owned workers are not eligible for implicit continuation.
  // The validator orchestrator manages their lifecycle.
  if (worker?.status === "awaiting_validation" || worker?.status === "fix_requested") {
    return false;
  }

  if (worker?.hub_result && hubResultRequiresManualIntervention(worker.hub_result)) {
    return false;
  }

  const normalizedWorkerId = row.worker.trim();
  return normalizedWorkerId.length > 0;
}

function resolvePreflightGateWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  capsuleGate?: CapsuleMaterializationGate
): string | null | undefined {
  const preflightRow = rows.find((row) => normalizeWorkerIdentifier(row.worker) === "PRE-FLIGHT" && !isHumanDispatchRow(row));
  if (!preflightRow) {
    return undefined;
  }

  const preflightState = resolveLifecycleWorkerState(lifecycleState, preflightRow.worker);
  if (preflightRow.status.trim() === "✅" || preflightState?.status === "completed") {
    return undefined;
  }

  if (
    isBlockedDispatchStatus(preflightRow.status)
    || preflightState?.status === "blocked"
    || isFrozenPendingHumanResolution(lifecycleState, preflightRow.worker)
    || (preflightState?.hub_result && hubResultRequiresManualIntervention(preflightState.hub_result))
  ) {
    return null;
  }

  const rowsByWorker = indexRowsByWorker(rows);
  if (isEligibleServiceContinueRow(preflightRow, rows, rowsByWorker, lifecycleState, capsuleGate)) {
    return preflightRow.worker.trim();
  }

  return preflightRow.status.trim() === "🔄" && isImplicitContinueRow(preflightRow, lifecycleState, capsuleGate)
    ? preflightRow.worker.trim()
    : null;
}

function isEligibleServiceContinueRow(
  row: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>,
  lifecycleState: DispatchThreadStateV2,
  capsuleGate?: CapsuleMaterializationGate
): boolean {
  if (isHumanDispatchRow(row)) {
    return false;
  }

  // Materialization precondition — the row is parked behind an unmaterialized
  // Context Capsule, not queued. Placed alongside the escalation freeze for the
  // same reason: this is the single gate every candidate resolver funnels
  // through (`resolveServiceContinueWorker` serial,
  // `resolveEligibleServiceContinueWorkers` parallel slot fill,
  // `resolveServiceContinueWorkerFromWorkerRows` watchdog sweep,
  // `countEligiblePendingServiceContinueWorkersFromWorkerRows` for the
  // pending-work count that arms slot fill), so covering it here covers all of
  // them at once. Without it, I-02..I-06 on
  // unification-layer-decoupling-2026-08-06 were admitted as ordinary ⬜ rows
  // with satisfied dependencies, launched against `⏳` capsules, and each burned
  // a worker plus a PM resolver before an operator filled the capsules by hand.
  if (capsuleGate?.(row.worker)) {
    return false;
  }

  if (hasAutomaticDispatchBlocker(row)) {
    return false;
  }

  // Escalation freeze — the row is parked awaiting a human, not queued.
  // This is the single gate every candidate resolver funnels through
  // (`resolveServiceContinueWorker` for the serial path,
  // `resolveEligibleServiceContinueWorkers` for the parallel slot filler,
  // `resolveServiceContinueWorkerFromWorkerRows` for the watchdog sweep,
  // `countEligiblePendingServiceContinueWorkersFromWorkerRows` for the
  // pending-work count that arms slot fill), so covering it here covers all of
  // them at once. Without it the dispatcher would correctly refuse another PM
  // resolver and then relaunch the row as ordinary pending work on the very
  // next tick — the BATCH-8-GATE shape on
  // unification-layer-decoupling-2026-08-06.
  if (isFrozenPendingHumanResolution(lifecycleState, row.worker)) {
    return false;
  }

  const trimmedStatus = row.status.trim();
  switch (trimmedStatus) {
    case "⚠️ ABANDONED":
      return isRetryableTerminalWorker(lifecycleState, row.worker);
    case "❌":
      return isRetryableTerminalWorker(lifecycleState, row.worker);
    case "⛔ BLOCKED":
      return false;
    case "⬜":
      return areDispatchDependenciesSatisfied(row, rows, rowsByWorker, lifecycleState);
    default:
      // fix_requested workers (🔁 FIX N/M) are eligible — they need feedback delivery
      if (trimmedStatus.startsWith("🔁")) {
        return true;
      }
      return false;
  }
}

function isRetryableTerminalWorker(lifecycleState: DispatchThreadStateV2, workerId: string): boolean {
  const workerState = resolveLifecycleWorkerState(lifecycleState, workerId);
  if (workerState?.status === "blocked") {
    return false;
  }

  if (hasExhaustedValidationCycles(workerState)) {
    return false;
  }

  if (workerState?.hub_result && hubResultRequiresManualIntervention(workerState.hub_result)) {
    return false;
  }

  return (workerState?.retry_count ?? 0) < MAX_AUTOMATIC_RECOVERY_RETRIES;
}

export function hasExhaustedValidationCycles(workerState: DispatchThreadStateV2["workers"][string] | undefined): boolean {
  const validation = workerState?.validation;
  if (!validation || validation.max_fix_cycles <= 0) {
    return false;
  }

  const completedCycles = Math.max(validation.current_cycle, validation.history.length);
  return completedCycles >= validation.max_fix_cycles;
}

function hubResultRequiresManualIntervention(
  hubResult: NonNullable<DispatchThreadStateV2["workers"][string]["hub_result"]>
): boolean {
  return hubResultContainsHitLimit(hubResult) || hubResultContainsBlockSignal(hubResult) || hubResultContainsFailureSignal(hubResult);
}

function areDispatchDependenciesSatisfied(
  row: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>,
  lifecycleState: DispatchThreadStateV2
): boolean {
  return normalizeDependsOnWorkers(row.depends_on).every((dependencyClause) => {
    const dependencyRows = resolveDependencyRows(dependencyClause, row, rows, rowsByWorker);
    return dependencyRows.length > 0 && dependencyRows.every((dependencyRow) => isDispatchDependencyTerminal(dependencyRow, lifecycleState));
  });
}

function normalizeDependsOnWorkers(dependsOn: string | string[] | undefined): string[] {
  const rawClauses = Array.isArray(dependsOn) ? dependsOn : [dependsOn];

  return rawClauses
    .flatMap((value) => splitDependencyClauses(value))
    .filter((value, index, clauses) => clauses.indexOf(value) === index);
}

export function hasAutomaticDispatchBlocker(
  row: Pick<DispatchContinuationPlanRow, "notes">
): boolean {
  const normalizedNotes = normalizeDependencyText(row.notes ?? "").replace(/\*/g, "");
  if (normalizedNotes.length === 0) {
    return false;
  }

  return AUTOMATIC_BLOCKER_NOTE_PATTERNS.some((pattern) => pattern.test(normalizedNotes));
}

const AUTOMATIC_BLOCKER_NOTE_PATTERNS = [
  /⏳\s*BLOCKED\b/i,
  /\bBLOCKED:\b/i,
  /\bDO\s+NOT\s+DISPATCH\s+UNTIL\b/i,
  /\bMUST\s+BE\s+CONFIRMED\s+FIRST\b/i
];

function splitDependencyClauses(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const trimmed = normalizeDependencyText(value);
  if (trimmed.length === 0 || trimmed === "—" || trimmed === "-") {
    return [];
  }

  return trimmed
    .split(/,|\s+\+\s+/)
    .map((clause) => normalizeDependencyText(clause))
    .filter((clause) => clause.length > 0 && clause !== "—" && clause !== "-");
}

function resolveDependencyRows(
  dependencyClause: string,
  currentRow: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>
): DispatchContinuationPlanRow[] {
  const allAboveRows = resolveAllAboveDependencyRows(dependencyClause, currentRow, rows);
  if (allAboveRows) {
    return allAboveRows;
  }

  const explicitRows = resolveExplicitDependencyRows(dependencyClause, rows, rowsByWorker);
  if (explicitRows.length > 0) {
    return explicitRows.filter((row) => row !== currentRow);
  }

  return resolveAllDependencyRows(dependencyClause, rows)
    .filter((row) => row !== currentRow);
}

function resolveAllAboveDependencyRows(
  dependencyClause: string,
  currentRow: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[]
): DispatchContinuationPlanRow[] | null {
  const normalizedClause = normalizeDependencyText(dependencyClause).toUpperCase();
  if (normalizedClause !== "ALL ABOVE" && normalizedClause !== "ALL PRIOR" && normalizedClause !== "ALL-PRIOR") {
    return null;
  }

  const currentIndex = rows.indexOf(currentRow);
  if (currentIndex <= 0) {
    return [];
  }

  return rows.slice(0, currentIndex);
}

function resolveExplicitDependencyRows(
  dependencyClause: string,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>
): DispatchContinuationPlanRow[] {
  const normalizedWorkerId = normalizeWorkerIdentifier(dependencyClause);
  const directMatch = rowsByWorker.get(normalizedWorkerId);
  if (directMatch) {
    return [directMatch];
  }

  const rangeMatches = resolveRangeDependencyRows(dependencyClause, rows);
  if (rangeMatches.length > 0) {
    return rangeMatches;
  }

  const suffixedRangeMatches = resolveSuffixedRangeDependencyRows(dependencyClause, rows);
  if (suffixedRangeMatches.length > 0) {
    return suffixedRangeMatches;
  }

  const parentheticalMatches = Array.from(
    dependencyClause.matchAll(/\(([^)]+)\)/g),
    (match) => match[1]
  ).flatMap((innerClause) => {
    return splitDependencyClauses(innerClause).flatMap((candidate) => resolveExplicitDependencyRows(candidate, rows, rowsByWorker));
  });
  if (parentheticalMatches.length > 0) {
    return dedupeRows(parentheticalMatches);
  }

  const embeddedMatches = rows.filter((row) => {
    const workerId = normalizeWorkerIdentifier(row.worker);
    return workerId.length > 0 && normalizedWorkerId.includes(workerId);
  });
  if (embeddedMatches.length > 0) {
    return embeddedMatches;
  }

  return [];
}

function resolveAllDependencyRows(
  dependencyClause: string,
  rows: DispatchContinuationPlanRow[]
): DispatchContinuationPlanRow[] {
  const normalizedClause = normalizeDependencyText(dependencyClause).toUpperCase();
  if (!normalizedClause.startsWith("ALL ")) {
    return [];
  }

  const parentheticalMatches = Array.from(
    dependencyClause.matchAll(/\(([^)]+)\)/g),
    (match) => match[1]
  ).flatMap((innerClause) => {
    return splitDependencyClauses(innerClause).flatMap((candidate) => resolveAllDependencyRows(candidate, rows));
  });

  const placeholderPrefix = resolveAllWorkerPrefix(normalizedClause);
  const prefixMatches = placeholderPrefix
    ? rows.filter((row) => normalizeWorkerIdentifier(row.worker).startsWith(placeholderPrefix))
    : [];

  const batchMatches = resolveBatchScopedDependencyRows(normalizedClause, rows);
  const implementationMatches = normalizedClause.includes("ALL IMPL") || normalizedClause.includes("ALL IMPLEMENTATION")
    ? rows.filter((row) => isImplementationDispatchRow(row))
    : [];

  return dedupeRows([
    ...parentheticalMatches,
    ...prefixMatches,
    ...batchMatches,
    ...implementationMatches
  ]);
}

function resolveAllWorkerPrefix(clause: string): string | null {
  const placeholderMatch = clause.match(/\b([A-ZΩ][A-Z0-9+-]*-)(?:XX|N)\b/);
  if (placeholderMatch?.[1]) {
    return placeholderMatch[1];
  }

  const workersMatch = clause.match(/\bALL\s+([A-ZΩ][A-Z0-9+-]*-)\s+WORKERS?\b/);
  if (workersMatch?.[1]) {
    return workersMatch[1];
  }

  const prefixedMatch = clause.match(/\bALL\s+([A-ZΩ][A-Z0-9+-]*-)\b/);
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1];
  }

  return null;
}

function resolveBatchScopedDependencyRows(
  clause: string,
  rows: DispatchContinuationPlanRow[]
): DispatchContinuationPlanRow[] {
  const numericBatchRanges = resolveNumericBatchRanges(clause);
  if (numericBatchRanges.length > 0) {
    return rows.filter((row) => {
      const batchNumber = parseNumericBatchIdentifier(row.batch);
      return batchNumber !== null && numericBatchRanges.some(([start, end]) => {
        return batchNumber >= start && batchNumber <= end;
      });
    });
  }

  const batchTokens = Array.from(clause.matchAll(/(?:Ω|OMEGA)(?:\+\d+)?/g), (match) => normalizeBatchIdentifier(match[0]));
  if (batchTokens.length === 0 || !clause.includes("WORKER")) {
    return [];
  }

  return rows.filter((row) => {
    const batch = normalizeBatchIdentifier(row.batch);
    return batchTokens.some((token) => batch.startsWith(token));
  });
}

function resolveNumericBatchRanges(clause: string): Array<[number, number]> {
  const normalizedClause = normalizeDependencyText(clause)
    .toUpperCase()
    .replace(/[–—]/g, "-")
    .replace(/\.\./g, "-")
    .replace(/\bTO\b/g, "-");
  const selectorMatch = normalizedClause.match(/\bBATCH(?:ES)?\s+(\d+(?:\s*-\s*\d+)?(?:\s*\/\s*\d+(?:\s*-\s*\d+)?)*)\b/);
  if (!selectorMatch?.[1]) {
    return [];
  }

  return selectorMatch[1]
    .split("/")
    .map((selector): [number, number] | null => {
      const parts = selector.split("-").map((part) => Number.parseInt(part.trim(), 10));
      const start = parts[0];
      const end = parts[1] ?? start;
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
      }

      return [Math.min(start, end), Math.max(start, end)];
    })
    .filter((range): range is [number, number] => range !== null);
}

// Resolves range dependency clauses that include a worker-id suffix word, e.g.
// "BATCH-1..BATCH-6 GATEs" → BATCH-1-GATE..BATCH-6-GATE. The plain
// `resolveRangeDependencyRows` strips whitespace before matching and therefore
// drops the trailing suffix, leaving these clauses unresolved.
function resolveSuffixedRangeDependencyRows(
  dependencyClause: string,
  rows: DispatchContinuationPlanRow[]
): DispatchContinuationPlanRow[] {
  const normalizedClause = normalizeDependencyText(dependencyClause)
    .toUpperCase()
    .replace(/[–—]/g, "-");
  const match = normalizedClause.match(
    /^([A-ZΩ][A-Z0-9+]*-)(\d+)\s*\.\.\s*(?:[A-ZΩ][A-Z0-9+]*-)?(\d+)\s+([A-Z][A-Z0-9-]*?)S?$/
  );
  if (!match) {
    return [];
  }

  const prefix = match[1] ?? "";
  const start = Number.parseInt(match[2] ?? "", 10);
  const end = Number.parseInt(match[3] ?? "", 10);
  const suffix = match[4] ?? "";
  if (!prefix || !suffix || !Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }

  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  const matched: DispatchContinuationPlanRow[] = [];

  for (let i = lower; i <= upper; i += 1) {
    const targetId = `${prefix}${i}-${suffix}`;
    const matchRow = rows.find((row) => normalizeWorkerIdentifier(row.worker) === targetId);
    if (matchRow) {
      matched.push(matchRow);
    }
  }

  return matched;
}

function resolveRangeDependencyRows(
  dependencyClause: string,
  rows: DispatchContinuationPlanRow[]
): DispatchContinuationPlanRow[] {
  const normalizedClause = normalizeDependencyText(dependencyClause)
    .toUpperCase()
    .replace(/[–—]/g, "-")
    .replace(/\.\./g, "-")
    .replace(/\s+/g, "");
  const match = normalizedClause.match(/^([A-ZΩ][A-Z0-9+]*-)(\d+)-(?:(?:([A-ZΩ][A-Z0-9+]*-))?(\d+))$/);
  if (!match) {
    return [];
  }

  const startPrefix = match[1];
  const endPrefix = match[3] ?? startPrefix;
  if (startPrefix !== endPrefix) {
    return [];
  }

  const start = Number.parseInt(match[2] ?? "", 10);
  const end = Number.parseInt(match[4] ?? "", 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }

  const lower = Math.min(start, end);
  const upper = Math.max(start, end);

  return rows.filter((row) => {
    const normalizedWorker = normalizeWorkerIdentifier(row.worker);
    const workerMatch = normalizedWorker.match(new RegExp(`^${escapeRegExp(startPrefix)}(\\d+)$`));
    if (!workerMatch?.[1]) {
      return false;
    }

    const workerNumber = Number.parseInt(workerMatch[1], 10);
    return Number.isFinite(workerNumber) && workerNumber >= lower && workerNumber <= upper;
  });
}

function indexRowsByWorker(rows: DispatchContinuationPlanRow[]): Map<string, DispatchContinuationPlanRow> {
  const rowsByWorker = new Map<string, DispatchContinuationPlanRow>();

  rows.forEach((row) => {
    const workerId = normalizeWorkerIdentifier(row.worker);
    if (!workerId || rowsByWorker.has(workerId)) {
      return;
    }

    rowsByWorker.set(workerId, row);
  });

  return rowsByWorker;
}

function resolveLifecycleWorkerState(
  lifecycleState: DispatchThreadStateV2,
  workerId: string
) {
  const normalizedWorkerId = normalizeWorkerIdentifier(workerId);
  const directMatch = lifecycleState.workers[workerId];
  if (directMatch) {
    return directMatch;
  }

  return Object.entries(lifecycleState.workers).find(([candidateWorkerId]) => {
    return normalizeWorkerIdentifier(candidateWorkerId) === normalizedWorkerId;
  })?.[1];
}

function dedupeRows(rows: DispatchContinuationPlanRow[]): DispatchContinuationPlanRow[] {
  const seenWorkers = new Set<string>();

  return rows.filter((row) => {
    const workerId = normalizeWorkerIdentifier(row.worker);
    if (!workerId || seenWorkers.has(workerId)) {
      return false;
    }

    seenWorkers.add(workerId);
    return true;
  });
}

function isImplementationDispatchRow(row: DispatchContinuationPlanRow): boolean {
  const workerId = normalizeWorkerIdentifier(row.worker);
  if (!workerId || isHumanDispatchRow(row)) {
    return false;
  }

  if (
    workerId === "PRE-FLIGHT"
    || workerId === "DELTA-CHECK"
    || workerId === "PR-REVIEW"
    || workerId === "SUMMARY-GATE"
    || workerId === "MERGE BLOCKED"
    || workerId === "MERGE APPROVED"
    || workerId.startsWith("BATCH-")
    || workerId.startsWith("PM-DECIDE-")
    || workerId.startsWith("V-")
    || workerId.startsWith("C-")
  ) {
    return false;
  }

  return true;
}

function normalizeDependencyText(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWorkerIdentifier(value: string | null | undefined): string {
  const normalized = normalizeDependencyText(value)
    .replace(/^[^A-Za-z0-9Ω]+/u, "")
    .toUpperCase();

  return normalized;
}

function normalizeBatchIdentifier(value: string | null | undefined): string {
  return normalizeDependencyText(value)
    .toUpperCase()
    .replace(/^OMEGA/, "Ω")
    .replace(/\s+/g, "")
    .replace(/=\d+$/g, "");
}

function parseNumericBatchIdentifier(value: string | null | undefined): number | null {
  const normalized = normalizeBatchIdentifier(value);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDispatchDependencyTerminal(
  row: DispatchContinuationPlanRow,
  lifecycleState: DispatchThreadStateV2
): boolean {
  const worker = resolveLifecycleWorkerState(lifecycleState, row.worker);
  if (worker?.status === "completed" || worker?.status === "skipped") {
    return true;
  }

  const normalized = row.status?.trim();
  return normalized === "✅" || normalized === "⛔ SKIPPED";
}

function isBlockedDispatchStatus(status: string | undefined): boolean {
  return /\bBLOCKED\b/i.test(status?.trim() ?? "");
}
