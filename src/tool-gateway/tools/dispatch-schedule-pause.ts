import {
  buildServiceErrorData,
  postRolesServiceJson
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const dispatchSchedulePauseTool: ToolDefinition = {
  name: "dispatch-schedule-pause",
  description: "Pause scheduler and active dispatcher (prevents future cycle starts)",
  params: {
    scheduler: {
      type: "string",
      required: true,
      description: "Scheduler role thread ID"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const schedulerId = params.scheduler?.trim();
    if (!schedulerId) {
      return { ok: false, error: "Missing required parameter: scheduler" };
    }

    try {
      const response = await postRolesServiceJson<unknown>(
        `/api/scheduler/${encodeURIComponent(schedulerId)}/pause`,
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

export default dispatchSchedulePauseTool;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
