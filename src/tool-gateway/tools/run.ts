import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import { ROLES_SERVICE_ID } from "../../config";
import { reconcile } from "../../roles/agent-dispatcher/reconciler";
import type { HubMessage, HubResult, HubRunState } from "../../types";
import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { sendAndWait } from "../ipc-bridge";
import type { ToolDefinition, ToolResult } from "../registry";

const DEV_HISTORY_DIRECTORY = "dev_history";
const DISPATCH_PLAN_FILENAME = "dispatch_plan.md";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const MERIDIAN_TOOL_ACTOR_ID = "service:meridian-tool";
const INTERRUPTED_ERROR = "interrupted";
const INTERRUPT_MESSAGES = new Set(["Tool Gateway interrupted by SIGINT", INTERRUPTED_ERROR]);

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
      const preamble = buildWorkerPreamble(worker, workerRow, commandPath);
      lifecycleStore.recordWorkerStart(worker, threadId, traceId, expectedOutputs, preamble);

      const result = await sendAndWait(buildRunMessage(threadId, preamble, traceId), 0);
      lifecycleStore.recordWorkerResult(worker, result);
      await reconcileAfterTerminalResult(lifecycleStore, result);
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

export interface DispatchPlanRow {
  worker: string;
  task?: string;
  model?: string;
  dependsOn?: string;
  notes?: string;
}

function buildWorkerPreamble(workerId: string, row: DispatchPlanRow | null, commandPath: string): string {
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

  lines.push(`# Status`);
  lines.push(`Your row in the dispatch plan has been pre-marked 🔄 (in progress). The lifecycle store manages all plan status updates automatically — you do not need to write to the dispatch plan yourself.`);
  lines.push("");

  lines.push(`# Command File`);
  lines.push(`Read the full dispatch command from disk:`);
  lines.push("```");
  lines.push(commandPath);
  lines.push("```");
  lines.push(`Open this file and follow the instructions with these overrides:`);
  lines.push(`- **Skip Step 4a** (mark in-progress) — already done for you.`);
  lines.push(`- **Skip Step 5a** (mark complete in dispatch plan) — the lifecycle store handles this from the Hub result.`);
  lines.push(`- **Step 5b** (completion report): attempt to write the report. If the path is outside your writable sandbox, include the full report content in your final response instead. Do NOT get stuck retrying writes to paths you cannot access.`);
  lines.push(`- **Steps 4b–4f, 5c–5d**: follow normally (read specs, implement, test, git commit, push).`);

  return lines.join("\n");
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
  const planOutputs = await deriveExpectedOutputsFromPlan(commandPath, workerId);
  if (planOutputs.length > 0) {
    return planOutputs;
  }

  return [path.join(path.dirname(commandPath), DEV_HISTORY_DIRECTORY, `${workerId}_report.md`)];
}

async function deriveExpectedOutputsFromPlan(commandPath: string, workerId: string): Promise<string[]> {
  const dispatchPlanPath = path.join(path.dirname(commandPath), DISPATCH_PLAN_FILENAME);

  try {
    const markdown = await readFile(dispatchPlanPath, "utf8");
    const row = parseDispatchPlanRows(markdown).find((candidate) => candidate.worker === workerId);
    if (!row?.notes) {
      return [];
    }

    return extractExpectedOutputsFromNotes(row.notes, commandPath);
  } catch {
    return [];
  }
}

function parseDispatchPlanRows(markdown: string): DispatchPlanRow[] {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const workerColumn = headerCells.indexOf("Worker");
    const notesColumn = headerCells.indexOf("Notes");
    const taskColumn = headerCells.indexOf("Task");
    const modelColumn = headerCells.indexOf("Model");
    const dependsOnColumn = headerCells.indexOf("Depends On");
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
        notes: notesColumn === -1 ? undefined : rowCells[notesColumn]
      });
    }

    return rows;
  }

  return [];
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

function resolveExpectedOutputPath(candidatePath: string, commandPath: string): string {
  if (path.isAbsolute(candidatePath)) {
    return path.normalize(candidatePath);
  }

  if (candidatePath.startsWith("./") || candidatePath.startsWith("../") || !candidatePath.includes("/")) {
    return path.resolve(path.dirname(commandPath), candidatePath);
  }

  const commandDirectoryRelative = normalizePathForComparison(path.relative(process.cwd(), path.dirname(commandPath)));
  const normalizedCandidate = normalizePathForComparison(candidatePath);

  if (commandDirectoryRelative && normalizedCandidate.startsWith(`${commandDirectoryRelative}/`)) {
    return path.resolve(process.cwd(), candidatePath);
  }

  return path.resolve(process.cwd(), candidatePath);
}

function normalizePathForComparison(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isLifecycleArtifactPath(candidatePath: string, commandPath: string): boolean {
  const commandDirectory = path.dirname(commandPath);
  const normalizedCandidate = path.normalize(candidatePath);

  return normalizedCandidate === path.join(commandDirectory, DISPATCH_PLAN_FILENAME)
    || normalizedCandidate === path.join(commandDirectory, DISPATCH_THREADS_FILENAME)
    || normalizedCandidate.startsWith(path.join(commandDirectory, DEV_HISTORY_DIRECTORY) + path.sep);
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

function requireParam(value: string | undefined, _name: string): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
