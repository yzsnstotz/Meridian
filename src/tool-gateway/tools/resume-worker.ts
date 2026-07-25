import * as fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { LifecycleStore, hubResultContainsFailureSignal, isNonCompletionContent } from "../../roles/agent-dispatcher/lifecycle-store";
import { isMissingThreadEvidence } from "../../roles/agent-dispatcher/missing-thread";
import type { LifecycleStatus } from "../../types";
import killTool from "./kill";
import { executeUpdateWorkerStatusAction, updateWorkerStatusInMarkdown } from "./update-status";
import type { ToolDefinition, ToolResult } from "../registry";

const ResumeWorkerActionSchema = z.enum(["retry", "skip", "force-complete", "validate"]);

// Default max_fix_cycles seeded when an operator triggers validate manually.
// The dispatcher's actual validator_config.max_fix_cycles still governs Phase 1
// disposition once cycles run; this seed only fills the validation skeleton so
// Phase 2 can spawn the first validator cycle without a null-deref.
const MANUAL_VALIDATE_MAX_FIX_CYCLES = 3;

export const ResumeWorkerActionRequestSchema = z.object({
  action: ResumeWorkerActionSchema.default("retry"),
  force: z.boolean().optional()
});

export type ResumeWorkerAction = z.infer<typeof ResumeWorkerActionSchema>;

export interface ExecuteResumeWorkerActionArgs {
  planPath: string;
  workerId: string;
  action: ResumeWorkerAction;
  force?: boolean;
  incrementRetryCountOnRetry?: boolean;
}

interface ResumeWorkerDeps {
  killThread(threadId: string): Promise<ToolResult>;
  lifecycleStoreFactory(planPath: string): LifecycleStore;
}

const defaultDeps: ResumeWorkerDeps = {
  killThread: (threadId) => killTool.execute({ thread_id: threadId }),
  lifecycleStoreFactory: (planPath) => new LifecycleStore(resolveDispatchThreadPath(planPath), {
    dispatchPlanPath: planPath
  })
};

const resumeWorkerTool: ToolDefinition = {
  name: "resume-worker",
  description: "Manually recover a stuck dispatch worker by retrying, skipping, or force-completing it",
  params: {
    plan: {
      type: "string",
      required: true,
      description: "Absolute path to the dispatch_plan.md file"
    },
    worker: {
      type: "string",
      required: true,
      description: "Worker identifier to recover"
    },
    action: {
      type: "string",
      required: false,
      description: "Recovery action: retry, skip, force-complete, or validate"
    },
    force: {
      type: "string",
      required: false,
      description: "Required for force-complete. Use true to confirm the dangerous action."
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const planPath = requireParam(params.plan);
    if (!planPath) {
      return {
        ok: false,
        error: "Missing required parameter: plan"
      };
    }

    const workerId = requireParam(params.worker);
    if (!workerId) {
      return {
        ok: false,
        error: "Missing required parameter: worker"
      };
    }

    const action = parseAction(params.action);
    if (!action) {
      return {
        ok: false,
        error: `Unsupported action: ${params.action}`
      };
    }

    try {
      const result = await executeResumeWorkerAction({
        planPath,
        workerId,
        action,
        force: parseForceParam(params.force)
      });
      return {
        ok: true,
        data: result
      };
    } catch (error) {
      return {
        ok: false,
        error: asError(error).message
      };
    }
  }
};

export default resumeWorkerTool;

export async function executeResumeWorkerAction(
  args: ExecuteResumeWorkerActionArgs,
  deps: ResumeWorkerDeps = defaultDeps
): Promise<{
  worker: string;
  action: ResumeWorkerAction;
  status: LifecycleStatus;
  thread_id: string | null;
  thread_killed: boolean;
  retry_count: number;
  prior_failure_reason?: string;
  kill_error?: string;
}> {
  await assertWorkerExistsInPlan(args.planPath, args.workerId);

  const lifecycleStore = deps.lifecycleStoreFactory(args.planPath);
  const lifecycleState = lifecycleStore.load();
  const worker = lifecycleState.workers[args.workerId];

  if (args.action === "force-complete" && !args.force) {
    throw new Error("force-complete requires force=true");
  }

  if (args.action === "force-complete" && worker?.hub_result && isNonCompletionContent(worker.hub_result.content ?? "")) {
    throw new Error(
      `Cannot force-complete worker "${args.workerId}": worker output contains a BLOCKED or PAUSE marker. ` +
      "Resolve the blocker first, then retry the worker."
    );
  }

  if (!worker) {
    const nextStatus = mapActionToStatus(args.action);
    await executeUpdateWorkerStatusAction({
      planPath: args.planPath,
      workerId: args.workerId,
      status: nextStatus
    });

    return {
      worker: args.workerId,
      action: args.action,
      status: nextStatus,
      thread_id: null,
      thread_killed: false,
      retry_count: 0
    };
  }

  const priorFailureReason = extractPriorFailureReason(worker);
  const threadId = worker.thread_id;
  let threadKilled = false;
  let killError: string | undefined;

  if (threadId) {
    const killResult = await deps.killThread(threadId);
    if (killResult.ok) {
      threadKilled = true;
    } else {
      killError = killResult.error ?? "Kill failed";
      if (isMissingThreadEvidence(killError)) {
        threadKilled = true;
        killError = undefined;
      } else if (
        (args.action === "force-complete" || args.action === "retry")
        && args.force === true
        && isBootstrapKeyMissingEvidence(killError)
      ) {
        threadKilled = false;
      } else {
        throw new Error(
          `Cannot ${args.action} worker "${args.workerId}": failed to stop recorded thread ${threadId}: ` +
          `${killError}. Worker status was not changed.`
        );
      }
    }
  }

  const nextStatus = mapActionToStatus(args.action);
  const autoIncrementRetryCount = args.action === "retry" && args.incrementRetryCountOnRetry === true;
  // Clear hub_result on retry of failed/blocked workers, on force-complete of
  // any worker, and on validate. Without clearing, the lifecycle store's
  // syncPlanView -> resolveDisplayStatus would re-derive the plan status from
  // the stale hub_result block/failure signal and immediately overwrite the
  // status written by forceUpdatePlanMarkdown back to ⛔ BLOCKED on the next
  // save. For validate this matters because the worker may be entering the
  // validator from a synthesized output_artifact failure that misread the
  // report; the validator must judge the report itself, not the stale signal.
  const clearFailureResult = (args.action === "retry"
      && worker.hub_result !== null
      && (worker.status === "failed" || worker.status === "blocked" || hubResultContainsFailureSignal(worker.hub_result)))
    || (args.action === "force-complete" && worker.hub_result !== null)
    || (args.action === "validate" && worker.hub_result !== null);
  if (args.action === "validate") {
    // Use the seeding transition so the validation block is initialized
    // (current_cycle, max_fix_cycles, history). Without it, processValidationQueue
    // Phase 2 spawns a validator on a worker whose validation skeleton is null
    // and downstream feedback bookkeeping has nowhere to write.
    lifecycleStore.transitionToAwaitingValidation(args.workerId, MANUAL_VALIDATE_MAX_FIX_CYCLES, {
      clearHubResult: clearFailureResult,
      trigger: "resume_worker:validate"
    });
  } else {
    lifecycleStore.setWorkerStatus(
      args.workerId,
      nextStatus,
      `resume_worker:${args.action}`,
      {
        clearHubResult: clearFailureResult,
        clearValidation: args.action === "force-complete" || args.action === "skip",
        incrementRetryCount: autoIncrementRetryCount,
        resetRetryCount: args.action === "retry" && !autoIncrementRetryCount
      }
    );
  }

  // The lifecycle store's syncPlanView guard prevents overwriting
  // terminal-success plan statuses (✅, ⛔ SKIPPED). An explicit resume
  // action must always be reflected in the plan markdown, so update it
  // directly as well.
  await forceUpdatePlanMarkdown(args.planPath, args.workerId, nextStatus);

  const updatedState = lifecycleStore.load();
  const retryCount = updatedState.workers[args.workerId]?.retry_count ?? 0;

  return {
    worker: args.workerId,
    action: args.action,
    status: nextStatus,
    thread_id: threadId,
    thread_killed: threadKilled,
    retry_count: retryCount,
    ...(killError ? { kill_error: killError } : {}),
    ...(priorFailureReason ? { prior_failure_reason: priorFailureReason } : {})
  };
}

function isBootstrapKeyMissingEvidence(message: string | null | undefined): boolean {
  return message?.trim() === "bootstrap_key_missing";
}

function mapActionToStatus(action: ResumeWorkerAction): LifecycleStatus {
  switch (action) {
    case "retry":
      return "pending";
    case "skip":
      return "skipped";
    case "force-complete":
      return "completed";
    case "validate":
      // Hand the worker to the validator orchestrator. processValidationQueue
      // Phase 2 picks up awaiting_validation workers and spawns the validator;
      // if the dispatcher's validator config is disabled, the worker will sit
      // in this state until the operator either enables validation or applies
      // a different resume action.
      return "awaiting_validation";
  }
}

async function assertWorkerExistsInPlan(planPath: string, workerId: string): Promise<void> {
  const markdown = await fs.readFile(planPath, "utf8");
  const lines = markdown.split(/\r?\n/);
  let workerColumn = -1;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    workerColumn = findHeaderColumn(headerCells, "worker");
    if (workerColumn === -1) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      if (rowCells[workerColumn] === workerId) {
        return;
      }
    }
  }

  throw new Error(`Worker not found in dispatch plan: ${workerId}`);
}

function resolveDispatchThreadPath(planPath: string): string {
  return path.join(path.dirname(planPath), "dispatch_threads.json");
}

function parseAction(value: string | undefined): ResumeWorkerAction | null {
  const normalized = requireParam(value) ?? "retry";
  const parsed = ResumeWorkerActionSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function parseForceParam(value: string | undefined): boolean {
  const normalized = requireParam(value);
  return normalized === "1" || normalized === "true";
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function findHeaderColumn(cells: string[], expected: string): number {
  const normalizedExpected = normalizeHeaderCell(expected);
  return cells.findIndex((cell) => normalizeHeaderCell(cell) === normalizedExpected);
}

function normalizeHeaderCell(cell: string): string {
  return cell.trim().replace(/[_\s-]+/g, " ").toLowerCase();
}

function extractPriorFailureReason(
  worker: { status: string; hub_result: { content?: string; status?: string } | null }
): string | undefined {
  if ((worker.status !== "failed" && worker.status !== "blocked") || !worker.hub_result) {
    return undefined;
  }

  const content = worker.hub_result.content ?? "";
  if (content.length === 0) {
    return worker.hub_result.status === "error" ? "hub returned error (no content)" : undefined;
  }

  const errorMatch = content.match(/"message"\s*:\s*"([^"]{1,200})"/);
  if (errorMatch) {
    return errorMatch[1];
  }

  const MAX_REASON_LENGTH = 200;
  return content.length > MAX_REASON_LENGTH ? `${content.slice(0, MAX_REASON_LENGTH)}…` : content;
}

async function forceUpdatePlanMarkdown(
  planPath: string,
  workerId: string,
  status: LifecycleStatus
): Promise<void> {
  const markdown = await fs.readFile(planPath, "utf8");
  const updated = updateWorkerStatusInMarkdown(markdown, workerId, status);
  if (updated !== markdown) {
    await fs.writeFile(planPath, updated, "utf8");
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
