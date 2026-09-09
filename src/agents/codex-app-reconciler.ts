import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";

import { AppHandoffQueue, type AppHandoffRequest } from "./codex-app-queue";

const NativeAppObservation = z.object({
  threadId: z.string().uuid(),
  turnId: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  text: z.string().nullable().optional(),
  progress: z.string().optional()
});

export type NativeAppObservation = z.infer<typeof NativeAppObservation>;
export type AppTurnObserver = (request: AppHandoffRequest) => Promise<NativeAppObservation>;

export interface AppTerminalReconcileResult {
  outcome: "recovered" | "not_terminal" | "needs_external_reconciliation" | "already_terminal";
  state: AppHandoffRequest["state"];
}

const ACTIVE_TURN_STATES = new Set<AppHandoffRequest["state"]>(["started", "cancel_requested"]);
const TERMINAL_STATES = new Set<AppHandoffRequest["state"]>(["completed", "failed", "cancelled"]);

/**
 * Recover only a turn that the App controller already submitted and bound.
 * Submission, thread discovery and retry ownership intentionally stay outside
 * this path so transcript recovery can never launch duplicate work.
 */
export async function reconcileStartedAppRequest(
  queue: AppHandoffQueue,
  requestId: string,
  observe: AppTurnObserver
): Promise<AppTerminalReconcileResult> {
  const request = queue.read(requestId);
  if (TERMINAL_STATES.has(request.state)) {
    return { outcome: "already_terminal", state: request.state };
  }
  if (!ACTIVE_TURN_STATES.has(request.state) || !request.controller || !request.threadId || !request.turnId) {
    return { outcome: "needs_external_reconciliation", state: request.state };
  }

  const observation = NativeAppObservation.parse(await observe(request));
  if (observation.threadId !== request.threadId || observation.turnId !== request.turnId) {
    throw new Error(`Native App thread/turn mismatch for request ${request.id}`);
  }
  if (observation.status === "running") {
    return { outcome: "not_terminal", state: request.state };
  }
  if (!observation.text?.trim()) {
    return { outcome: "needs_external_reconciliation", state: request.state };
  }

  // The external controller may have completed the request while the read-only
  // observer was running. Re-read before taking the controller-bound transition.
  const latest = queue.read(request.id);
  if (TERMINAL_STATES.has(latest.state)) {
    return { outcome: "already_terminal", state: latest.state };
  }
  if (!ACTIVE_TURN_STATES.has(latest.state)
      || latest.controller !== request.controller
      || latest.threadId !== observation.threadId
      || latest.turnId !== observation.turnId) {
    throw new Error(`Durable App binding changed while reconciling request ${request.id}`);
  }

  const completed = queue.complete(request.id, request.controller, {
    threadId: observation.threadId,
    turnId: observation.turnId,
    status: observation.status,
    text: observation.text
  });
  return { outcome: "recovered", state: completed.state };
}

export interface CodexStateObserverOptions {
  queueDirectory: string;
  pythonExecutable?: string;
  observerScript?: string;
  stateDatabase?: string;
  timeoutMs?: number;
}

/** Run the existing marker-bound observer without exposing the queued prompt. */
export async function observeCodexAppTurn(
  request: AppHandoffRequest,
  options: CodexStateObserverOptions
): Promise<NativeAppObservation> {
  const observerScript = options.observerScript
    ?? path.resolve(__dirname, "../../scripts/codex-app-observe.py");
  const requestFile = path.join(options.queueDirectory, `${request.id}.json`);
  const args = ["-B", observerScript, "--request-file", requestFile];
  if (options.stateDatabase) args.push("--state-db", options.stateDatabase);
  const stdout = await execFileText(options.pythonExecutable ?? "python3", args, options.timeoutMs ?? 10_000);
  return NativeAppObservation.parse(JSON.parse(stdout));
}

function execFileText(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export interface AppTerminalReconcilerOptions {
  observe?: AppTurnObserver;
  intervalMs?: number;
  now?: () => number;
  onError?: (error: Error, request: AppHandoffRequest) => void;
}

/** Build a per-executor throttled recovery hook for the polling loop. */
export function createAppTerminalReconciler(
  queue: AppHandoffQueue,
  options: AppTerminalReconcilerOptions = {}
): (request: AppHandoffRequest) => Promise<void> {
  const intervalMs = options.intervalMs ?? 15_000;
  const now = options.now ?? Date.now;
  const observe = options.observe ?? ((request) => observeCodexAppTurn(request, {
    queueDirectory: queue.directory
  }));
  let nextAttemptAt = 0;

  return async (request) => {
    if (!ACTIVE_TURN_STATES.has(request.state) || now() < nextAttemptAt) return;
    nextAttemptAt = now() + intervalMs;
    try {
      await reconcileStartedAppRequest(queue, request.id, observe);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)), request);
    }
  };
}
