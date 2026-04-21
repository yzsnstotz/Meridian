import type { DispatchThreadStateV2 } from "../../types";

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

export function resolveServiceContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  return resolveImplicitContinueWorker(rows, lifecycleState)
    ?? resolveFirstEligibleContinueWorker(rows, lifecycleState);
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

  if (hasAutomaticDispatchBlocker(row)) {
    return null;
  }

  const worker = resolveLifecycleWorkerState(lifecycleState, row.worker);
  if (worker?.status === "running" && worker.thread_id.trim().length > 0) {
    return null;
  }

  // Don't re-dispatch workers that already reached a terminal success state.
  // The plan markdown may still show 🔄 due to a stale sync, but the lifecycle
  // store is authoritative. Re-dispatching a completed/skipped worker would
  // reset it to pending and cause an infinite re-dispatch loop.
  if (worker?.status === "completed" || worker?.status === "skipped") {
    return null;
  }

  const normalizedWorkerId = row.worker.trim();
  return normalizedWorkerId.length > 0 ? normalizedWorkerId : null;
}

function resolveFirstEligibleContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  const rowsByWorker = indexRowsByWorker(rows);
  const eligibleWorkers = rows
    .filter((row) => isEligibleServiceContinueRow(row, rows, rowsByWorker, lifecycleState))
    .map((row) => row.worker.trim())
    .filter((workerId) => workerId.length > 0);

  return eligibleWorkers[0] ?? null;
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

  switch (row.status.trim()) {
    case "⚠️ ABANDONED":
      return true;
    case "❌":
      return (resolveLifecycleWorkerState(lifecycleState, row.worker)?.retry_count ?? 0) < 2;
    case "⬜":
      return areDispatchDependenciesSatisfied(row, rows, rowsByWorker);
    default:
      return false;
  }
}

function areDispatchDependenciesSatisfied(
  row: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>
): boolean {
  return normalizeDependsOnWorkers(row.depends_on).every((dependencyClause) => {
    const dependencyRows = resolveDependencyRows(dependencyClause, row, rows, rowsByWorker);
    return dependencyRows.length > 0 && dependencyRows.every((dependencyRow) => isDispatchDependencyTerminal(dependencyRow.status));
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
  if (trimmed.length === 0 || trimmed === "—") {
    return [];
  }

  return trimmed
    .split(/,|\s+\+\s+/)
    .map((clause) => normalizeDependencyText(clause))
    .filter((clause) => clause.length > 0 && clause !== "—");
}

function resolveDependencyRows(
  dependencyClause: string,
  currentRow: DispatchContinuationPlanRow,
  rows: DispatchContinuationPlanRow[],
  rowsByWorker: Map<string, DispatchContinuationPlanRow>
): DispatchContinuationPlanRow[] {
  const explicitRows = resolveExplicitDependencyRows(dependencyClause, rows, rowsByWorker);
  if (explicitRows.length > 0) {
    return explicitRows.filter((row) => row !== currentRow);
  }

  return resolveAllDependencyRows(dependencyClause, rows)
    .filter((row) => row !== currentRow);
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
  const batchTokens = Array.from(clause.matchAll(/(?:Ω|OMEGA)(?:\+\d+)?/g), (match) => normalizeBatchIdentifier(match[0]));
  if (batchTokens.length === 0 || !clause.includes("WORKER")) {
    return [];
  }

  return rows.filter((row) => {
    const batch = normalizeBatchIdentifier(row.batch);
    return batchTokens.some((token) => batch.startsWith(token));
  });
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDispatchDependencyTerminal(status: string | undefined): boolean {
  const normalized = status?.trim();
  return normalized === "✅" || normalized === "⛔ SKIPPED";
}
