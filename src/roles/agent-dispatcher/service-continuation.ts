import type { DispatchThreadStateV2 } from "../../types";

export interface DispatchContinuationPlanRow {
  status: string;
  worker: string;
  model: string;
  depends_on: string;
}

export function resolveServiceContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  return resolveImplicitContinueWorker(rows, lifecycleState)
    ?? resolveFirstEligibleContinueWorker(rows, lifecycleState);
}

export function isHumanDispatchRow(row: Pick<DispatchContinuationPlanRow, "model">): boolean {
  const model = row.model.trim().toUpperCase();
  return model === "HUMAN" || model === "PM";
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

  const worker = lifecycleState.workers[row.worker];
  if (worker?.status === "running" && worker.thread_id.trim().length > 0) {
    return null;
  }

  const normalizedWorkerId = row.worker.trim();
  return normalizedWorkerId.length > 0 ? normalizedWorkerId : null;
}

function resolveFirstEligibleContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  const rowsByWorker = new Map(rows.map((row) => [row.worker, row]));
  const eligibleWorkers = rows
    .filter((row) => isEligibleServiceContinueRow(row, rowsByWorker, lifecycleState))
    .map((row) => row.worker.trim())
    .filter((workerId) => workerId.length > 0);

  return eligibleWorkers[0] ?? null;
}

function isEligibleServiceContinueRow(
  row: DispatchContinuationPlanRow,
  rowsByWorker: Map<string, DispatchContinuationPlanRow>,
  lifecycleState: DispatchThreadStateV2
): boolean {
  if (isHumanDispatchRow(row)) {
    return false;
  }

  switch (row.status.trim()) {
    case "⚠️ ABANDONED":
      return true;
    case "❌":
      return (lifecycleState.workers[row.worker]?.retry_count ?? 0) < 2;
    case "⬜":
      return areDispatchDependenciesSatisfied(row, rowsByWorker);
    default:
      return false;
  }
}

function areDispatchDependenciesSatisfied(
  row: DispatchContinuationPlanRow,
  rowsByWorker: Map<string, DispatchContinuationPlanRow>
): boolean {
  return parseDependsOnWorkers(row.depends_on).every((dependencyWorkerId) => {
    const dependencyRow = rowsByWorker.get(dependencyWorkerId);
    return dependencyRow ? isDispatchDependencyTerminal(dependencyRow.status) : false;
  });
}

function parseDependsOnWorkers(dependsOn: string | undefined): string[] {
  if (!dependsOn) {
    return [];
  }

  const trimmed = dependsOn.trim();
  if (trimmed.length === 0 || trimmed === "—") {
    return [];
  }

  return trimmed
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "—");
}

function isDispatchDependencyTerminal(status: string | undefined): boolean {
  const normalized = status?.trim();
  return normalized === "✅" || normalized === "⛔ SKIPPED";
}
