import type { HubMessage, HubResult, HubRunState } from "../../types";
import { readFile } from "node:fs/promises";
import { sendAndWait } from "../ipc-bridge";
import type { ToolDefinition, ToolResult } from "../registry";

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
      const result = await sendAndWait(buildRunMessage(threadId, commandText), 0);
      return mapRunResult(result, worker, threadId);
    } catch (error) {
      if (interrupted || INTERRUPT_MESSAGES.has(asError(error).message)) {
        return interruptedResult(worker, threadId);
      }

      return failedResult(worker, threadId, asError(error).message);
    } finally {
      process.removeListener("SIGINT", handleSigint);
    }
  }
};

export default runTool;

function buildRunMessage(threadId: string, command: string): Partial<HubMessage> {
  return {
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
