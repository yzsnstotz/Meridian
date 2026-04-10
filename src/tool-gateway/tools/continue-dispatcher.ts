import {
  buildServiceErrorData,
  postRolesServiceJson
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const continueDispatcherTool: ToolDefinition = {
  name: "continue-dispatcher",
  description: "Ask Meridian-roles service to select and launch the next eligible agent-dispatcher worker",
  params: {
    dispatcher: {
      type: "string",
      required: true,
      description: "Agent-dispatcher role thread_id"
    },
    worker: {
      type: "string",
      required: false,
      description: "Optional explicit worker id to continue instead of service-owned next-worker selection"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const dispatcherId = requireParam(params.dispatcher);
    if (!dispatcherId) {
      return {
        ok: false,
        error: "Missing required parameter: dispatcher"
      };
    }

    const workerId = requireParam(params.worker);
    const pathname = workerId
      ? `/api/roles/${encodeURIComponent(dispatcherId)}/worker/${encodeURIComponent(workerId)}/continue`
      : `/api/agent-dispatcher/${encodeURIComponent(dispatcherId)}/continue`;

    const response = await postRolesServiceJson<ToolResult>(pathname, {});
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        data: buildServiceErrorData(response)
      };
    }

    return response.body;
  }
};

export default continueDispatcherTool;

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
