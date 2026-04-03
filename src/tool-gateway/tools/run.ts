import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { HubMessage, HubResult, HubRunState } from "../../types";
import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { sendAndWait } from "../ipc-bridge";
import type { ToolDefinition, ToolResult } from "../registry";

const DEV_HISTORY_DIRECTORY = "dev_history";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const MERIDIAN_TOOL_ACTOR_ID = "service:meridian-tool";
const INTERRUPTED_ERROR = "interrupted";
const INTERRUPT_MESSAGES = new Set(["Tool Gateway interrupted by SIGINT", INTERRUPTED_ERROR]);

const runTool: ToolDefinition = {
  name: "run",
  description: "Run a command file in an existing coding agent thread through Meridian Hub",
  params: {
    thread_id: {
      type: "string",
      required: true,
      description: "Thread identifier returned from meridian-tool spawn"
    },
    command: {
      type: "string",
      required: true,
      description: "Absolute path to the command file that Hub should run"
    },
    worker: {
      type: "string",
      required: true,
      description: "Worker identifier for CLI status reporting"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const threadId = requireParam(params.thread_id, "thread_id");
    if (!threadId) {
      return missingParam("thread_id");
    }

    const commandPath = requireParam(params.command, "command");
    if (!commandPath) {
      return missingParam("command");
    }

    const worker = requireParam(params.worker, "worker");
    if (!worker) {
      return missingParam("worker");
    }

    let interrupted = false;
    const handleSigint = (): void => {
      interrupted = true;
    };

    process.once("SIGINT", handleSigint);

    try {
      const commandText = await readFile(commandPath, "utf8");
      const traceId = randomUUID();
      const lifecycleStore = createLifecycleStore(commandPath);
      lifecycleStore.recordWorkerStart(worker, threadId, traceId, deriveExpectedOutputs(commandPath, worker));

      const result = await sendAndWait(buildRunMessage(threadId, commandText, traceId), 0);
      lifecycleStore.recordWorkerResult(worker, result);
      return mapRunResult(result, worker, threadId);
    } catch (error) {
      const resolvedError = asError(error);
      console.error("run tool execution failed", {
        worker,
        threadId,
        error: resolvedError.message
      });

      if (interrupted || INTERRUPT_MESSAGES.has(resolvedError.message)) {
        return interruptedResult(worker, threadId);
      }

      return failedResult(worker, threadId, resolvedError.message);
    } finally {
      process.removeListener("SIGINT", handleSigint);
    }
  }
};

export default runTool;

function buildRunMessage(threadId: string, command: string, traceId: string): Partial<HubMessage> {
  return {
    trace_id: traceId,
    thread_id: threadId,
    actor_id: MERIDIAN_TOOL_ACTOR_ID,
    priority: 5,
    intent: "run",
    target: threadId,
    mode: "bridge",
    payload: {
      content: command,
      attachments: []
    }
  };
}

function createLifecycleStore(commandPath: string): LifecycleStore {
  return new LifecycleStore(path.join(path.dirname(commandPath), DISPATCH_THREADS_FILENAME));
}

function deriveExpectedOutputs(commandPath: string, workerId: string): string[] {
  return [path.join(path.dirname(commandPath), DEV_HISTORY_DIRECTORY, `${workerId}_report.md`)];
}

function mapRunResult(result: HubResult, worker: string, threadId: string): ToolResult {
  if (result.status === "error") {
    return failedResult(worker, threadId, result.content);
  }

  const runState = inferRunState(result);
  if (runState !== "completed") {
    return {
      ok: true,
      data: {
        worker,
        thread_id: threadId,
        status: "in_progress",
        run_state: runState,
        summary: result.content
      }
    };
  }

  return {
    ok: true,
    data: {
      worker,
      thread_id: threadId,
      status: "done",
      run_state: "completed",
      summary: result.content
    }
  };
}

function inferRunState(result: HubResult): HubRunState {
  if (result.run_state) {
    return result.run_state;
  }

  if (result.status === "partial") {
    return "still_running";
  }

  if (result.status === "timeout") {
    return "timeout";
  }

  return "completed";
}

function interruptedResult(worker: string, threadId: string): ToolResult {
  return failedResult(worker, threadId, INTERRUPTED_ERROR);
}

function failedResult(worker: string, threadId: string, error: string): ToolResult {
  return {
    ok: false,
    error,
    data: {
      worker,
      thread_id: threadId,
      status: "failed"
    }
  };
}

function missingParam(name: string): ToolResult {
  return {
    ok: false,
    error: `Missing required parameter: ${name}`
  };
}

function requireParam(value: string | undefined, _name: string): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
