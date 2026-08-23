import {
  buildServiceErrorData,
  postRolesServiceJson,
  type JsonRequestResult
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

export interface ContinueDispatcherDeps {
  postContinue(pathname: string): Promise<JsonRequestResult<ToolResult>>;
}

const defaultDeps: ContinueDispatcherDeps = {
  postContinue: (pathname) => postRolesServiceJson<ToolResult>(pathname, {})
};

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

    return executeContinueDispatcher({
      dispatcherId,
      workerId: requireParam(params.worker)
    });
  }
};

export default continueDispatcherTool;

export async function executeContinueDispatcher(
  args: {
    dispatcherId: string;
    workerId?: string | null;
  },
  deps: ContinueDispatcherDeps = defaultDeps
): Promise<ToolResult> {
  const pathname = args.workerId
    ? `/api/roles/${encodeURIComponent(args.dispatcherId)}/worker/${encodeURIComponent(args.workerId)}/continue`
    : `/api/agent-dispatcher/${encodeURIComponent(args.dispatcherId)}/continue`;

  const response = await deps.postContinue(pathname);
  if (response.ok) {
    return response.body;
  }

  return {
    ok: false,
    error: response.error,
    data: buildServiceErrorData(response)
  };
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
