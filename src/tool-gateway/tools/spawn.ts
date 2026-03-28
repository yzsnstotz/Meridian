import type { BridgeMode, HubMessage } from "../../types";
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

    try {
      const result = await sendAndWait(buildSpawnMessage(agentType, mode), SPAWN_TIMEOUT_MS);
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
          mode
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

function buildSpawnMessage(agentType: string, mode: BridgeMode): Partial<HubMessage> {
  return {
    thread_id: SPAWN_THREAD_ID,
    actor_id: MERIDIAN_TOOL_ACTOR_ID,
    priority: 5,
    intent: "spawn",
    target: agentType,
    mode,
    payload: {
      content: "",
      attachments: []
    }
  };
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

function parseBridgeMode(mode: string | undefined): BridgeMode {
  return mode?.trim() === "pane_bridge" ? "pane_bridge" : "bridge";
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
