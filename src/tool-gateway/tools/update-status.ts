import * as fs from "node:fs/promises";

import type { ToolDefinition, ToolResult } from "../registry";

const STATUS_MAP = {
  in_progress: "🔄",
  done: "✅",
  failed: "⛔"
} as const;

type RequestedStatus = keyof typeof STATUS_MAP;

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
      const markdown = await fs.readFile(planPath, "utf8");
      const updated = updateWorkerStatusInMarkdown(markdown, worker, normalizedStatus);
      await fs.writeFile(planPath, updated, "utf8");
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

export function updateWorkerStatusInMarkdown(
  markdown: string,
  worker: string,
  status: RequestedStatus
): string {
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

      rowCells[statusColumn] = STATUS_MAP[status];
      return preserveTrailingNewline(markdown, replaceLine(lines, rowIndex, formatTableRow(rowCells)).join("\n"));
    }
  }

  throw new Error(`Worker not found in markdown table: ${worker}`);
}

function parseRequestedStatus(status: string): RequestedStatus {
  if (status in STATUS_MAP) {
    return status as RequestedStatus;
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

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
