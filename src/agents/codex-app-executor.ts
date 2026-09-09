import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { ResolvedCredential } from "../hub/credential-store";
import { setTimeout as sleep } from "node:timers/promises";
import type { ReasoningEffort, SandboxMode } from "../types";
import { AppExecutionPolicySchema, AppHandoffQueue, type AppHandoffInput } from "./codex-app-queue";
import { createAppTerminalReconciler } from "./codex-app-reconciler";

export interface AppExecutorOptions {
  requestId: string;
  workerId: string;
  sessionId?: string;
  model?: string;
  effort?: ReasoningEffort;
  cwd: string;
  executionPolicy?: AppHandoffInput["executionPolicy"];
}

/** Read-only validators retain their enforced CLI sandbox, independently of task workers. */
export function useCodexApp(sandboxMode?: SandboxMode, env: NodeJS.ProcessEnv = process.env): boolean {
  const surface = env.MERIDIAN_CODEX_EXECUTION_SURFACE ?? "app";
  if (surface !== "app" && surface !== "cli") throw new Error(`Unknown Codex execution surface: ${surface}`);
  return surface === "app" && sandboxMode !== "read-only";
}

export function buildCodexAppArgs(options: Omit<AppExecutorOptions, "cwd">): string[] {
  const sourceMode = __filename.endsWith(".ts");
  const args = [process.execPath, ...(sourceMode ? ["--import", require.resolve("tsx")] : []),
    path.join(__dirname, `codex-app-executor.${sourceMode ? "ts" : "js"}`),
    "--request", options.requestId, "--worker", options.workerId];
  if (options.sessionId) args.push("--session", options.sessionId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.executionPolicy !== undefined) {
    args.push("--execution-policy", JSON.stringify(AppExecutionPolicySchema.parse(options.executionPolicy)));
  }
  return args;
}

/** Native App runs as the local App account; never silently replace a managed identity. */
export function assertCodexAppIdentity(credential: ResolvedCredential | null, env: NodeJS.ProcessEnv = process.env): void {
  const appHome = path.join(os.homedir(), ".codex");
  if (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== appHome) throw new Error("Codex App does not support a custom CODEX_HOME; select the CLI execution surface");
  if (credential && (!credential.is_host_default || path.resolve(credential.codex_home) !== appHome
    || Object.keys(credential.env_overrides).length > 0)) {
    throw new Error("Codex App does not support this managed credential or environment binding; select the CLI execution surface");
  }
}

interface Dependencies {
  queue: AppHandoffQueue;
  cancelled?: () => boolean;
  emit: (event: unknown) => void;
  wait: () => Promise<void>;
  reconcile?: (request: ReturnType<AppHandoffQueue["read"]>) => Promise<void>;
}

export async function runAppHandoff(options: AppExecutorOptions, prompt: string, deps: Dependencies): Promise<void> {
  const existing = deps.queue.list(true).find(record => record.id === options.requestId);
  // Prior CLI turns have already exited. App itself enforces exclusive writer ownership.
  const threadId = existing?.threadId ?? options.sessionId;
  if (options.sessionId && options.sessionId !== threadId) throw new Error("App handoff changed the original Codex session");
  // A pre-upgrade request already has immutable submission identity. Its
  // missing policy means unknown, never permission inherited retroactively.
  const executionPolicy = existing && existing.executionPolicy === undefined
    ? undefined : options.executionPolicy;
  let emittedThread = false;
  let lastProgress: string | undefined;
  deps.queue.create({ id: options.requestId, workerId: options.workerId, threadId,
    cwd: options.cwd, prompt, model: options.model, effort: options.effort,
    executionPolicy });
  while (true) {
    let record = deps.queue.read(options.requestId);
    if (deps.cancelled?.() && ["pending", "claimed", "started"].includes(record.state)) record = deps.queue.cancel(options.requestId);
    if (deps.reconcile && ["started", "cancel_requested"].includes(record.state)) {
      await deps.reconcile(record);
      record = deps.queue.read(options.requestId);
    }
    if (record.threadId && !emittedThread) {
      deps.emit({ type: "thread.started", thread_id: record.threadId });
      emittedThread = true;
    }
    if (emittedThread && record.progress && record.progress !== lastProgress) {
      lastProgress = record.progress;
      deps.emit({ type: "item.completed", item: { id: `app-progress-${record.updatedAt}`, type: "command_execution",
        aggregated_output: record.progress } });
    }
    if (record.state === "completed") {
      if (!record.result || record.result.status !== "completed") throw new Error("App completion has no completed turn evidence");
      deps.emit({ type: "item.completed", item: { id: record.result.turnId, type: "agent_message", text: record.result.text } });
      deps.emit({ type: "turn.completed" });
      return;
    }
    if (record.state === "failed" && record.result && record.result.status !== "completed") {
      deps.emit({ type: "turn.failed", turn_id: record.result.turnId, error: { message: record.result.text } });
      return;
    }
    if (record.state === "failed" || record.state === "cancelled") {
      throw new Error(record.result?.text || `App handoff ${record.state}`);
    }
    await deps.wait();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const encodedPolicy = value("--execution-policy");
  const options: AppExecutorOptions = {
    requestId: value("--request") ?? randomUUID(), workerId: value("--worker") ?? "standalone",
    sessionId: value("--session"), model: value("--model"), effort: value("--effort") as ReasoningEffort | undefined,
    cwd: process.cwd(),
    executionPolicy: encodedPolicy === undefined ? undefined : AppExecutionPolicySchema.parse(JSON.parse(encodedPolicy))
  };
  const queue = new AppHandoffQueue();
  const reconcile = createAppTerminalReconciler(queue, {
    onError: (error, request) => {
      process.stderr.write(`Codex App terminal reconciliation deferred for ${request.id}: ${error.message}\n`);
    }
  });
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", data => { prompt += data; });
  let cancelled = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // Keep the Hub reservation and stream alive until the App controller verifies termination.
    // This also handles cancellation before stdin/queue creation without an orphan seed.
    process.on(signal, () => { cancelled = true; });
  }
  process.stdin.on("end", () => {
    void runAppHandoff(options, prompt, {
      queue, cancelled: () => cancelled, emit: event => process.stdout.write(JSON.stringify(event) + "\n"), reconcile,
      wait: () => sleep(1000)
    }).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exitCode = 1;
    });
  });
}
