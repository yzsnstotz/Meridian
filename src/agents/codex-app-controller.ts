import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { flockSync } from "fs-ext";
import { z } from "zod";
import { AppHandoffQueue } from "./codex-app-queue";
import { appHandoffExecution } from "./codex-app-delivery";

const ControllerId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/, "Invalid controller identifier");
const Checkpoint = z.object({
  version: z.literal(1), controller: ControllerId,
  lastCheckAt: z.string().datetime().optional(), lastAuditCompletedAt: z.string().datetime().optional()
});
type CheckpointState = z.infer<typeof Checkpoint>;

/** Compact native-controller duty checklist. Never submits or changes queue ownership. */
export class AppControllerDuties {
  constructor(readonly queue = new AppHandoffQueue(), readonly now: () => Date = () => new Date()) {}

  private update<T>(controller: string, action: (state: CheckpointState) => T): T {
    ControllerId.parse(controller);
    // Subdirectory keeps controller checkpoints out of queue record enumeration.
    const directory = path.join(this.queue.directory, ".controllers");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${controller}.json`);
    const lock = openSync(path.join(directory, ".checkpoint.flock"), "a", 0o600);
    try {
      flockSync(lock, "ex");
      let state: CheckpointState;
      try { state = Checkpoint.parse(JSON.parse(readFileSync(filename, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = { version: 1, controller };
      }
      if (state.controller !== controller) throw new Error("Controller checkpoint identity mismatch");
      const result = action(state);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const file = openSync(temporary, "wx", 0o600);
      try { writeFileSync(file, JSON.stringify(Checkpoint.parse(state)) + "\n"); fsyncSync(file); }
      finally { closeSync(file); }
      renameSync(temporary, filename);
      const dir = openSync(directory, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return result;
    } finally { flockSync(lock, "un"); closeSync(lock); }
  }

  check(controller: string) {
    return this.update(controller, state => {
      const now = this.now();
      const requests = this.queue.list().map(record => ({
        ...appHandoffExecution(record), worker_id: record.workerId,
        controller: record.controller ?? null,
        action: record.controller && record.controller !== controller ? "other_controller"
          : record.state === "cancel_requested" ? "reconcile_cancellation"
          : record.state === "started" ? "observe_exact_turn"
          : record.submissionAttempted ? "reconcile_submission" : "submit_native",
        pending_age_seconds: Math.max(0, Math.floor((now.getTime() - Date.parse(record.createdAt)) / 1000))
      }));
      const previousCheckAt = state.lastCheckAt ?? null;
      state.lastCheckAt = now.toISOString();
      return {
        controller, checked_at: state.lastCheckAt, previous_check_at: previousCheckAt,
        last_audit_completed_at: state.lastAuditCompletedAt ?? null,
        audit_due: !state.lastAuditCompletedAt || now.getTime() < Date.parse(state.lastAuditCompletedAt)
          || now.getTime() - Date.parse(state.lastAuditCompletedAt) >= 60 * 60_000,
        requests
      };
    });
  }

  /** Call only after the controller has actually completed the deep audit. */
  auditComplete(controller: string) {
    return this.update(controller, state => {
      state.lastAuditCompletedAt = this.now().toISOString();
      return { controller, last_audit_completed_at: state.lastAuditCompletedAt };
    });
  }
}

if (require.main === module) {
  try {
    const [command, controller] = process.argv.slice(2);
    const duties = new AppControllerDuties();
    if (command !== "check" && command !== "audit-complete") throw new Error("Usage: codex-app-controller check|audit-complete CONTROLLER");
    process.stdout.write(JSON.stringify(command === "check" ? duties.check(controller) : duties.auditComplete(controller)) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
