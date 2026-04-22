import * as fs from "node:fs/promises";
import path from "node:path";

import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import type { LifecycleStatus } from "../../types";
import type { ToolDefinition, ToolResult } from "../registry";

const LIFECYCLE_STATUS_SYMBOLS: Record<LifecycleStatus, string> = {
  pending: "⬜",
  running: "🔄",
  completed: "✅",
  failed: "❌",
  abandoned: "⚠️ ABANDONED",
  skipped: "⛔ SKIPPED"
} as const;

const STATUS_ALIASES = {
  in_progress: "running",
  done: "completed",
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  abandoned: "abandoned",
  skipped: "skipped"
} as const;

type RequestedStatus = keyof typeof STATUS_ALIASES;

const updateStatusTool: ToolDefinition = {
  name: "update-status",
  description: "Update a worker status inside a markdown dispatch plan",
  params: {
    plan: {
      type: "string",
      required: true,
      description: "Absolute path to the dispatch_plan.md file"
    },
    worker: {
      type: "string",
      required: true,
      description: "Worker identifier to update"
    },
    status: {
      type: "string",
      required: true,
      description: "Worker status: in_progress, done, or failed"
    },
    thread_id: {
      type: "string",
      required: false,
      description: "Worker thread identifier to persist in dispatch_threads.json when setting in_progress"
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

    const worker = requireParam(params.worker);
    if (!worker) {
      return {
        ok: false,
        error: "Missing required parameter: worker"
      };
    }

    const requestedStatus = requireParam(params.status);
    if (!requestedStatus) {
      return {
        ok: false,
        error: "Missing required parameter: status"
      };
    }

    try {
      const normalizedStatus = parseRequestedStatus(requestedStatus);
      const workerThreadId = requireParam(params.thread_id);
      await syncWorkerLifecycleState(planPath, worker, normalizedStatus, workerThreadId);

      // Always update the plan markdown directly. The lifecycle store's
      // syncPlanView guard prevents overwriting terminal-success statuses
      // (✅, ⛔ SKIPPED), but an explicit status change must be reflected.
      const markdown = await fs.readFile(planPath, "utf8");
      const updated = updateWorkerStatusInMarkdown(markdown, worker, normalizedStatus);
      if (updated !== markdown) {
        await fs.writeFile(planPath, updated, "utf8");
      }
      return {
        ok: true,
        data: {
          worker,
          status: requestedStatus
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: asError(error).message
      };
    }
  }
};

export default updateStatusTool;

export interface ExecuteUpdateWorkerStatusActionArgs {
  planPath: string;
  workerId: string;
  status: string;
  threadId?: string | null;
}

export async function executeUpdateWorkerStatusAction(
  args: ExecuteUpdateWorkerStatusActionArgs
): Promise<{
  worker: string;
  status: LifecycleStatus;
  thread_id: string | null;
  lifecycle_updated: boolean;
}> {
  const normalizedStatus = parseRequestedStatus(args.status);
  const threadId = requireParam(args.threadId ?? undefined);
  const lifecycleUpdated = await syncWorkerLifecycleState(args.planPath, args.workerId, normalizedStatus, threadId);
  let resolvedThreadId = threadId;

  if (lifecycleUpdated) {
    const lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(args.planPath), {
      dispatchPlanPath: args.planPath
    });
    resolvedThreadId = lifecycleStore.load().workers[args.workerId]?.thread_id ?? threadId;
  }

  // Always update the plan markdown directly. The lifecycle store's
  // syncPlanView guard prevents overwriting terminal-success statuses
  // (✅, ⛔ SKIPPED), but an explicit status change must be reflected.
  const markdown = await fs.readFile(args.planPath, "utf8");
  const updated = updateWorkerStatusInMarkdown(markdown, args.workerId, normalizedStatus);
  if (updated !== markdown) {
    await fs.writeFile(args.planPath, updated, "utf8");
  }

  return {
    worker: args.workerId,
    status: normalizedStatus,
    thread_id: resolvedThreadId,
    lifecycle_updated: lifecycleUpdated
  };
}

export function updateWorkerStatusInMarkdown(
  markdown: string,
  worker: string,
  status: RequestedStatus | LifecycleStatus
): string {
  const normalizedStatus = parseRequestedStatus(status);
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const statusColumn = headerCells.indexOf("Status");
    const workerColumn = headerCells.indexOf("Worker");
    if (statusColumn === -1 || workerColumn === -1) {
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

      if (rowCells[workerColumn] !== worker) {
        continue;
      }

      rowCells[statusColumn] = LIFECYCLE_STATUS_SYMBOLS[normalizedStatus];
      return preserveTrailingNewline(markdown, replaceLine(lines, rowIndex, formatTableRow(rowCells)).join("\n"));
    }
  }

  throw new Error(`Worker not found in markdown table: ${worker}`);
}

export function parseRequestedStatus(status: string): LifecycleStatus {
  if (status in STATUS_ALIASES) {
    return STATUS_ALIASES[status as RequestedStatus];
  }

  throw new Error(`Unsupported status: ${status}`);
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

function formatTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function replaceLine(lines: string[], index: number, nextLine: string): string[] {
  const updated = [...lines];
  updated[index] = nextLine;
  return updated;
}

function preserveTrailingNewline(original: string, updated: string): string {
  return original.endsWith("\n") ? `${updated}\n` : updated;
}

async function syncWorkerLifecycleState(
  planPath: string,
  worker: string,
  status: LifecycleStatus,
  threadId: string | null
): Promise<boolean> {
  const lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(planPath), {
    dispatchPlanPath: planPath
  });
  const state = lifecycleStore.load();
  const workerState = state.workers[worker];
  const nowIso = new Date().toISOString();

  if (status === "running") {
    const effectiveThreadId = threadId ?? workerState?.thread_id ?? null;
    if (!effectiveThreadId) {
      return false;
    }

    state.workers[worker] = {
      thread_id: effectiveThreadId,
      trace_id: workerState?.trace_id ?? null,
      started_at: workerState?.started_at ?? nowIso,
      last_seen_at: nowIso,
      status: "running",
      expected_outputs: [...(workerState?.expected_outputs ?? [])],
      hub_result: null,
      command_preamble: workerState?.command_preamble ?? null,
      retry_count: workerState?.retry_count ?? 0
    };
    lifecycleStore.save(state);
    return true;
  }

  if (!workerState) {
    return false;
  }

  state.workers[worker] = {
    ...workerState,
    last_seen_at: nowIso,
    status
  };
  lifecycleStore.save(state);
  return true;
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function resolveDispatchThreadPath(planPath: string): string {
  return path.join(path.dirname(planPath), "dispatch_threads.json");
}
