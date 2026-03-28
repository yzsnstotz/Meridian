import type { HubMessage, HubResult } from "../../types";
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

    const command = requireParam(params.command, "command");
    if (!command) {
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
      const result = await sendAndWait(buildRunMessage(threadId, command), 0);
      return mapRunResult(result, worker);
    } catch (error) {
      if (interrupted || INTERRUPT_MESSAGES.has(asError(error).message)) {
        return interruptedResult(worker);
      }

      return failedResult(worker, asError(error).message);
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

function mapRunResult(result: HubResult, worker: string): ToolResult {
  if (result.status === "success" || result.status === "partial") {
    return {
      ok: true,
      data: {
        worker,
        status: "done",
        summary: result.content
      }
    };
  }

  return failedResult(worker, result.content);
}

function interruptedResult(worker: string): ToolResult {
  return failedResult(worker, INTERRUPTED_ERROR);
}

function failedResult(worker: string, error: string): ToolResult {
  return {
    ok: false,
    error,
    data: {
      worker,
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
