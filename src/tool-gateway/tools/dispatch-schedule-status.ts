import {
  buildServiceErrorData,
  requestRolesServiceJson
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const dispatchScheduleStatusTool: ToolDefinition = {
  name: "dispatch-schedule-status",
  description: "Query scheduler status, next run time, last outcome, and run history",
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
      const response = await requestRolesServiceJson<unknown>(
        `/api/scheduler/${encodeURIComponent(schedulerId)}`
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

export default dispatchScheduleStatusTool;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
