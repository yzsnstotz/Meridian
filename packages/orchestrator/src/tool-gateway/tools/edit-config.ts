import {
  buildServiceErrorData,
  patchRolesServiceJson,
  requestRolesServiceJson,
  type JsonRequestResult
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

export interface EditConfigDeps {
  getConfig(pathname: string): Promise<JsonRequestResult<ToolResult>>;
  patchConfig(pathname: string, body: unknown): Promise<JsonRequestResult<ToolResult>>;
}

const defaultDeps: EditConfigDeps = {
  getConfig: (pathname) => requestRolesServiceJson<ToolResult>(pathname),
  patchConfig: (pathname, body) => patchRolesServiceJson<ToolResult>(pathname, body)
};

const editConfigTool: ToolDefinition = {
  name: "edit-config",
  description: "View or patch agent-dispatcher config. Without patch fields, returns current config. With patch fields, applies changes.",
  params: {
    dispatcher: {
      type: "string",
      required: true,
      description: "Agent-dispatcher role thread_id"
    },
    agent_type: {
      type: "string",
      required: false,
      description: "Set agent_type (claude, codex, gemini, cursor)"
    },
    model_id: {
      type: "string",
      required: false,
      description: "Set model_id (use empty string to clear)"
    },
    mode: {
      type: "string",
      required: false,
      description: "Set mode (bridge)"
    },
    kill_policy: {
      type: "string",
      required: false,
      description: "Set kill_policy (always, on_success, never)"
    },
    auto_approve: {
      type: "string",
      required: false,
      description: "Set auto_approve (true, false)"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const dispatcherId = params.dispatcher?.trim();
    if (!dispatcherId) {
      return { ok: false, error: "Missing required parameter: dispatcher" };
    }

    return executeEditConfig({ dispatcherId, params });
  }
};

export default editConfigTool;

export async function executeEditConfig(
  args: { dispatcherId: string; params: Record<string, string> },
  deps: EditConfigDeps = defaultDeps
): Promise<ToolResult> {
  const pathname = `/api/role/${encodeURIComponent(args.dispatcherId)}/config`;
  const patch = buildPatch(args.params);

  if (patch === null) {
    // Read-only: return current config
    const response = await deps.getConfig(pathname);
    if (response.ok) {
      return response.body;
    }
    return { ok: false, error: response.error, data: buildServiceErrorData(response) };
  }

  const response = await deps.patchConfig(pathname, patch);
  if (response.ok) {
    return response.body;
  }
  return { ok: false, error: response.error, data: buildServiceErrorData(response) };
}

function buildPatch(params: Record<string, string>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  if (params.agent_type?.trim()) patch.agent_type = params.agent_type.trim();
  if (params.mode?.trim()) patch.mode = params.mode.trim();
  if (params.kill_policy?.trim()) patch.kill_policy = params.kill_policy.trim();
  if (params.auto_approve?.trim()) patch.auto_approve = params.auto_approve.trim() === "true";
  if (params.model_id !== undefined) {
    const trimmed = params.model_id.trim();
    patch.model_id = trimmed.length > 0 ? trimmed : null;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
