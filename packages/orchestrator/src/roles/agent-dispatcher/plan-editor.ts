import * as fs from "node:fs/promises";

export interface PlanRowData {
  status: string;
  batch: string;
  worker_id: string;
  task: string;
  model: string;
  depends_on: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// Internal table-parsing helpers (follows dispatch-status.ts patterns)
// ---------------------------------------------------------------------------

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

function normalizeHeaderCell(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function findWorkerColumnIndex(normalizedHeaders: string[]): number {
  return normalizedHeaders.indexOf("worker");
}

function findDependsOnColumnIndex(normalizedHeaders: string[]): number {
  const candidates = ["depends_on", "depends", "dependencies"];
  for (const candidate of candidates) {
    const index = normalizedHeaders.indexOf(candidate);
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

interface TableLocation {
  headerLineIndex: number;
  separatorLineIndex: number;
  workerColumnIndex: number;
  dependsOnColumnIndex: number;
  headerCells: string[];
}

function findTable(lines: string[]): TableLocation | null {
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const normalizedHeaders = headerCells.map(normalizeHeaderCell);
    const workerColumnIndex = findWorkerColumnIndex(normalizedHeaders);
    if (workerColumnIndex === -1) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    return {
      headerLineIndex: index,
      separatorLineIndex: index + 1,
      workerColumnIndex,
      dependsOnColumnIndex: findDependsOnColumnIndex(normalizedHeaders),
      headerCells
    };
  }

  return null;
}

function formatRow(row: PlanRowData): string {
  return `| ${row.status} | ${row.batch} | ${row.worker_id} | ${row.task} | ${row.model} | ${row.depends_on} | ${row.notes} |`;
}

function isDashPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "—" || trimmed === "-" || trimmed === "–" || trimmed === "";
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Insert a new row immediately ABOVE the row whose Worker column matches `beforeWorkerId`.
 * Throws if the table or target worker is not found.
 */
export function insertPlanRowBefore(markdown: string, beforeWorkerId: string, row: PlanRowData): string {
  const lines = markdown.split(/\r?\n/);
  const table = findTable(lines);
  if (!table) {
    throw new Error("No markdown table found in plan");
  }

  const { separatorLineIndex, workerColumnIndex } = table;

  for (let i = separatorLineIndex + 1; i < lines.length; i += 1) {
    const cells = parseTableRow(lines[i]);
    if (!cells) {
      break;
    }

    if (cells[workerColumnIndex]?.trim() === beforeWorkerId) {
      const newLine = formatRow(row);
      lines.splice(i, 0, newLine);
      return lines.join("\n");
    }
  }

  throw new Error(`Worker "${beforeWorkerId}" not found in plan table`);
}

/**
 * Update the Depends On column for a given worker.
 * - If it is currently empty or a dash placeholder, replace with `newDependency`.
 * - Otherwise append `, newDependency`.
 * Returns the markdown unchanged if the worker is not found.
 */
export function updateDependsOnColumn(markdown: string, workerId: string, newDependency: string): string {
  const lines = markdown.split(/\r?\n/);
  const table = findTable(lines);
  if (!table) {
    return markdown;
  }

  const { separatorLineIndex, workerColumnIndex, dependsOnColumnIndex } = table;
  if (dependsOnColumnIndex === -1) {
    return markdown;
  }

  for (let i = separatorLineIndex + 1; i < lines.length; i += 1) {
    const cells = parseTableRow(lines[i]);
    if (!cells) {
      break;
    }

    if (cells[workerColumnIndex]?.trim() === workerId) {
      const currentValue = cells[dependsOnColumnIndex] ?? "";

      if (isDashPlaceholder(currentValue)) {
        cells[dependsOnColumnIndex] = newDependency;
      } else {
        cells[dependsOnColumnIndex] = `${currentValue.trim()}, ${newDependency}`;
      }

      // Reconstruct the line
      lines[i] = "| " + cells.join(" | ") + " |";
      return lines.join("\n");
    }
  }

  return markdown;
}

// ---------------------------------------------------------------------------
// Async file wrappers
// ---------------------------------------------------------------------------

export async function insertPlanRowBeforeInFile(
  planPath: string,
  beforeWorkerId: string,
  row: PlanRowData
): Promise<void> {
  const markdown = await fs.readFile(planPath, "utf8");
  const updated = insertPlanRowBefore(markdown, beforeWorkerId, row);
  await fs.writeFile(planPath, updated, "utf8");
}

export async function updateDependsOnInFile(
  planPath: string,
  workerId: string,
  newDependency: string
): Promise<void> {
  const markdown = await fs.readFile(planPath, "utf8");
  const updated = updateDependsOnColumn(markdown, workerId, newDependency);
  await fs.writeFile(planPath, updated, "utf8");
}
