import { createMeridianApiClient, MeridianApiError } from "../../roles/agent-dispatcher/meridian-api-client";
import type { BridgeMode } from "../../types";
import type { ToolDefinition, ToolResult } from "../registry";

const SPAWN_TIMEOUT_ERROR = "Hub timeout after 60s";

const spawnTool: ToolDefinition = {
  name: "spawn",
  description: "Spawn a coding agent thread through Meridian HTTP API",
  params: {
    agent_type: {
      type: "string",
      required: true,
      description: "Coding agent type to spawn"
    },
    mode: {
      type: "string",
      required: false,
      description: "Bridge mode to use for the spawned agent"
    },
    model_id: {
      type: "string",
      required: false,
      description: "Explicit provider model id to use for the spawned agent"
    },
    spawn_dir: {
      type: "string",
      required: false,
      description: "Working directory for the spawned agent"
    },
    auto_approve: {
      type: "string",
      required: false,
      description: "Whether Meridian should enable auto-approve for the spawned agent"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const agentType = params.agent_type?.trim();
    if (!agentType) {
      return {
        ok: false,
        error: "Missing required parameter: agent_type"
      };
    }

    const mode = parseBridgeMode(params.mode);
    const rawModelId = readOptionalString(params.model_id);
    const { modelId, effort } = parseModelIdWithEffort(rawModelId);
    const spawnDir = readOptionalString(params.spawn_dir) ?? process.cwd();
    const autoApprove = parseOptionalBoolean(params.auto_approve);

    try {
      const client = createMeridianApiClient();
      const result = await client.spawn({
        agentType,
        mode,
        spawnDir,
        modelId,
        effort,
        autoApprove
      });

      return {
        ok: true,
        data: {
          thread_id: result.threadId,
          agent_type: agentType,
          mode,
          model_id: modelId
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: toToolError(error)
      };
    }
  }
};

export default spawnTool;

const KNOWN_EFFORT_SUFFIXES = new Set(["low", "medium", "high", "xhigh"]);

export function parseModelIdWithEffort(rawModelId: string | undefined): {
  modelId?: string;
  effort?: string;
} {
  if (!rawModelId) {
    return {};
  }

  const lastSpaceIndex = rawModelId.lastIndexOf(" ");
  if (lastSpaceIndex === -1) {
    return { modelId: rawModelId };
  }

  const candidateEffort = rawModelId.slice(lastSpaceIndex + 1).toLowerCase();
  if (KNOWN_EFFORT_SUFFIXES.has(candidateEffort)) {
    const baseModelId = rawModelId.slice(0, lastSpaceIndex).trim();
    return {
      modelId: baseModelId.length > 0 ? baseModelId : rawModelId,
      effort: candidateEffort
    };
  }

  return { modelId: rawModelId };
}

function parseBridgeMode(mode: string | undefined): BridgeMode {
  return mode?.trim() === "bridge" ? "bridge" : "pane_bridge";
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function toToolError(error: unknown): string {
  const message = asError(error).message;
  if (message.includes("timed out") || message.includes("timeout")) {
    return SPAWN_TIMEOUT_ERROR;
  }

  return message;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
