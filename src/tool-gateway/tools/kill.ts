import type { HubMessage, HubResult } from "../../types";
import { sendAndWait } from "../ipc-bridge";
import type { ToolDefinition, ToolResult } from "../registry";

const KILL_TIMEOUT_MS = 5_000;
const MERIDIAN_TOOL_ACTOR_ID = "service:meridian-tool";

const killTool: ToolDefinition = {
  name: "kill",
  description: "Request Hub to stop a running coding agent thread",
  params: {
    thread_id: {
      type: "string",
      required: true,
      description: "Thread identifier returned from meridian-tool spawn"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const threadId = requireParam(params.thread_id);
    if (!threadId) {
      return {
        ok: false,
        error: "Missing required parameter: thread_id"
      };
    }

    try {
      const result = await sendAndWait(buildKillMessage(threadId), KILL_TIMEOUT_MS);
      return mapKillResult(result, threadId);
    } catch (error) {
      if (isKillTimeout(error)) {
        return {
          ok: true,
          data: {
            thread_id: threadId
          }
        };
      }

      return {
        ok: false,
        error: asError(error).message,
        data: {
          thread_id: threadId
        }
      };
    }
  }
};

export default killTool;

function buildKillMessage(threadId: string): Partial<HubMessage> {
  return {
    thread_id: threadId,
    actor_id: MERIDIAN_TOOL_ACTOR_ID,
    priority: 5,
    intent: "kill",
    target: threadId,
    mode: "bridge",
    payload: {
      content: "",
      attachments: []
    }
  };
}

function mapKillResult(result: HubResult, threadId: string): ToolResult {
  if (result.status === "error") {
    return {
      ok: false,
      error: result.content,
      data: {
        thread_id: threadId
      }
    };
  }

  return {
    ok: true,
    data: {
      thread_id: threadId
    }
  };
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isKillTimeout(error: unknown): boolean {
  return asError(error).message === `Hub timeout after ${KILL_TIMEOUT_MS}ms`;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
