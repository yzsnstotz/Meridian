import * as fs from "node:fs";
import path from "node:path";

import type {
  SchedulerConfig,
  SchedulerRunSummary,
  SchedulerRunWorkerSummary,
  TerminalOutcome,
  DispatchThreadStateV2
} from "../../types";
import { LifecycleStore, hubResultContainsBlockSignal, hubResultContainsFailureSignal } from "../agent-dispatcher/lifecycle-store";
import { parseDispatchPlanRows, type DispatchPlanWorkerRow } from "../../tool-gateway/tools/dispatch-status";

const DISPATCHER_WORKER_ID = "DISPATCHER";

export interface ArchiveContext {
  runId: string;
  config: SchedulerConfig;
  actualStartTime: string;
  completedTime: string;
  dispatcherThreadId: string | null;
  terminalOutcome: TerminalOutcome;
  completedCycles: number;
  plannedStartTime: string | null;
}

export interface ArchiveResult {
  archiveDir: string;
  reportPath: string;
  jsonReportPath: string;
  planSnapshotMatches: boolean;
}

export function archiveRun(ctx: ArchiveContext): ArchiveResult {
  const archiveDir = path.join(ctx.config.report_base_dir, "runs", ctx.runId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const planPath = ctx.config.dispatch_plan_path;
  const planDir = path.dirname(planPath);
  const threadsPath = path.join(planDir, "dispatch_threads.json");

  // Copy lifecycle sidecar snapshot
  const threadsContent = safeReadFile(threadsPath);
  let lifecycleState: DispatchThreadStateV2 | null = null;
  if (threadsContent !== null) {
    fs.writeFileSync(path.join(archiveDir, "dispatch_threads.json"), threadsContent, "utf8");
    try {
      lifecycleState = JSON.parse(threadsContent) as DispatchThreadStateV2;
    } catch {
      // ignore parse errors
    }
  }

  // Copy plan snapshot. Render it through the lifecycle sidecar first so the
  // archived plan cannot preserve stale markdown statuses that disagree with
  // worker output evidence.
  const sourcePlanContent = safeReadFile(planPath);
  const planContent = sourcePlanContent !== null
    ? renderArchivePlanSnapshot(sourcePlanContent, threadsPath, planPath, lifecycleState)
    : null;
  if (planContent !== null) {
    fs.writeFileSync(path.join(archiveDir, "dispatch_plan.md"), planContent, "utf8");
  }

  // Copy worker outputs
  const workerOutputsDir = path.join(archiveDir, "worker_outputs");
  const planRows = planContent ? parseDispatchPlanRows(planContent) : [];
  const workerSummaries = copyWorkerOutputs(
    lifecycleState,
    planRows,
    planDir,
    ctx.config.report_base_dir,
    archiveDir,
    workerOutputsDir
  );

  // Build run summary
  const durationMs = new Date(ctx.completedTime).getTime() - new Date(ctx.actualStartTime).getTime();
  const durationSeconds = Math.round(durationMs / 1000);

  const runSummary: SchedulerRunSummary = {
    run_id: ctx.runId,
    scheduler_mode: ctx.config.scheduler_mode,
    planned_start_time: ctx.plannedStartTime,
    actual_start_time: ctx.actualStartTime,
    completed_time: ctx.completedTime,
    duration_seconds: durationSeconds,
    dispatcher_thread_id: ctx.dispatcherThreadId,
    terminal_outcome: ctx.terminalOutcome,
    workers: workerSummaries
  };

  // Generate reports
  const reportPath = path.join(archiveDir, "report.md");
  const jsonReportPath = path.join(archiveDir, "report.json");

  fs.writeFileSync(reportPath, buildMarkdownReport(runSummary, ctx), "utf8");
  fs.writeFileSync(jsonReportPath, `${JSON.stringify(runSummary, null, 2)}\n`, "utf8");

  // Return snapshot match status for reset safety check
  const currentPlanContent = safeReadFile(planPath);
  const planSnapshotMatches = currentPlanContent === sourcePlanContent;

  return {
    archiveDir,
    reportPath,
    jsonReportPath,
    planSnapshotMatches
  };
}

function renderArchivePlanSnapshot(
  planContent: string,
  threadsPath: string,
  planPath: string,
  lifecycleState: DispatchThreadStateV2 | null
): string {
  if (!lifecycleState) {
    return planContent;
  }

  try {
    return new LifecycleStore(threadsPath, { dispatchPlanPath: planPath }).toPlanMarkdown(planContent);
  } catch {
    return planContent;
  }
}

function copyWorkerOutputs(
  lifecycleState: DispatchThreadStateV2 | null,
  planRows: DispatchPlanWorkerRow[],
  planDir: string,
  reportBaseDir: string,
  archiveDir: string,
  outputsDir: string
): SchedulerRunWorkerSummary[] {
  const summaries: SchedulerRunWorkerSummary[] = [];

  let outputsDirCreated = false;
  const workerEntries = buildArchiveWorkerEntries(lifecycleState, planRows);

  for (const { workerId, planRow } of workerEntries) {
    const worker = lifecycleState?.workers?.[workerId];
    const summary: SchedulerRunWorkerSummary = {
      worker_id: workerId,
      status: getWorkerArchiveStatus(worker, planRow),
      thread_id: worker?.thread_id || undefined,
      retry_count: worker?.retry_count ?? 0
    };

    // Try copying worker report files from common locations
    const reportCandidates = [
      path.join(archiveDir, `${workerId}.md`),
      path.join(archiveDir, `${workerId}_report.md`),
      path.join(archiveDir, `${workerId}.json`),
      path.join(reportBaseDir, `${workerId}.md`),
      path.join(reportBaseDir, `${workerId}_report.md`),
      path.join(reportBaseDir, `${workerId}.json`),
      path.join(planDir, "reports", `${workerId}.md`),
      path.join(planDir, "reports", `${workerId}_report.md`)
    ];

    // Also check expected_outputs
    if (worker?.expected_outputs) {
      for (const outputPath of worker.expected_outputs) {
        if (outputPath.endsWith(".md") || outputPath.endsWith(".json")) {
          reportCandidates.push(outputPath);
        }
      }
    }

    for (const candidate of reportCandidates) {
      if (fs.existsSync(candidate)) {
        if (!outputsDirCreated) {
          fs.mkdirSync(outputsDir, { recursive: true });
          outputsDirCreated = true;
        }

        const destName = `${workerId}${path.extname(candidate)}`;
        const destPath = path.join(outputsDir, destName);
        try {
          fs.copyFileSync(candidate, destPath);
          summary.report_path = destPath;
        } catch {
          // ignore copy failures
        }
        break;
      }
    }

    summaries.push(summary);
  }

  return summaries;
}

function buildArchiveWorkerEntries(
  lifecycleState: DispatchThreadStateV2 | null,
  planRows: DispatchPlanWorkerRow[]
): Array<{ workerId: string; planRow: DispatchPlanWorkerRow | null }> {
  const entries = new Map<string, { workerId: string; planRow: DispatchPlanWorkerRow | null }>();

  for (const row of planRows) {
    entries.set(row.worker_id, { workerId: row.worker_id, planRow: row });
  }

  if (lifecycleState?.workers) {
    for (const workerId of Object.keys(lifecycleState.workers)) {
      if (workerId === DISPATCHER_WORKER_ID) {
        continue;
      }
      if (!entries.has(workerId)) {
        entries.set(workerId, { workerId, planRow: null });
      }
    }
  }

  return Array.from(entries.values());
}

function getWorkerArchiveStatus(
  worker: DispatchThreadStateV2["workers"][string] | undefined,
  planRow: DispatchPlanWorkerRow | null
): string {
  if (worker) {
    if (worker.status !== "blocked" && worker.hub_result && hubResultContainsBlockSignal(worker.hub_result)) {
      return "blocked";
    }

    if (worker.status !== "failed" && worker.hub_result && hubResultContainsFailureSignal(worker.hub_result)) {
      return "failed";
    }

    return worker.status;
  }

  if (planRow) {
    return planRow.status;
  }

  return "missing";
}

function buildMarkdownReport(summary: SchedulerRunSummary, ctx: ArchiveContext): string {
  const lines: string[] = [
    `# Scheduler Run Report`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Run ID | ${summary.run_id} |`,
    `| Mode | ${summary.scheduler_mode} |`,
    `| Terminal Outcome | ${summary.terminal_outcome ?? "unknown"} |`,
    `| Planned Start | ${summary.planned_start_time ?? "—"} |`,
    `| Actual Start | ${summary.actual_start_time} |`,
    `| Completed | ${summary.completed_time ?? "—"} |`,
    `| Duration | ${summary.duration_seconds !== null ? `${summary.duration_seconds}s` : "—"} |`,
    `| Dispatcher Thread | ${summary.dispatcher_thread_id ?? "—"} |`,
    `| Completed Cycles | ${ctx.completedCycles} |`,
    `| Dispatch Plan | ${ctx.config.dispatch_plan_path} |`,
    ``
  ];

  if (summary.workers.length > 0) {
    lines.push(`## Workers`);
    lines.push(``);
    lines.push(`| Worker | Status | Thread | Retries | Report |`);
    lines.push(`|--------|--------|--------|---------|--------|`);

    for (const worker of summary.workers) {
      lines.push(
        `| ${worker.worker_id} | ${worker.status} | ${worker.thread_id ?? "—"} | ${worker.retry_count} | ${worker.report_path ?? "—"} |`
      );
    }

    lines.push(``);
  }

  return lines.join("\n");
}

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
