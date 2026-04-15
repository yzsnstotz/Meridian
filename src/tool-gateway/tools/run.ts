import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import { ROLES_SERVICE_ID } from "../../config";
import { reconcile } from "../../roles/agent-dispatcher/reconciler";
import { KillPolicySchema, type DispatchWorkerState, type HubMessage, type HubResult, type HubRunState, type KillPolicy } from "../../types";
import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { sendAndWait } from "../ipc-bridge";
import killTool from "./kill";
import type { ToolDefinition, ToolResult } from "../registry";

const DEV_HISTORY_DIRECTORY = "dev_history";
const DISPATCHER_WORKER_ID = "DISPATCHER";
const DISPATCH_PLAN_FILENAME = "dispatch_plan.md";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const MERIDIAN_TOOL_ACTOR_ID = "service:meridian-tool";
const INTERRUPTED_ERROR = "interrupted";
const INTERRUPT_MESSAGES = new Set(["Tool Gateway interrupted by SIGINT", INTERRUPTED_ERROR]);
const MAX_PREVIOUS_REPLY_CHARS = 6_000;
const MAX_PREVIOUS_REPORT_CHARS = 6_000;
const MAX_PREVIOUS_REPORT_FILES = 2;

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

    try {
      const traceId = randomUUID();
      const lifecycleStore = createLifecycleStore(commandPath);
      const workerRow = await resolveWorkerRow(commandPath, worker);
      const expectedOutputs = await deriveExpectedOutputs(commandPath, worker);
      const previousWorkerState = lifecycleStore.load().workers[worker] as DispatchWorkerState | undefined;
      const preamble = await buildWorkerPreamble(
        worker,
        workerRow,
        commandPath,
        previousWorkerState ?? null,
        expectedOutputs
      );
      lifecycleStore.recordWorkerStart(worker, threadId, traceId, expectedOutputs, preamble);

      const result = await sendAndWait(buildRunMessage(threadId, preamble, traceId), 0);
      lifecycleStore.recordWorkerResult(worker, result);
      await reconcileAfterTerminalResult(lifecycleStore, result);
      await cleanupWorkerThread(threadId, result, killPolicy);
      return mapRunResult(result, worker, threadId);
    } catch (error) {
      const resolvedError = asError(error);
      console.error("run tool execution failed", {
        worker,
        threadId,
        error: resolvedError.message
      });

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

function buildRunMessage(threadId: string, command: string, traceId: string): Partial<HubMessage> {
  return {
    trace_id: traceId,
    thread_id: threadId,
    actor_id: MERIDIAN_TOOL_ACTOR_ID,
    priority: 5,
    intent: "run",
    target: threadId,
    mode: "bridge",
    payload: {
      content: command,
      attachments: []
    }
  };
}

function createLifecycleStore(commandPath: string): LifecycleStore {
  return new LifecycleStore(path.join(path.dirname(commandPath), DISPATCH_THREADS_FILENAME));
}

async function reconcileAfterTerminalResult(lifecycleStore: LifecycleStore, result: HubResult): Promise<void> {
  if (inferRunState(result) !== "completed") {
    return;
  }

  try {
    await reconcile(lifecycleStore, {
      serviceId: ROLES_SERVICE_ID,
      sendRequest: (message: HubMessage) => sendAndWait(message, 0)
    } as unknown as A2AClient);
  } catch (error) {
    console.warn("run tool reconciliation failed", {
      filePath: lifecycleStore.filePath,
      error: asError(error).message
    });
  }
}

async function cleanupWorkerThread(threadId: string, result: HubResult, killPolicy: KillPolicy): Promise<void> {
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
    lines.push(`- **Step 5b** (completion report): attempt to write the report. If the path is outside your writable sandbox, include the full report content in your final response instead. Do NOT get stuck retrying writes to paths you cannot access.`);
    if (isReportOnlyWorker(expectedOutputs)) {
      lines.push(`- **Steps 5c–5d**: this is a report-only worker. Do NOT create git commits, branches, pushes, or PRs for the report artifact; return the report result and stop.`);
    } else {
      lines.push(`- **Steps 4b–4f, 5c–5d**: follow normally (read specs, implement, test, git commit, push).`);
    }
  }

  return lines.join("\n");
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

  const planOutputs = await deriveExpectedOutputsFromPlan(commandPath, workerId);
  if (planOutputs.length > 0) {
    return planOutputs;
  }

  const completionReportOutput = await deriveExpectedCompletionReportOutput(commandPath, workerId);
  if (completionReportOutput) {
    return [completionReportOutput];
  }

  return [path.join(path.dirname(commandPath), DEV_HISTORY_DIRECTORY, `${workerId}_report.md`)];
}

async function deriveExpectedOutputsFromPlan(commandPath: string, workerId: string): Promise<string[]> {
  const dispatchPlanPath = path.join(path.dirname(commandPath), DISPATCH_PLAN_FILENAME);

  try {
    const markdown = await readFile(dispatchPlanPath, "utf8");
    const row = parseDispatchPlanRows(markdown).find((candidate) => candidate.worker === workerId);
    const outputs: string[] = [];

    if (row?.reportFile) {
      outputs.push(resolveExpectedOutputPath(row.reportFile, commandPath, { preferCommandDirectory: true }));
    }

    if (row?.notes) {
      outputs.push(...extractExpectedOutputsFromNotes(row.notes, commandPath));
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

function extractExpectedOutputsFromNotes(notes: string, commandPath: string): string[] {
  const outputs: string[] = [];
  const codeSpanPattern = /`([^`]+)`/g;

  for (const match of notes.matchAll(codeSpanPattern)) {
    const candidatePath = match[1]?.trim();
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
  return templatePath.replace(/\[WORKER_ID\]/g, workerId).trim();
}

function isReportOnlyWorker(expectedOutputs: string[]): boolean {
  return expectedOutputs.length > 0 && expectedOutputs.every((candidatePath) => isReportArtifactPath(candidatePath));
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

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
