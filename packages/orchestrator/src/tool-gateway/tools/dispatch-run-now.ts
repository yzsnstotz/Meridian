import {
  buildServiceErrorData,
  postRolesServiceJson
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const dispatchRunNowTool: ToolDefinition = {
  name: "dispatch-run-now",
  description: "Trigger an immediate scheduler cycle regardless of schedule timing",
  params: {
    scheduler: {
      type: "string",
      required: true,
      description: "Scheduler role thread ID"
    },
    report_dir: {
      type: "string",
      required: false,
      description: "Optional report directory override for this run only"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const schedulerId = params.scheduler?.trim();
    if (!schedulerId) {
      return { ok: false, error: "Missing required parameter: scheduler" };
    }

    try {
      const body: Record<string, unknown> = {};
      if (params.report_dir?.trim()) {
        body.report_base_dir = params.report_dir.trim();
      }

      const response = await postRolesServiceJson<unknown>(
        `/api/scheduler/${encodeURIComponent(schedulerId)}/run-now`,
        body
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

export default dispatchRunNowTool;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
