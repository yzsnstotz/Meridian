import type { BridgeMode, HubMessage, HubResult } from "../../types";
import { sendAndWait } from "../ipc-bridge";
import type { ToolDefinition, ToolResult } from "../registry";

const DEFAULT_MODE = "bridge";
const SPAWN_THREAD_ID = "spawn";
const SPAWN_TIMEOUT_MS = 60_000;
const SPAWN_TIMEOUT_ERROR = "Hub timeout after 60s";
const SPAWN_PARSE_ERROR = "Failed to parse spawn response";
const MERIDIAN_TOOL_ACTOR_ID = "service:meridian-tool";

const spawnTool: ToolDefinition = {
  name: "spawn",
  description: "Spawn a coding agent thread through Meridian Hub",
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
      const result = await sendAndWait(buildSpawnMessage({
        agentType,
        mode,
        modelId,
        effort,
        spawnDir,
        autoApprove
      }), SPAWN_TIMEOUT_MS);
      const transportError = readSpawnTransportError(result);
      if (transportError) {
        return {
          ok: false,
          error: transportError
        };
      }

      const threadId = parseThreadId(result.content);
      if (!threadId) {
        return {
          ok: false,
          error: SPAWN_PARSE_ERROR
        };
      }

      return {
        ok: true,
        data: {
          thread_id: threadId,
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

function buildSpawnMessage(args: {
  agentType: string;
  mode: BridgeMode;
  modelId?: string;
  effort?: string;
  spawnDir: string;
  autoApprove?: boolean;
}): Partial<HubMessage> {
  return {
    thread_id: SPAWN_THREAD_ID,
    actor_id: MERIDIAN_TOOL_ACTOR_ID,
    priority: 5,
    intent: "spawn",
    target: args.agentType,
    mode: args.mode,
    payload: {
      spawn_dir: args.spawnDir,
      model_id: args.modelId,
      effort: args.effort,
      auto_approve: args.autoApprove,
      content: "",
      attachments: []
    }
  };
}

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

function parseThreadId(content: string): string | null {
  const match = content.match(/\{[\s\S]*\}/)?.[0];
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match) as { thread_id?: unknown };
    return typeof parsed.thread_id === "string" && parsed.thread_id.trim().length > 0 ? parsed.thread_id : null;
  } catch {
    return null;
  }
}

function readSpawnTransportError(result: HubResult): string | null {
  if (result.status === "success") {
    return null;
  }

  const details = [
    result.summary_text,
    result.details_text,
    result.content
  ]
    .map((value) => value?.trim())
    .find((value) => Boolean(value));

  if (details) {
    return details;
  }

  return `Hub spawn failed with status: ${result.status}`;
}

function parseBridgeMode(mode: string | undefined): BridgeMode {
  return mode?.trim() === "pane_bridge" ? "pane_bridge" : "bridge";
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
  if (message === `Hub timeout after ${SPAWN_TIMEOUT_MS}ms`) {
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
