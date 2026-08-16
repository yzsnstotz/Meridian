import {
  buildServiceErrorData,
  postRolesServiceJson,
  type JsonRequestResult
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

export interface PmResolveDeps {
  postPmResolve(pathname: string, body: Record<string, unknown>): Promise<JsonRequestResult<ToolResult>>;
}

const defaultDeps: PmResolveDeps = {
  postPmResolve: (pathname, body) => postRolesServiceJson<ToolResult>(pathname, body)
};

const pmResolveTool: ToolDefinition = {
  name: "pm-resolve",
  description: "Start the configured PM resolver for an abnormal dispatcher orchestration state",
  params: {
    dispatcher: {
      type: "string",
      required: true,
      description: "Agent-dispatcher role thread_id"
    },
    status: {
      type: "string",
      required: true,
      description: "Abnormal status or condition to resolve"
    },
    worker: {
      type: "string",
      required: false,
      description: "Worker id related to the issue"
    },
    message: {
      type: "string",
      required: false,
      description: "Short issue summary"
    },
    error: {
      type: "string",
      required: false,
      description: "Detailed error text"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const dispatcherId = requireParam(params.dispatcher);
    const status = requireParam(params.status);
    if (!dispatcherId) {
      return {
        ok: false,
        error: "Missing required parameter: dispatcher"
      };
    }
    if (!status) {
      return {
        ok: false,
        error: "Missing required parameter: status"
      };
    }

    return executePmResolve({
      dispatcherId,
      status,
      workerId: requireParam(params.worker),
      message: requireParam(params.message),
      error: requireParam(params.error)
    });
  }
};

export default pmResolveTool;

export async function executePmResolve(
  args: {
    dispatcherId: string;
    status: string;
    workerId?: string | null;
    message?: string | null;
    error?: string | null;
  },
  deps: PmResolveDeps = defaultDeps
): Promise<ToolResult> {
  const response = await deps.postPmResolve(
    `/api/agent-dispatcher/${encodeURIComponent(args.dispatcherId)}/pm-resolve`,
    {
      status: args.status,
      worker_id: args.workerId ?? undefined,
      message: args.message ?? undefined,
      error: args.error ?? undefined
    }
  );
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
