import type { DispatchThreadStateV2 } from "../../types";
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
}

export interface DispatchContinuationWorkerRow {
  status: string;
  batch?: string | null;
  worker_id: string;
  model: string | null;
  depends_on: string[];
  notes?: string | null;
}

export interface ResolveEligibleServiceContinueWorkersOptions {
  limit?: number;
}

export function resolveServiceContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  return resolveEligibleServiceContinueWorkers(rows, lifecycleState, { limit: 1 })[0] ?? null;
}

export function resolveEligibleServiceContinueWorkers(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  options: ResolveEligibleServiceContinueWorkersOptions = {}
): string[] {
  const limit = options.limit && options.limit > 0
    ? Math.floor(options.limit)
    : Number.POSITIVE_INFINITY;
  const preflightGateWorker = resolvePreflightGateWorker(rows, lifecycleState);
  if (preflightGateWorker !== undefined) {
    return preflightGateWorker ? [preflightGateWorker].slice(0, limit) : [];
  }

  const implicitWorker = resolveImplicitContinueWorker(rows, lifecycleState);
  if (implicitWorker) {
    return [implicitWorker].slice(0, limit);
  }

  const rowsByWorker = indexRowsByWorker(rows);
  const eligibleWorkers: string[] = [];
  for (const row of rows) {
    if (!isEligibleServiceContinueRow(row, rows, rowsByWorker, lifecycleState)) {
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

    // Validator-decided terminal failure: the worker reached
    // max_fix_cycles and the orchestrator stamped `failed`. The operator
    // owns the verdict from this point (force-complete, skip, or accept
    // the failure); the dispatcher cannot auto-recover and PM has no role
    // here either. The plan row may still render as ⛔ BLOCKED because
    // `resolveDisplayStatus` reflects a stale block-signal in
    // `hub_result` for failed workers — without this skip, every continue
    // tick re-flags the dead worker as `manual_intervention_required` and
    // blocks every downstream worker (observed: M-01 wedged on
    // agent-dispatcher-9fd97803, M-02 stuck `awaiting_validation` for
    // 1.5h because Phase 1 of `processValidationQueue` never ran).
    if (
      workerState?.status === "failed"
      && (workerState.validation?.history?.length ?? 0) >= (workerState.validation?.max_fix_cycles ?? Infinity)
    ) {
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
      notes: row.notes ?? null
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
  lifecycleState: DispatchThreadStateV2
): string | null {
  return resolveServiceContinueWorker(
    rows.map((row) => ({
      status: row.status,
      batch: row.batch ?? null,
      worker: row.worker_id,
      model: row.model,
      depends_on: row.depends_on,
      notes: row.notes ?? null
    })),
    lifecycleState
  );
}

export function countEligiblePendingServiceContinueWorkersFromWorkerRows(
  rows: DispatchContinuationWorkerRow[],
  lifecycleState: DispatchThreadStateV2
): number {
  const normalizedRows = rows.map((row) => ({
    status: row.status,
    batch: row.batch ?? null,
    worker: row.worker_id,
    model: row.model,
    depends_on: row.depends_on,
    notes: row.notes ?? null
  }));
  const rowsByWorker = indexRowsByWorker(normalizedRows);

  return normalizedRows.filter((row) => {
    return row.status.trim() === "⬜" && isEligibleServiceContinueRow(row, normalizedRows, rowsByWorker, lifecycleState);
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
  lifecycleState: DispatchThreadStateV2
): string | null {
  const runningRows = rows.filter((row) => row.status === "🔄" && !isHumanDispatchRow(row));
  if (runningRows.length !== 1) {
    return null;
  }

  const [row] = runningRows;
  if (!row) {
    return null;
  }

  return isImplicitContinueRow(row, lifecycleState)
    ? row.worker.trim()
    : null;
}

function isImplicitContinueRow(
  row: DispatchContinuationPlanRow,
  lifecycleState: DispatchThreadStateV2
): boolean {
  if (hasAutomaticDispatchBlocker(row)) {
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
  lifecycleState: DispatchThreadStateV2
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
    || (preflightState?.hub_result && hubResultRequiresManualIntervention(preflightState.hub_result))
  ) {
    return null;
  }

  const rowsByWorker = indexRowsByWorker(rows);
  if (isEligibleServiceContinueRow(preflightRow, rows, rowsByWorker, lifecycleState)) {
    return preflightRow.worker.trim();
  }

  return preflightRow.status.trim() === "🔄" && isImplicitContinueRow(preflightRow, lifecycleState)
    ? preflightRow.worker.trim()
    : null;
}

function isEligibleServiceContinueRow(
  row: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>,
  lifecycleState: DispatchThreadStateV2
): boolean {
  if (isHumanDispatchRow(row)) {
    return false;
  }

  if (hasAutomaticDispatchBlocker(row)) {
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

  if (workerState?.hub_result && hubResultRequiresManualIntervention(workerState.hub_result)) {
    return false;
  }

  return (workerState?.retry_count ?? 0) < MAX_AUTOMATIC_RECOVERY_RETRIES;
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
