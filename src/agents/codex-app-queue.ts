import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { flockSync } from "fs-ext";

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/, "Invalid identifier");
const ThreadId = z.string().uuid("Invalid Codex thread ID");
const Input = z.object({
  id: Id, workerId: z.string().min(1), threadId: ThreadId.optional(), cwd: z.string().min(1),
  prompt: z.string().min(1), model: z.string().optional(), effort: z.string().optional()
});
const Result = z.object({
  threadId: ThreadId, turnId: z.string().min(1),
  status: z.enum(["completed", "failed", "interrupted"]), text: z.string().min(1)
});
const State = z.enum(["pending", "claimed", "started", "cancel_requested", "completed", "failed", "cancelled"]);
const Record = Input.extend({
  submissionAttempted: z.boolean().default(false),
  state: State, controller: Id.optional(), turnId: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(), result: Result.optional(),
  receipt: z.string().optional(), progress: z.string().optional(),
  history: z.array(z.object({ state: State, at: z.string() }))
});
export type AppHandoffRequest = z.infer<typeof Record>;
export type AppHandoffInput = z.infer<typeof Input>;
export type AppTurnResult = z.infer<typeof Result>;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function defaultAppQueueDirectory(): string {
  return process.env.MERIDIAN_CODEX_APP_QUEUE_DIR || path.join(os.homedir(), ".meridian", "codex-app-queue");
}

/** Private local IPC queue. All transitions serialize across Hub and App controllers. */
export class AppHandoffQueue {
  constructor(readonly directory = defaultAppQueueDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private filename(id: string): string { return path.join(this.directory, `${Id.parse(id)}.json`); }

  private locked<T>(action: () => T): T {
    // POSIX advisory locks are released by the kernel even after SIGKILL or reboot.
    // The lock file is never removed: unlinking a locked inode could split the mutex.
    const fd = openSync(path.join(this.directory, ".transition.flock"), "a", 0o600);
    try {
      flockSync(fd, "ex");
      try { return action(); } finally { flockSync(fd, "un"); }
    } finally { closeSync(fd); }
  }

  read(id: string): AppHandoffRequest { return Record.parse(JSON.parse(readFileSync(this.filename(id), "utf8"))); }

  list(includeTerminal = false): AppHandoffRequest[] {
    return readdirSync(this.directory).filter(name => name.endsWith(".json"))
      .map(name => this.read(name.slice(0, -5)))
      .filter(item => includeTerminal || !TERMINAL.has(item.state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private save(record: AppHandoffRequest): AppHandoffRequest {
    const checked = Record.parse(record);
    const target = this.filename(checked.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(checked, null, 2) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, target);
    const directoryFd = openSync(this.directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return checked;
  }

  create(input: AppHandoffInput): AppHandoffRequest {
    const checked = Input.parse(input);
    return this.locked(() => {
      const records = this.list(true);
      const existing = records.find(item => item.id === checked.id);
      if (existing) {
        if (JSON.stringify(Input.parse({ ...existing, threadId: checked.threadId })) !== JSON.stringify(checked)
          || (checked.threadId && existing.threadId !== checked.threadId)) throw new Error("Request content conflict");
        return existing;
      }
      if (records.some(item => (item.workerId === checked.workerId || (checked.threadId && item.threadId === checked.threadId)) && !TERMINAL.has(item.state))) {
        throw new Error("Codex thread already has an active App handoff; reconcile its original request before retrying");
      }
      const at = new Date().toISOString();
      return this.save({ ...checked, submissionAttempted: false, state: "pending", createdAt: at, updatedAt: at, history: [{ state: "pending", at }] });
    });
  }

  private transition(id: string, update: (record: AppHandoffRequest) => void): AppHandoffRequest {
    return this.locked(() => {
      const record = this.read(id);
      update(record);
      record.updatedAt = new Date().toISOString();
      record.history.push({ state: record.state, at: record.updatedAt });
      return this.save(record);
    });
  }

  claim(id: string, controller: string): AppHandoffRequest {
    Id.parse(controller);
    return this.transition(id, record => {
      if (record.state !== "pending") throw new Error(`Request already ${record.state}; do not send another turn`);
      record.controller = controller;
      record.state = "claimed";
    });
  }

  submit(id: string, controller: string): AppHandoffRequest {
    return this.transition(id, record => {
      this.assertController(record, controller);
      if (record.state !== "claimed" || record.submissionAttempted) throw new Error("Native submission is not allowed; never resend an uncertain request");
      record.submissionAttempted = true;
    });
  }

  private assertController(record: AppHandoffRequest, controller: string): void {
    if (record.controller !== controller) throw new Error("Wrong App controller");
  }

  bindThread(id: string, controller: string, threadId: string): AppHandoffRequest {
    ThreadId.parse(threadId);
    return this.transition(id, record => {
      this.assertController(record, controller);
      if (!["claimed", "cancel_requested"].includes(record.state)) throw new Error("Request is not claimed");
      if (record.threadId && record.threadId !== threadId) throw new Error("App thread conflict");
      if (this.list().some(other => other.id !== id && other.threadId === threadId)) throw new Error("App thread already active");
      record.threadId = threadId;
    });
  }

  started(id: string, controller: string, turnId: string): AppHandoffRequest {
    z.string().min(1).parse(turnId);
    return this.transition(id, record => {
      this.assertController(record, controller);
      if (!record.submissionAttempted) throw new Error("No native submission intent recorded");
      if (!record.threadId) throw new Error("No native App thread is bound");
      if (!["claimed", "started", "cancel_requested"].includes(record.state)) throw new Error("Request is not claimed");
      if (record.turnId && record.turnId !== turnId) throw new Error("App turn conflict; do not duplicate execution");
      record.turnId = turnId;
      if (record.state !== "cancel_requested") record.state = "started";
    });
  }

  complete(id: string, controller: string, input: AppTurnResult): AppHandoffRequest {
    const result = Result.parse(input);
    return this.transition(id, record => {
      this.assertController(record, controller);
      if (record.threadId !== result.threadId || record.turnId !== result.turnId) throw new Error("App thread/turn mismatch");
      if (!["started", "cancel_requested"].includes(record.state)) throw new Error("No active App turn to complete");
      record.result = result;
      record.state = record.state === "cancel_requested" ? "cancelled" : result.status === "completed" ? "completed" : "failed";
    });
  }

  observe(id: string, controller: string, receipt: string, progress?: string): AppHandoffRequest {
    return this.transition(id, record => {
      this.assertController(record, controller);
      if (TERMINAL.has(record.state)) throw new Error("Cannot update a terminal request");
      record.receipt = receipt;
      if (progress) record.progress = progress;
    });
  }

  cancel(id: string): AppHandoffRequest {
    return this.transition(id, record => {
      if (TERMINAL.has(record.state)) return;
      record.state = !record.submissionAttempted ? "cancelled" : "cancel_requested";
    });
  }
}

if (require.main === module) {
  try {
    const [command, id, controller, argument] = process.argv.slice(2);
    const queue = new AppHandoffQueue();
    let result: unknown;
    switch (command) {
      case "list": result = queue.list().map(({ prompt, ...record }) => ({ ...record, promptCharacters: prompt.length })); break;
      case "read": result = queue.read(id); break;
      case "claim": result = queue.claim(id, controller); break;
      case "submit": result = queue.submit(id, controller); break;
      case "bind": result = queue.bindThread(id, controller, argument); break;
      case "started": result = queue.started(id, controller, argument); break;
      case "complete": result = queue.complete(id, controller, JSON.parse(readFileSync(argument, "utf8"))); break;
      case "observe": {
        const observation = JSON.parse(readFileSync(argument, "utf8"));
        result = queue.observe(id, controller, observation.receipt, observation.progress);
        break;
      }
      case "cancel": result = queue.cancel(id); break;
      default: throw new Error("Usage: codex-app-queue list|read ID|claim ID CONTROLLER|submit ID CONTROLLER|observe ID CONTROLLER FILE|bind ID CONTROLLER THREAD|started ID CONTROLLER TURN|complete ID CONTROLLER RESULT_FILE|cancel ID");
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
