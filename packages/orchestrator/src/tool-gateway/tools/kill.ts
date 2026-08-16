import { createMeridianApiClient } from "../../roles/agent-dispatcher/meridian-api-client";
import type { ToolDefinition, ToolResult } from "../registry";

const killTool: ToolDefinition = {
  name: "kill",
  description: "Request Meridian to stop a running coding agent thread",
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
      const client = createMeridianApiClient();
      const result = await client.kill(threadId);
      return {
        ok: true,
        data: {
          thread_id: result.threadId
        }
      };
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

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isKillTimeout(error: unknown): boolean {
  const message = asError(error).message;
  return message.includes("timed out") || message.includes("timeout");
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
