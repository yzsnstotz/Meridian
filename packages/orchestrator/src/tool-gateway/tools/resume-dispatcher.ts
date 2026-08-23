import {
  buildServiceErrorData,
  postRolesServiceJson
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const resumeDispatcherTool: ToolDefinition = {
  name: "resume-dispatcher",
  description: "Resume a paused agent-dispatcher role",
  params: {
    dispatcher: {
      type: "string",
      required: true,
      description: "Agent-dispatcher role thread_id"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const dispatcherId = params.dispatcher?.trim();
    if (!dispatcherId) {
      return { ok: false, error: "Missing required parameter: dispatcher" };
    }

    try {
      const response = await postRolesServiceJson<unknown>(
        `/api/agent-dispatcher/${encodeURIComponent(dispatcherId)}/resume`,
        {}
      );

      if (!response.ok) {
        return { ok: false, error: response.error, data: buildServiceErrorData(response) };
      }

      return { ok: true, data: response.body as Record<string, unknown> };
    } catch (error) {
      return { ok: false, error: asError(error).message };
    }
  }
};

export default resumeDispatcherTool;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
