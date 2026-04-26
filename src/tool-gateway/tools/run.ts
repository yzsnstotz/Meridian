import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import { ROLES_SERVICE_ID } from "../../config";
import { reconcile } from "../../roles/agent-dispatcher/reconciler";
import { createMeridianApiClient, type MeridianRunResult } from "../../roles/agent-dispatcher/meridian-api-client";
import { KillPolicySchema, type DispatchWorkerState, type HubMessage, type HubResult, type HubRunState, type KillPolicy } from "../../types";
import { LifecycleStore, isExplicitCompletionContent } from "../../roles/agent-dispatcher/lifecycle-store";
import { sendViaHttpRelay } from "../ipc-bridge";
import killTool from "./kill";
import type { ToolDefinition, ToolResult } from "../registry";

const DEV_HISTORY_DIRECTORY = "dev_history";
const DISPATCHER_WORKER_ID = "DISPATCHER";
const DISPATCH_PLAN_FILENAME = "dispatch_plan.md";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const SCHEDULER_STATE_FILENAME = "scheduler_state.json";
const INTERRUPTED_ERROR = "interrupted";
const INTERRUPT_MESSAGES = new Set(["Tool Gateway interrupted by SIGINT", INTERRUPTED_ERROR]);
const MAX_PREVIOUS_REPLY_CHARS = 6_000;
const MAX_PREVIOUS_REPORT_CHARS = 6_000;
const MAX_PREVIOUS_REPORT_FILES = 2;
const MAX_WORKER_RETRIES = 3;
const TRANSIENT_RUN_RETRY_DELAYS_MS = [5_000, 15_000];
const TRANSIENT_ERROR_PATTERNS = [
  /timed?\s*out/i,
  /overloaded/i,
  /too many requests/i,
  /rate.limit/i,
  /service.unavailable/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /\bfetch failed\b/i,
  /\bunreachable\b/i
];

const runTool: ToolDefinition = {
  name: "run",
  description: "Run a command file in an existing coding agent thread through Meridian Hub",
  params: {
    thread_id: {
      type: "string",
      required: true,
      description: "Thread identifier returned from meridian-tool spawn"
    },
    command: {
      type: "string",
      required: true,
      description: "Absolute path to the command file that Hub should run"
    },
    worker: {
      type: "string",
      required: true,
      description: "Worker identifier for CLI status reporting"
    },
    kill_policy: {
      type: "string",
      required: false,
      description: "Optional cleanup policy for terminal worker threads: always, on_success, or never"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const threadId = requireParam(params.thread_id, "thread_id");
    if (!threadId) {
      return missingParam("thread_id");
    }

    const commandPath = requireParam(params.command, "command");
    if (!commandPath) {
      return missingParam("command");
    }

    const worker = requireParam(params.worker, "worker");
    if (!worker) {
      return missingParam("worker");
    }

    const killPolicy = parseKillPolicy(params.kill_policy);
    if (!killPolicy) {
      return {
        ok: false,
        error: `Unsupported kill_policy: ${params.kill_policy}`
      };
    }

    let interrupted = false;
    const handleSigint = (): void => {
      interrupted = true;
    };

    process.once("SIGINT", handleSigint);

    const traceId = randomUUID();
    const lifecycleStore = createLifecycleStore(commandPath);

    try {
      const workerRow = await resolveWorkerRow(commandPath, worker);
      const expectedOutputs = await deriveExpectedOutputs(commandPath, worker);
      const previousWorkerState = lifecycleStore.load().workers[worker] as DispatchWorkerState | undefined;

      // Guard: refuse to re-dispatch a worker that already completed or was
      // skipped. The AI dispatcher can mistakenly re-dispatch a finished worker
      // when it doesn't see the terminal state (e.g. relay timeout lost the
      // result). Without this guard, recordWorkerStart would overwrite the
      // completed state back to "running" and revert the plan markdown.
      if (previousWorkerState && (previousWorkerState.status === "completed" || previousWorkerState.status === "skipped")) {
        const summary = previousWorkerState.hub_result?.content ?? `Worker ${worker} already ${previousWorkerState.status}`;
        return {
          ok: true,
          data: {
            worker,
            thread_id: previousWorkerState.thread_id,
            status: "done",
            run_state: "completed",
            summary: `[already ${previousWorkerState.status}] ${summary}`
          }
        };
      }

      const preamble = await buildWorkerPreamble(
        worker,
        workerRow,
        commandPath,
        previousWorkerState ?? null,
        expectedOutputs
      );
      lifecycleStore.recordWorkerStart(worker, threadId, traceId, expectedOutputs, preamble);

      // Enforce max retry cap to prevent infinite retry loops. The AI dispatcher
      // can re-dispatch failed workers without going through the service-continuation
      // retry gate (which checks retry_count < 2). recordWorkerStart auto-increments
      // retry_count when restarting from a terminal state, so we check it here.
      const retryCount = lifecycleStore.load().workers[worker]?.retry_count ?? 0;
      if (retryCount > MAX_WORKER_RETRIES) {
        const exhaustedResult: HubResult = {
          trace_id: traceId,
          thread_id: threadId,
          source: "codex",
          status: "error",
          run_state: "timeout",
          content: `Worker ${worker} exceeded maximum retry count (${MAX_WORKER_RETRIES}). Marking as permanently failed to prevent infinite retry loops.`,
          attachments: [],
          timestamp: new Date().toISOString()
        };
        lifecycleStore.recordWorkerResult(worker, exhaustedResult);
        return failedResult(worker, threadId, exhaustedResult.content);
      }

      const client = createMeridianApiClient();
      const apiResult = await runWithTransientRetry(client, threadId, preamble);
      const result = toHubResult(apiResult, traceId);
      lifecycleStore.recordWorkerResult(worker, result);
      await reconcileAfterTerminalResult(lifecycleStore, result);
      const lifecycleStatus = lifecycleStore.load().workers[worker]?.status;
      await cleanupWorkerThread(threadId, result, killPolicy, lifecycleStatus);
      return mapRunResult(result, worker, threadId);
    } catch (error) {
      const resolvedError = asError(error);
      console.error("run tool execution failed", {
        worker,
        threadId,
        error: resolvedError.message
      });

      // When the run-tool HTTP call fails with a transient error after the
      // request reached Meridian, the remote worker may still be executing.
      // Recording a synthetic "failed/timeout" hub_result would cause the
      // reconciler to mark the worker as terminal before the agent has had a
      // chance to finish. Instead, leave those workers as "running" and let the
      // reconciler / watchdog validate the actual thread status and outputs.
      //
      // Some Meridian API unreachable errors are different: if the connection
      // failed before the request could reach Meridian, the command cannot have
      // reached the agent. Reset that worker to pending so scheduler continuation
      // can retry it. Header timeouts are intentionally excluded because the
      // server may have accepted the request and started the worker before the
      // client saw response headers.
      //
      // Only record a synthetic failure for non-transient errors (e.g. 4xx
      // client errors, malformed responses) where the worker genuinely cannot
      // have started or will never produce a result.
      if (isUndeliveredRunRequestError(resolvedError)) {
        try {
          lifecycleStore.setWorkerStatus(worker, "pending", "run_tool_delivery_unreachable", {
            clearHubResult: true,
            incrementRetryCount: true
          });
        } catch (lifecycleError) {
          console.warn("run tool failed to reset undelivered worker for retry", {
            worker,
            threadId,
            error: asError(lifecycleError).message
          });
        }
      } else if (!isTransientError(resolvedError)) {
        try {
          const syntheticResult: HubResult = {
            trace_id: traceId,
            thread_id: threadId,
            source: "codex",
            status: "error",
            run_state: "timeout",
            content: resolvedError.message,
            attachments: [],
            timestamp: new Date().toISOString()
          };
          lifecycleStore.recordWorkerResult(worker, syntheticResult);
        } catch (lifecycleError) {
          console.warn("run tool failed to record error in lifecycle store", {
            worker,
            threadId,
            error: asError(lifecycleError).message
          });
        }
      } else {
        console.warn("run tool transient error — worker left as running for reconciler validation", {
          worker,
          threadId,
          error: resolvedError.message
        });
      }

      if (interrupted || INTERRUPT_MESSAGES.has(resolvedError.message)) {
        return interruptedResult(worker, threadId);
      }

      return failedResult(worker, threadId, resolvedError.message);
    } finally {
      process.removeListener("SIGINT", handleSigint);
    }
  }
};

export default runTool;

function toHubResult(apiResult: MeridianRunResult, traceId: string): HubResult {
  const raw = apiResult.raw;
  return {
    trace_id: typeof raw.trace_id === "string" ? raw.trace_id : traceId,
    thread_id: apiResult.threadId,
    source: (typeof raw.source === "string" ? raw.source : "codex") as HubResult["source"],
    status: (apiResult.status || "success") as HubResult["status"],
    run_state: apiResult.runState as HubRunState | undefined,
    content: apiResult.content ?? "",
    summary_text: typeof raw.summary_text === "string" ? raw.summary_text : undefined,
    details_text: typeof raw.details_text === "string" ? raw.details_text : undefined,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString()
  };
}

function createLifecycleStore(commandPath: string): LifecycleStore {
  return new LifecycleStore(path.join(path.dirname(commandPath), DISPATCH_THREADS_FILENAME));
}

async function reconcileAfterTerminalResult(lifecycleStore: LifecycleStore, result: HubResult): Promise<void> {
  if (inferRunState(result) !== "completed" && !isExplicitCompletionContent(result.content)) {
    return;
  }

  try {
    await reconcile(lifecycleStore, {
      serviceId: ROLES_SERVICE_ID,
      sendRequest: (message: HubMessage) => sendViaHttpRelay(message, 0)
    } as unknown as A2AClient);
  } catch (error) {
    console.warn("run tool reconciliation failed", {
      filePath: lifecycleStore.filePath,
      error: asError(error).message
    });
  }
}

async function cleanupWorkerThread(
  threadId: string,
  result: HubResult,
  killPolicy: KillPolicy,
  lifecycleStatus?: string
): Promise<void> {
  if (lifecycleStatus === "running" || lifecycleStatus === "awaiting_validation" || lifecycleStatus === "fix_requested") {
    return;
  }

  if (!shouldKillAfterResult(result, killPolicy)) {
    return;
  }

  try {
    const killResult = await killTool.execute({ thread_id: threadId });
    if (!killResult.ok) {
      console.warn("run tool terminal kill failed", {
        threadId,
        killPolicy,
        error: killResult.error ?? "Kill failed"
      });
    }
  } catch (error) {
    console.warn("run tool terminal kill failed", {
      threadId,
      killPolicy,
      error: asError(error).message
    });
  }
}

export interface DispatchPlanRow {
  worker: string;
  task?: string;
  model?: string;
  dependsOn?: string;
  notes?: string;
  reportFile?: string;
}

async function buildWorkerPreamble(
  workerId: string,
  row: DispatchPlanRow | null,
  commandPath: string,
  previousWorkerState: DispatchWorkerState | null,
  expectedOutputs: string[]
): Promise<string> {
  const lines: string[] = [];

  if (row?.model) {
    lines.push(`# Worker Identity`);
    lines.push(`You are **${row.model}** — worker **${workerId}**.`);
    lines.push(`Your model tier code is \`${row.model}\`. Claim tasks assigned to this code.`);
  } else {
    lines.push(`# Worker Identity`);
    lines.push(`You are worker **${workerId}**.`);
  }

  lines.push("");

  if (row?.task) {
    lines.push(`# Assigned Task`);
    lines.push(`**${workerId}**: ${row.task}`);
    if (row.dependsOn) {
      lines.push(`**Depends On**: ${row.dependsOn}`);
    }
    if (row.notes) {
      lines.push(`**Notes**: ${row.notes}`);
    }
    lines.push("");
  }

  const schedulerState = await loadActiveSchedulerRunState(commandPath);
  if (schedulerState?.currentScanRunId) {
    lines.push(`# Scheduler Cycle Context`);
    lines.push(`SCHEDULER_RUN_ID: ${schedulerState.currentRunId}`);
    lines.push(`SCAN_RUN_ID: ${schedulerState.currentScanRunId}`);
    lines.push("Use this exact `SCAN_RUN_ID`; do not recompute it from the local date.");
    lines.push("");
  }

  const previousAttemptContext = await buildPreviousAttemptContext(previousWorkerState, expectedOutputs);
  if (previousAttemptContext) {
    lines.push(`# Previous Attempt Context`);
    lines.push(`This worker has prior execution history. Use it to avoid repeating the same mistake. Re-check the current state and iterate on any new findings instead of copying the earlier conclusion.`);
    lines.push("");
    lines.push(previousAttemptContext);
    lines.push("");
  }

  lines.push(`# Status`);
  if (isDispatcherWorker(workerId)) {
    lines.push(`You are the dispatcher controller. Stay in control-flow mode only: do not implement product changes, write completion reports, or make git commit/push decisions from this wrapper prompt.`);
  } else if (isPlanModifyingWorker(workerId)) {
    lines.push(`Your row in the dispatch plan has been pre-marked 🔄 (in progress). You are a special node that **may add, remove, or modify rows** in the dispatch plan as part of your task. The lifecycle store will reconcile your own row's final status from the Hub result, but you are free to write new rows or update the plan structure.`);
  } else {
    lines.push(`Your row in the dispatch plan has been pre-marked 🔄 (in progress). The lifecycle store manages all plan status updates automatically — you do not need to write to the dispatch plan yourself.`);
  }
  lines.push("");

  lines.push(`# Command File`);
  lines.push(`Read the full dispatch command from disk:`);
  lines.push("```");
  lines.push(commandPath);
  lines.push("```");
  lines.push(`Open this file and follow the instructions with these overrides:`);
  lines.push(`- **Skip Step 4a** (mark in-progress) — already done for you.`);
  if (isDispatcherWorker(workerId)) {
    lines.push(`- Treat any local Meridian tool bootstrap failure (for example Node CLI startup, IPC socket bind, or sandbox \`EPERM\` / \`ENOENT\`) as an immediate spawn failure. Do NOT inspect alternate wrappers, transports, or fallback launch methods.`);
    lines.push(`- Do NOT write Step 5b completion reports, create extra repo artifacts, or reason about git commit/push from this run. Send the required notify once, leave the plan untouched, and stop when the dispatcher prompt says to pause.`);
  } else if (isPlanModifyingWorker(workerId)) {
    lines.push(`- **Step 5a** (dispatch plan updates): you **must** write your findings and any corrective tasks directly into the dispatch plan. Add new worker rows, update statuses, or restructure as needed — this is your primary output.`);
  } else {
    lines.push(`- **Skip Step 5a** (mark complete in dispatch plan) — the lifecycle store handles this from the Hub result.`);
  }
  if (!isDispatcherWorker(workerId)) {
    const schedulerRunReportOutput = findSchedulerRunReportOutput(expectedOutputs, workerId);
    lines.push(`- **Step 5b** (completion report): attempt to write the report. If the path is outside your writable sandbox, include the full report content in your final response instead. Do NOT get stuck retrying writes to paths you cannot access.`);
    if (schedulerRunReportOutput) {
      lines.push(`- **Scheduler report path override**: write the completion report to \`${schedulerRunReportOutput}\`. Create the parent directory if needed. This supersedes any report path in the command file.`);
    }
    if (isReportOnlyWorker(workerId, row, expectedOutputs)) {
      lines.push(`- **Steps 5c–5d**: this is a report-only worker. Do NOT create git commits, branches, pushes, or PRs for the report artifact; return the report result and stop.`);
    } else {
      lines.push(`- **Steps 4b–4f, 5c–5d**: follow normally (read specs, implement, test, git commit, push).`);
    }
  }

  return lines.join("\n");
}

function findSchedulerRunReportOutput(expectedOutputs: string[], workerId: string): string | null {
  const normalizedWorkerId = workerId.toLowerCase();
  return expectedOutputs.find((outputPath) => {
    const normalized = outputPath.replace(/\\/g, "/").toLowerCase();
    const basename = path.basename(normalized);
    return normalized.includes("/run/")
      && (basename === `${normalizedWorkerId}.md` || basename === `${normalizedWorkerId}_report.md`);
  }) ?? null;
}

async function buildPreviousAttemptContext(
  previousWorkerState: DispatchWorkerState | null,
  expectedOutputs: string[]
): Promise<string | null> {
  if (!previousWorkerState) {
    return null;
  }

  const sections: string[] = [];
  const previousReply = extractPreviousReply(previousWorkerState.hub_result);
  const reportSnippets = await loadPreviousReportSnippets(expectedOutputs);

  sections.push(`- Previous worker thread: \`${previousWorkerState.thread_id}\``);
  sections.push(`- Previous retry count: ${previousWorkerState.retry_count ?? 0}`);
  if (previousWorkerState.hub_result?.timestamp) {
    sections.push(`- Previous terminal timestamp: ${previousWorkerState.hub_result.timestamp}`);
  }

  if (previousReply) {
    sections.push("");
    sections.push("Previous agent reply:");
    sections.push("```text");
    sections.push(previousReply);
    sections.push("```");
  }

  if (reportSnippets.length > 0) {
    for (const reportSnippet of reportSnippets) {
      sections.push("");
      sections.push(`Previous output artifact: \`${reportSnippet.path}\``);
      sections.push("```text");
      sections.push(reportSnippet.content);
      sections.push("```");
    }
  }

  return sections.length > 0 ? sections.join("\n") : null;
}

function extractPreviousReply(hubResult: HubResult | null): string | null {
  if (!hubResult) {
    return null;
  }

  const conversationReply = parseAgentReplyFromDetails(hubResult.details_text);
  return truncateForPrompt(conversationReply ?? hubResult.summary_text ?? hubResult.content ?? null, MAX_PREVIOUS_REPLY_CHARS);
}

function parseAgentReplyFromDetails(detailsText: string | undefined): string | null {
  if (typeof detailsText !== "string" || detailsText.trim().length === 0) {
    return null;
  }

  const match = detailsText.replace(/\r\n/g, "\n").match(/(?:^|\n)Agent reply:\n([\s\S]*)$/);
  const parsed = match?.[1]?.trim();
  return parsed && parsed.length > 0 ? parsed : null;
}

async function loadPreviousReportSnippets(
  expectedOutputs: string[]
): Promise<Array<{ path: string; content: string }>> {
  const candidatePaths = prioritizeRetryContextPaths(expectedOutputs);
  const snippets: Array<{ path: string; content: string }> = [];

  for (const candidatePath of candidatePaths) {
    try {
      const raw = await readFile(candidatePath, "utf8");
      const normalized = truncateForPrompt(raw, MAX_PREVIOUS_REPORT_CHARS);
      if (!normalized) {
        continue;
      }

      snippets.push({
        path: candidatePath,
        content: normalized
      });
    } catch {
      continue;
    }
  }

  return snippets;
}

function prioritizeRetryContextPaths(expectedOutputs: string[]): string[] {
  const uniquePaths = [...new Set(expectedOutputs)];
  const preferredPaths = uniquePaths.filter((candidatePath) => isRetryContextArtifactPath(candidatePath));
  const fallbackPaths = uniquePaths.filter((candidatePath) => !preferredPaths.includes(candidatePath));

  return [...preferredPaths, ...fallbackPaths].slice(0, MAX_PREVIOUS_REPORT_FILES);
}

function isRetryContextArtifactPath(candidatePath: string): boolean {
  const normalized = candidatePath.toLowerCase();
  return normalized.includes("/dev_history/")
    || normalized.includes("_report.")
    || normalized.endsWith(".md")
    || normalized.endsWith(".txt")
    || normalized.endsWith(".log")
    || normalized.endsWith(".json");
}

function truncateForPrompt(value: string | null, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

async function resolveWorkerRow(commandPath: string, workerId: string): Promise<DispatchPlanRow | null> {
  const dispatchPlanPath = path.join(path.dirname(commandPath), DISPATCH_PLAN_FILENAME);

  try {
    const markdown = await readFile(dispatchPlanPath, "utf8");
    return parseDispatchPlanRows(markdown).find((candidate) => candidate.worker === workerId) ?? null;
  } catch {
    return null;
  }
}

async function deriveExpectedOutputs(commandPath: string, workerId: string): Promise<string[]> {
  if (isDispatcherWorker(workerId)) {
    return [];
  }

  const schedulerRunReportOutput = await deriveSchedulerRunReportOutput(commandPath, workerId);
  const planOutputs = await deriveExpectedOutputsFromPlan(commandPath, workerId);
  if (planOutputs.length > 0) {
    return applySchedulerRunReportOverride(planOutputs, schedulerRunReportOutput, commandPath, workerId);
  }

  const completionReportOutput = await deriveExpectedCompletionReportOutput(commandPath, workerId);
  if (completionReportOutput) {
    return applySchedulerRunReportOverride([completionReportOutput], schedulerRunReportOutput, commandPath, workerId);
  }

  const conventionOutput = await deriveExpectedOutputFromConvention(commandPath, workerId);
  if (conventionOutput) {
    return applySchedulerRunReportOverride([conventionOutput], schedulerRunReportOutput, commandPath, workerId);
  }

  if (schedulerRunReportOutput) {
    return [schedulerRunReportOutput];
  }

  return [path.join(path.dirname(commandPath), DEV_HISTORY_DIRECTORY, `${workerId}_report.md`)];
}

async function deriveSchedulerRunReportOutput(commandPath: string, workerId: string): Promise<string | null> {
  const schedulerState = await loadActiveSchedulerRunState(commandPath);
  if (!schedulerState) {
    return null;
  }

  const reportDirectory = schedulerState.currentRunReportDir
    ?? path.join(path.dirname(commandPath), "reports", "run", sanitizePathSegment(schedulerState.currentRunId));

  return path.join(reportDirectory, `${workerId}.md`);
}

async function loadActiveSchedulerRunState(commandPath: string): Promise<{
  currentRunId: string;
  currentRunReportDir: string | null;
  currentScanRunId: string | null;
} | null> {
  let raw: string;

  try {
    raw = await readFile(path.join(path.dirname(commandPath), SCHEDULER_STATE_FILENAME), "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const state = parsed as {
    status?: unknown;
    current_run_id?: unknown;
    current_run_report_dir?: unknown;
    current_scan_run_id?: unknown;
  };
  if (state.status !== "active_run" || typeof state.current_run_id !== "string") {
    return null;
  }

  const currentRunId = state.current_run_id.trim();
  if (currentRunId.length === 0) {
    return null;
  }

  const currentRunReportDir = typeof state.current_run_report_dir === "string" && state.current_run_report_dir.trim().length > 0
    ? path.resolve(state.current_run_report_dir)
    : null;
  const currentScanRunId = typeof state.current_scan_run_id === "string" && state.current_scan_run_id.trim().length > 0
    ? state.current_scan_run_id.trim()
    : null;

  return {
    currentRunId,
    currentRunReportDir,
    currentScanRunId
  };
}

function applySchedulerRunReportOverride(
  outputs: string[],
  schedulerRunReportOutput: string | null,
  commandPath: string,
  workerId: string
): string[] {
  if (!schedulerRunReportOutput) {
    return outputs;
  }

  let replacedReportPath = false;
  const rewritten = outputs.map((outputPath) => {
    if (!isWorkerCompletionReportPath(outputPath, commandPath, workerId)) {
      return outputPath;
    }

    replacedReportPath = true;
    return schedulerRunReportOutput;
  });

  if (!replacedReportPath) {
    rewritten.push(schedulerRunReportOutput);
  }

  return [...new Set(rewritten)];
}

function isWorkerCompletionReportPath(candidatePath: string, commandPath: string, workerId: string): boolean {
  const normalized = path.normalize(candidatePath);
  const normalizedBase = path.normalize(path.dirname(commandPath));
  const basename = path.basename(normalized).toLowerCase();
  const workerBasename = workerId.toLowerCase();
  const isWorkerReportName = basename === `${workerBasename}.md` || basename === `${workerBasename}_report.md`;
  if (!isWorkerReportName) {
    return false;
  }

  const normalizedForMatch = normalized.replace(/\\/g, "/").toLowerCase();
  if (normalizedForMatch.includes("/reports/") || normalizedForMatch.includes("/dev_history/")) {
    return true;
  }

  return path.dirname(normalized) === normalizedBase;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

/**
 * Probes the directory structure next to the command file to detect the
 * convention used for report outputs. Some dispatch plans place reports in
 * `reports/` (with short basenames like `N-07.md`) instead of `dev_history/`
 * (with `N-07_report.md`). By detecting existing reports we can derive the
 * correct expected output path for new workers.
 */
async function deriveExpectedOutputFromConvention(commandPath: string, workerId: string): Promise<string | null> {
  const baseDir = path.dirname(commandPath);

  // Check reports/ directory — some plans use `reports/{workerId}.md`
  const reportsDir = path.join(baseDir, "reports");
  if (await directoryExistsAsync(reportsDir)) {
    const shortName = path.join(reportsDir, `${workerId}.md`);
    const longName = path.join(reportsDir, `${workerId}_report.md`);
    // Prefer whichever naming convention already exists for other workers
    const existingConvention = await probeReportNamingConvention(reportsDir);
    if (existingConvention === "short") {
      return shortName;
    }
    if (existingConvention === "long") {
      return longName;
    }
    // reports/ dir exists but empty — use short name (convention for reports/)
    return shortName;
  }

  // Check dev_history/ with subdirectories (e.g. dev_history/v1_round/)
  const devHistoryDir = path.join(baseDir, DEV_HISTORY_DIRECTORY);
  if (await directoryExistsAsync(devHistoryDir)) {
    const subdirReport = await findReportInSubdirectories(devHistoryDir, `${workerId}_report.md`);
    if (subdirReport) {
      return subdirReport;
    }
  }

  return null;
}

async function directoryExistsAsync(dirPath: string): Promise<boolean> {
  try {
    const stat = await import("node:fs/promises").then((fsp) => fsp.stat(dirPath));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function probeReportNamingConvention(reportsDir: string): Promise<"short" | "long" | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(reportsDir);
    for (const entry of entries) {
      if (entry.endsWith("_report.md")) {
        return "long";
      }
      if (entry.endsWith(".md")) {
        return "short";
      }
    }
  } catch {
    // directory unreadable
  }
  return null;
}

async function findReportInSubdirectories(parentDir: string, basename: string): Promise<string | null> {
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(parentDir);
    for (const entry of entries) {
      const entryPath = path.join(parentDir, entry);
      try {
        const entryStat = await stat(entryPath);
        if (!entryStat.isDirectory()) {
          continue;
        }
        const candidate = path.join(entryPath, basename);
        try {
          const candidateStat = await stat(candidate);
          if (candidateStat.size > 0) {
            return candidate;
          }
        } catch {
          // file doesn't exist in this subdir
        }
      } catch {
        continue;
      }
    }
  } catch {
    // parent doesn't exist
  }
  return null;
}

async function deriveExpectedOutputsFromPlan(commandPath: string, workerId: string): Promise<string[]> {
  const dispatchPlanPath = path.join(path.dirname(commandPath), DISPATCH_PLAN_FILENAME);

  try {
    const markdown = await readFile(dispatchPlanPath, "utf8");
    const row = parseDispatchPlanRows(markdown).find((candidate) => candidate.worker === workerId);
    const outputs: string[] = [];

    if (row?.reportFile) {
      outputs.push(resolveExpectedOutputPath(substituteWorkerId(row.reportFile, workerId), commandPath, {
        preferCommandDirectory: true
      }));
    }

    if (row?.notes) {
      outputs.push(...extractExpectedOutputsFromNotes(row.notes, commandPath, workerId));
    }

    return [...new Set(outputs)];
  } catch {
    return [];
  }
}

async function deriveExpectedCompletionReportOutput(commandPath: string, workerId: string): Promise<string | null> {
  try {
    const command = await readFile(commandPath, "utf8");
    const templatePath = extractCompletionReportTemplate(command, workerId);
    return templatePath ? resolveExpectedOutputPath(templatePath, commandPath) : null;
  } catch {
    return null;
  }
}

function parseDispatchPlanRows(markdown: string): DispatchPlanRow[] {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const normalizedHeaders = headerCells.map(normalizeDispatchPlanHeader);
    const workerColumn = normalizedHeaders.indexOf("worker");
    const notesColumn = findDispatchPlanHeaderIndex(normalizedHeaders, ["notes", "note"]);
    const taskColumn = findDispatchPlanHeaderIndex(normalizedHeaders, ["task", "function_group", "headline", "action"]);
    const modelColumn = findDispatchPlanHeaderIndex(normalizedHeaders, ["model", "agent", "model_tier"]);
    const dependsOnColumn = findDispatchPlanHeaderIndex(normalizedHeaders, ["depends_on", "depends", "dependencies"]);
    const reportFileColumn = findDispatchPlanHeaderIndex(normalizedHeaders, ["report_file", "report_files", "file"]);
    if (workerColumn === -1) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    const rows: DispatchPlanRow[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      rows.push({
        worker: rowCells[workerColumn],
        task: taskColumn === -1 ? undefined : rowCells[taskColumn],
        model: modelColumn === -1 ? undefined : rowCells[modelColumn],
        dependsOn: dependsOnColumn === -1 ? undefined : rowCells[dependsOnColumn],
        notes: notesColumn === -1 ? undefined : rowCells[notesColumn],
        reportFile: reportFileColumn === -1 ? undefined : readOptionalCell(rowCells[reportFileColumn])
      });
    }

    return rows;
  }

  return [];
}

function extractCompletionReportTemplate(command: string, workerId: string): string | null {
  const specialTemplatePath = extractSpecialCompletionReportTemplate(command, workerId);
  if (specialTemplatePath) {
    return specialTemplatePath;
  }

  const blockMatch = /Write(?: your)?(?: completion)? report to:\s*```[\r\n]+([^\r\n`]+)[\r\n]+```/i.exec(command);
  if (blockMatch?.[1]) {
    return substituteWorkerId(blockMatch[1], workerId);
  }

  const inlineMatch = /Write(?: your)?(?: completion)? report to:\s*`([^`\r\n]+)`/i.exec(command);
  if (inlineMatch?.[1]) {
    return substituteWorkerId(inlineMatch[1], workerId);
  }

  return null;
}

function extractSpecialCompletionReportTemplate(command: string, workerId: string): string | null {
  const specialReportBasename = resolveSpecialReportBasename(workerId);
  if (!specialReportBasename) {
    return null;
  }

  const patterns = [
    new RegExp(`\`\`\`[\\r\\n]+([^\\r\\n\`]*${escapeRegExp(specialReportBasename)})[\\r\\n]+\`\`\``, "ig"),
    new RegExp(`\`([^\`\\r\\n]*${escapeRegExp(specialReportBasename)})\``, "ig")
  ];

  for (const pattern of patterns) {
    let matchedPath: string | null = null;
    let match = pattern.exec(command);
    while (match) {
      matchedPath = match[1]?.trim() ?? null;
      match = pattern.exec(command);
    }

    if (matchedPath) {
      return substituteWorkerId(matchedPath, workerId);
    }
  }

  return null;
}

function findDispatchPlanHeaderIndex(normalizedHeaders: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = normalizedHeaders.indexOf(candidate);
    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

function normalizeDispatchPlanHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractExpectedOutputsFromNotes(notes: string, commandPath: string, workerId: string): string[] {
  const outputs: string[] = [];
  const codeSpanPattern = /`([^`]+)`/g;

  for (const match of notes.matchAll(codeSpanPattern)) {
    const candidatePath = substituteWorkerId(match[1]?.trim() ?? "", workerId);
    if (!candidatePath || !looksLikeFilePath(candidatePath)) {
      continue;
    }

    const spanStart = match.index ?? 0;
    const context = notes.slice(Math.max(0, spanStart - 120), spanStart).toLowerCase();
    if (!isOutputContext(context)) {
      continue;
    }

    const resolvedPath = resolveExpectedOutputPath(candidatePath, commandPath);
    if (isLifecycleArtifactPath(resolvedPath, commandPath)) {
      continue;
    }

    outputs.push(resolvedPath);
  }

  return [...new Set(outputs)];
}

function looksLikeFilePath(value: string): boolean {
  return /[/.]/.test(value) && !/^[a-z]+:\/\//i.test(value);
}

function isOutputContext(context: string): boolean {
  const lastOutputVerb = findLastPatternIndex(context, [
    /\bwrite\b/g,
    /\bappend\b/g,
    /\bcreate\b/g,
    /\bgenerate\b/g,
    /\bproduce\b/g,
    /\bsave\b/g,
    /\bupdate\b/g,
    /\boverwrite\b/g
  ]);
  const lastInputVerb = findLastPatternIndex(context, [
    /\bread\b/g,
    /\bcheck\b/g,
    /\binspect\b/g,
    /\bleave\b/g,
    /\bopen\b/g,
    /\bverify\b/g
  ]);

  return lastOutputVerb !== -1 && lastOutputVerb > lastInputVerb;
}

function findLastPatternIndex(source: string, patterns: RegExp[]): number {
  let lastIndex = -1;

  patterns.forEach((pattern) => {
    const matcher = new RegExp(pattern.source, pattern.flags);
    let match = matcher.exec(source);
    while (match) {
      lastIndex = Math.max(lastIndex, match.index);
      match = matcher.exec(source);
    }
  });

  return lastIndex;
}

function resolveExpectedOutputPath(
  candidatePath: string,
  commandPath: string,
  options: { preferCommandDirectory?: boolean } = {}
): string {
  if (path.isAbsolute(candidatePath)) {
    return path.normalize(candidatePath);
  }

  const normalizedCandidate = normalizePathForComparison(candidatePath);
  if (normalizedCandidate === DEV_HISTORY_DIRECTORY || normalizedCandidate.startsWith(`${DEV_HISTORY_DIRECTORY}/`)) {
    return path.resolve(path.dirname(commandPath), candidatePath);
  }

  if (options.preferCommandDirectory) {
    return path.resolve(path.dirname(commandPath), candidatePath);
  }

  if (candidatePath.startsWith("./") || candidatePath.startsWith("../") || !candidatePath.includes("/")) {
    return path.resolve(path.dirname(commandPath), candidatePath);
  }

  const commandDirectoryRelative = normalizePathForComparison(path.relative(process.cwd(), path.dirname(commandPath)));

  if (commandDirectoryRelative && normalizedCandidate.startsWith(`${commandDirectoryRelative}/`)) {
    return path.resolve(process.cwd(), candidatePath);
  }

  return path.resolve(process.cwd(), candidatePath);
}

function normalizePathForComparison(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function substituteWorkerId(templatePath: string, workerId: string): string {
  return templatePath
    .replace(/\[WORKER_ID\]/g, workerId)
    .replace(/<WORKER_ID>/g, workerId)
    .trim();
}

function isReportOnlyWorker(workerId: string, row: DispatchPlanRow | null, expectedOutputs: string[]): boolean {
  if (expectedOutputs.length === 0 || !expectedOutputs.every((candidatePath) => isReportArtifactPath(candidatePath))) {
    return false;
  }

  return REPORT_ONLY_WORKERS.has(workerId) || hasExplicitReportOnlyIntent(row);
}

function isReportArtifactPath(candidatePath: string): boolean {
  const normalized = candidatePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(normalized);

  return (
    normalized.includes("/dev_history/")
    && (
      /_report\.md$/.test(basename)
      || basename === "delta_check_report.md"
      || basename === "pr_review_report.md"
    )
  ) || (normalized.includes("/reports/") && basename.endsWith(".md"));
}

const PLAN_MODIFYING_WORKERS = new Set(["DELTA-CHECK", "PR-REVIEW"]);
const REPORT_ONLY_WORKERS = new Set(["PRE-FLIGHT", "DELTA-CHECK", "PR-REVIEW"]);

function hasExplicitReportOnlyIntent(row: DispatchPlanRow | null): boolean {
  const text = [row?.task, row?.notes].filter(Boolean).join(" ").toLowerCase();
  return /\breport[-\s]?only\b/.test(text) || /\bno\s+non[-\s]?report\s+outputs?\s+required\b/.test(text);
}

function isDispatcherWorker(workerId: string): boolean {
  return workerId === DISPATCHER_WORKER_ID;
}

function isPlanModifyingWorker(workerId: string): boolean {
  return PLAN_MODIFYING_WORKERS.has(workerId);
}

function resolveSpecialReportBasename(workerId: string): string | null {
  if (workerId === "DELTA-CHECK") {
    return "delta_check_report.md";
  }

  if (workerId === "PR-REVIEW") {
    return "pr_review_report.md";
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLifecycleArtifactPath(candidatePath: string, commandPath: string): boolean {
  const commandDirectory = path.dirname(commandPath);
  const normalizedCandidate = path.normalize(candidatePath);

  return normalizedCandidate === path.join(commandDirectory, DISPATCH_PLAN_FILENAME)
    || normalizedCandidate === path.join(commandDirectory, DISPATCH_THREADS_FILENAME);
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }

  const withoutLeadingPipe = trimmed.slice(1);
  const normalized = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return normalized.split("|").map((cell) => cell.trim());
}

function readOptionalCell(cell: string | undefined): string | undefined {
  const trimmed = cell?.trim();
  if (!trimmed || trimmed === "—") {
    return undefined;
  }

  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function mapRunResult(result: HubResult, worker: string, threadId: string): ToolResult {
  if (result.status === "error") {
    return failedResult(worker, threadId, result.content);
  }

  const runState = inferRunState(result);
  if (runState !== "completed") {
    return {
      ok: true,
      data: {
        worker,
        thread_id: threadId,
        status: "in_progress",
        run_state: runState,
        summary: result.content
      }
    };
  }

  return {
    ok: true,
    data: {
      worker,
      thread_id: threadId,
      status: "done",
      run_state: "completed",
      summary: result.content
    }
  };
}

function inferRunState(result: HubResult): HubRunState {
  if (result.run_state) {
    return result.run_state;
  }

  if (result.status === "partial") {
    return "still_running";
  }

  if (result.status === "timeout") {
    return "timeout";
  }

  return "completed";
}

function parseKillPolicy(value: string | undefined): KillPolicy | null {
  const normalized = requireParam(value, "kill_policy");
  if (!normalized) {
    return "never";
  }

  const parsed = KillPolicySchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function shouldKillAfterResult(result: HubResult, killPolicy: KillPolicy): boolean {
  if (killPolicy === "never") {
    return false;
  }

  if (result.status === "error") {
    return killPolicy === "always";
  }

  if (inferRunState(result) !== "completed") {
    return false;
  }

  return killPolicy === "always" || (killPolicy === "on_success" && result.status === "success");
}

function interruptedResult(worker: string, threadId: string): ToolResult {
  return failedResult(worker, threadId, INTERRUPTED_ERROR);
}

function failedResult(worker: string, threadId: string, error: string): ToolResult {
  return {
    ok: false,
    error,
    data: {
      worker,
      thread_id: threadId,
      status: "failed"
    }
  };
}

function missingParam(name: string): ToolResult {
  return {
    ok: false,
    error: `Missing required parameter: ${name}`
  };
}

function requireParam(value: string | undefined, name: string): string | null {
  void name;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function runWithTransientRetry(
  client: ReturnType<typeof createMeridianApiClient>,
  threadId: string,
  content: string
): Promise<MeridianRunResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= TRANSIENT_RUN_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.run({ threadId, content });
    } catch (error) {
      lastError = asError(error);
      if (attempt < TRANSIENT_RUN_RETRY_DELAYS_MS.length && shouldRetryRunError(lastError)) {
        const delayMs = TRANSIENT_RUN_RETRY_DELAYS_MS[attempt]!;
        console.warn("run tool transient error, retrying", {
          threadId,
          attempt: attempt + 1,
          delayMs,
          error: lastError.message
        });
        await delay(delayMs);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError!;
}

function isTransientError(error: Error): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

function shouldRetryRunError(error: Error): boolean {
  if (!isTransientError(error)) {
    return false;
  }

  // `/api/run` is non-idempotent. Once Meridian returns a transient-looking
  // `run failed: ...` response, the worker may already be executing, so replaying
  // the same prompt into the same thread can duplicate work.
  //
  // However, when the error indicates the API was *unreachable* (e.g. "fetch failed",
  // ECONNREFUSED), the request never reached Meridian — the worker cannot have started,
  // so retry is safe.
  if (/^run failed:/i.test(error.message)) {
    return isUndeliveredRunRequestError(error);
  }

  return true;
}

function isUndeliveredRunRequestError(error: Error): boolean {
  return /^run failed:\s*Meridian API unreachable\b/i.test(error.message)
    && !/\bHeaders Timeout\b/i.test(error.message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
