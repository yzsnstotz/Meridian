import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Logger } from "../base-role";
import {
  DispatchThreadStateV2Schema,
  type DispatchThreadStateV2,
  type HubResult,
  type LifecycleStatus,
  type LifecycleWorkerEntry
} from "../../types";

const EPOCH_ISO = new Date(0).toISOString();
const DISPATCH_PLAN_FILENAME = "dispatch_plan.md";

const LegacyWorkerThreadEntrySchema = z.object({
  thread_id: z.string().min(1),
  started_at: z.string().datetime().optional()
});

const LegacyDispatchThreadFileSchema = z.object({
  dispatcher_thread_id: z.string().min(1).nullable().optional(),
  workers: z
    .record(z.string(), z.union([z.string().min(1), LegacyWorkerThreadEntrySchema]))
    .default({})
});

const PLAN_STATUS_SYMBOLS: Record<LifecycleStatus, string> = {
  pending: "⬜",
  running: "🔄",
  completed: "✅",
  failed: "❌",
  abandoned: "⚠️ ABANDONED",
  skipped: "⛔ SKIPPED"
};

export interface LifecycleStoreOptions {
  beforeCommit?: (tempFilePath: string, targetFilePath: string) => void;
  dispatchPlanPath?: string;
  log?: Pick<Logger, "info">;
  now?: () => string;
}

export class LifecycleStore {
  readonly filePath: string;

  private readonly beforeCommit?: (tempFilePath: string, targetFilePath: string) => void;
  private readonly dispatchPlanPath: string;
  private readonly log: Pick<Logger, "info">;
  private readonly now: () => string;

  constructor(filePath: string, options: LifecycleStoreOptions = {}) {
    this.filePath = filePath;
    this.beforeCommit = options.beforeCommit;
    this.dispatchPlanPath = options.dispatchPlanPath ?? path.join(path.dirname(filePath), DISPATCH_PLAN_FILENAME);
    this.log = options.log ?? console;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  load(): DispatchThreadStateV2 {
    let raw: string;

    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return buildEmptyDispatchThreadStateV2();
      }

      throw error;
    }

    if (raw.trim().length === 0) {
      const emptyState = buildEmptyDispatchThreadStateV2();
      this.save(emptyState);
      return emptyState;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (isDispatchThreadStateV2(parsed)) {
      return DispatchThreadStateV2Schema.parse(parsed);
    }

    const migrated = migrateLegacyState(parsed);
    this.save(migrated);
    return migrated;
  }

  save(state: DispatchThreadStateV2): void {
    const normalized = DispatchThreadStateV2Schema.parse(state);
    writeFileAtomically(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, this.beforeCommit);
    this.syncPlanView(normalized);
  }

  recordDispatcher(threadId: string): void {
    const state = this.load();
    const previousStatus = state.dispatcher.status;
    state.dispatcher = {
      thread_id: threadId,
      started_at: this.now(),
      status: "running"
    };
    this.logTransition("dispatcher", previousStatus, "running", "record_dispatcher");
    this.save(state);
  }

  recordWorkerStart(
    workerId: string,
    threadId: string,
    traceId: string,
    expectedOutputs: string[],
    commandPreamble?: string | null
  ): void {
    const state = this.load();
    const nowIso = this.now();
    const previousStatus = state.workers[workerId]?.status ?? "pending";

    state.workers[workerId] = {
      thread_id: threadId,
      trace_id: traceId,
      started_at: nowIso,
      last_seen_at: nowIso,
      status: "running",
      expected_outputs: [...expectedOutputs],
      hub_result: null,
      command_preamble: commandPreamble ?? null
    };

    this.logTransition(workerId, previousStatus, "running", "run_tool_start");
    this.save(state);
  }

  recordWorkerResult(workerId: string, hubResult: HubResult): void {
    const state = this.load();
    const worker = state.workers[workerId];
    if (!worker) {
      throw new Error(`Worker not found in lifecycle state: ${workerId}`);
    }

    const nextStatus = mapHubResultToLifecycleStatus(hubResult, requiresOutputVerification(worker.expected_outputs));
    state.workers[workerId] = {
      ...worker,
      thread_id: hubResult.thread_id || worker.thread_id,
      trace_id: hubResult.trace_id || worker.trace_id,
      last_seen_at: hubResult.timestamp,
      status: nextStatus,
      hub_result: hubResult
    };

    this.logTransition(workerId, worker.status, nextStatus, "hub_result");
    this.save(state);
  }

  markAbandoned(workerId: string, reason: string): void {
    const state = this.load();
    const worker = state.workers[workerId];
    if (!worker) {
      throw new Error(`Worker not found in lifecycle state: ${workerId}`);
    }

    state.workers[workerId] = {
      ...worker,
      status: "abandoned",
      last_seen_at: this.now()
    };

    this.logTransition(workerId, worker.status, "abandoned", reason);
    this.save(state);
  }

  setWorkerStatus(
    workerId: string,
    status: LifecycleStatus,
    trigger: string,
    options: {
      clearHubResult?: boolean;
    } = {}
  ): void {
    const state = this.load();
    const worker = state.workers[workerId];
    if (!worker) {
      throw new Error(`Worker not found in lifecycle state: ${workerId}`);
    }

    state.workers[workerId] = {
      ...worker,
      last_seen_at: this.now(),
      status,
      hub_result: options.clearHubResult ? null : worker.hub_result
    };

    this.logTransition(workerId, worker.status, status, trigger);
    this.save(state);
  }

  getWorkersInState(status: LifecycleStatus): LifecycleWorkerEntry[] {
    const state = this.load();

    return Object.entries(state.workers)
      .filter(([, worker]) => worker.status === status)
      .map(([workerId, worker]) => ({
        worker_id: workerId,
        ...cloneWorker(worker)
      }));
  }

  toPlanMarkdown(planTemplate: string): string {
    return renderPlanMarkdown(this.load(), planTemplate);
  }

  private syncPlanView(state: DispatchThreadStateV2): void {
    let planTemplate: string;

    try {
      planTemplate = fs.readFileSync(this.dispatchPlanPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }

      throw error;
    }

    const nextPlan = renderPlanMarkdown(state, planTemplate);
    if (nextPlan === planTemplate) {
      return;
    }

    writeFileAtomically(this.dispatchPlanPath, nextPlan);
  }

  logTransition(workerId: string, fromStatus: LifecycleStatus, toStatus: LifecycleStatus, trigger: string): void {
    if (fromStatus === toStatus) {
      return;
    }

    this.log.info("Lifecycle transition", {
      event: "worker_transition",
      worker_id: workerId,
      from_status: fromStatus,
      to_status: toStatus,
      trigger
    });
  }
}

function renderPlanMarkdown(state: DispatchThreadStateV2, planTemplate: string): string {
  const lines = planTemplate.split(/\r?\n/);

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

    let mutated = false;
    const nextLines = [...lines];

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      const workerState = state.workers[rowCells[workerColumn]];
      if (!workerState) {
        continue;
      }

      rowCells[statusColumn] = PLAN_STATUS_SYMBOLS[workerState.status];
      nextLines[rowIndex] = formatTableRow(rowCells);
      mutated = true;
    }

    if (mutated) {
      return preserveTrailingNewline(planTemplate, nextLines.join("\n"));
    }

    break;
  }

  return planTemplate;
}

export function buildEmptyDispatchThreadStateV2(): DispatchThreadStateV2 {
  return {
    version: 2,
    dispatcher: {
      thread_id: null,
      started_at: null,
      status: "pending"
    },
    workers: {},
    last_reconciled_at: null
  };
}

function isDispatchThreadStateV2(value: unknown): boolean {
  return typeof value === "object" && value !== null && "version" in value && value.version === 2;
}

function migrateLegacyState(value: unknown): DispatchThreadStateV2 {
  const legacyState = LegacyDispatchThreadFileSchema.parse(value);
  const workers = Object.fromEntries(
    Object.entries(legacyState.workers).map(([workerId, entry]) => {
      if (typeof entry === "string") {
        return [
          workerId,
          {
            thread_id: entry,
            trace_id: null,
            started_at: EPOCH_ISO,
            last_seen_at: EPOCH_ISO,
            status: "running",
            expected_outputs: [],
            hub_result: null
          }
        ];
      }

      const startedAt = entry.started_at ?? EPOCH_ISO;
      return [
        workerId,
        {
          thread_id: entry.thread_id,
          trace_id: null,
          started_at: startedAt,
          last_seen_at: startedAt,
          status: "running",
          expected_outputs: [],
          hub_result: null
        }
      ];
    })
  );

  return DispatchThreadStateV2Schema.parse({
    version: 2,
    dispatcher: legacyState.dispatcher_thread_id
      ? {
          thread_id: legacyState.dispatcher_thread_id,
          started_at: EPOCH_ISO,
          status: "running"
        }
      : {
          thread_id: null,
          started_at: null,
          status: "pending"
        },
    workers,
    last_reconciled_at: null
  });
}

function mapHubResultToLifecycleStatus(hubResult: HubResult, deferSuccessUntilReconciled: boolean): LifecycleStatus {
  if (hubResult.status === "error") {
    return "failed";
  }

  if (isNonCompletionContent(hubResult.content)) {
    return "running";
  }

  if (hubResult.status === "success" && (!hubResult.run_state || hubResult.run_state === "completed")) {
    return deferSuccessUntilReconciled ? "running" : "completed";
  }

  return "running";
}

const NON_COMPLETION_PATTERNS = [
  /⏸\s*PAUSE/,
  /⛔\s*BLOCKED/,
  /PAUSE\s*[—–-]/,
  /BLOCKED\s*[—–-]/
];

function isNonCompletionContent(content: string): boolean {
  return NON_COMPLETION_PATTERNS.some((pattern) => pattern.test(content));
}

function requiresOutputVerification(expectedOutputs: string[]): boolean {
  return expectedOutputs.length > 0;
}

function cloneWorker(worker: DispatchThreadStateV2["workers"][string]): DispatchThreadStateV2["workers"][string] {
  return {
    ...worker,
    expected_outputs: [...worker.expected_outputs],
    hub_result: worker.hub_result
      ? {
          ...worker.hub_result,
          attachments: worker.hub_result.attachments.map((attachment) => ({ ...attachment }))
        }
      : null
  };
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

function preserveTrailingNewline(original: string, updated: string): string {
  return original.endsWith("\n") ? `${updated}\n` : updated;
}

function writeFileAtomically(
  targetFilePath: string,
  payload: string,
  beforeCommit?: (tempFilePath: string, targetFilePath: string) => void
): void {
  const directory = path.dirname(targetFilePath);
  const tempFilePath = `${targetFilePath}.${process.pid}.${Date.now()}.tmp`;

  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(tempFilePath, payload, "utf8");
    beforeCommit?.(tempFilePath, targetFilePath);
    fs.renameSync(tempFilePath, targetFilePath);
  } catch (error) {
    cleanupTempFile(tempFilePath);
    throw error;
  }
}

function cleanupTempFile(tempFilePath: string): void {
  try {
    fs.unlinkSync(tempFilePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
