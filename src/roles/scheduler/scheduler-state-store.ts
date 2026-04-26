import * as fs from "node:fs";
import path from "node:path";

import {
  SchedulerRunStateSchema,
  type SchedulerRunState,
  type SchedulerRunSummary
} from "../../types";

const SCHEDULER_STATE_FILENAME = "scheduler_state.json";
const MAX_RUN_HISTORY = 50;

export class SchedulerStateStore {
  readonly filePath: string;

  constructor(dispatchPlanPath: string) {
    this.filePath = path.join(path.dirname(dispatchPlanPath), SCHEDULER_STATE_FILENAME);
  }

  load(): SchedulerRunState {
    let raw: string;

    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return buildEmptyRunState();
      }
      throw error;
    }

    if (raw.trim().length === 0) {
      return buildEmptyRunState();
    }

    return SchedulerRunStateSchema.parse(JSON.parse(raw));
  }

  save(state: SchedulerRunState): void {
    const normalized = SchedulerRunStateSchema.parse(state);

    // Trim run history to max
    if (normalized.run_history.length > MAX_RUN_HISTORY) {
      normalized.run_history = normalized.run_history.slice(-MAX_RUN_HISTORY);
    }

    writeFileAtomically(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  }

  appendRunSummary(summary: SchedulerRunSummary): void {
    const state = this.load();
    state.run_history.push(summary);
    this.save(state);
  }
}

export function buildEmptyRunState(): SchedulerRunState {
  return {
    status: "idle",
    current_run_id: null,
    current_run_report_dir: null,
    current_scan_run_id: null,
    current_dispatcher_thread_id: null,
    completed_cycles: 0,
    next_run_at: null,
    last_run_completed_at: null,
    last_run_outcome: null,
    last_report_path: null,
    plan_lock_owner: null,
    run_history: []
  };
}

function writeFileAtomically(targetFilePath: string, payload: string): void {
  const directory = path.dirname(targetFilePath);
  const tempFilePath = `${targetFilePath}.${process.pid}.${Date.now()}.tmp`;

  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(tempFilePath, payload, "utf8");
    fs.renameSync(tempFilePath, targetFilePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempFilePath);
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
