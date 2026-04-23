import * as fs from "node:fs";
import path from "node:path";

import type {
  SchedulerConfig,
  SchedulerRunSummary,
  SchedulerRunWorkerSummary,
  TerminalOutcome,
  DispatchThreadStateV2
} from "../../types";

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

  // Copy plan snapshot
  const planContent = safeReadFile(planPath);
  if (planContent !== null) {
    fs.writeFileSync(path.join(archiveDir, "dispatch_plan.md"), planContent, "utf8");
  }

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

  // Copy worker outputs
  const workerOutputsDir = path.join(archiveDir, "worker_outputs");
  const workerSummaries = copyWorkerOutputs(lifecycleState, planDir, workerOutputsDir);

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
  const planSnapshotMatches = currentPlanContent === planContent;

  return {
    archiveDir,
    reportPath,
    jsonReportPath,
    planSnapshotMatches
  };
}

function copyWorkerOutputs(
  lifecycleState: DispatchThreadStateV2 | null,
  planDir: string,
  outputsDir: string
): SchedulerRunWorkerSummary[] {
  const summaries: SchedulerRunWorkerSummary[] = [];

  if (!lifecycleState || !lifecycleState.workers) {
    return summaries;
  }

  let outputsDirCreated = false;

  for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
    const summary: SchedulerRunWorkerSummary = {
      worker_id: workerId,
      status: worker.status,
      thread_id: worker.thread_id || undefined,
      retry_count: worker.retry_count ?? 0
    };

    // Try copying worker report files from common locations
    const reportCandidates = [
      path.join(planDir, "reports", `${workerId}.md`),
      path.join(planDir, "reports", `${workerId}_report.md`)
    ];

    // Also check expected_outputs
    if (worker.expected_outputs) {
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
