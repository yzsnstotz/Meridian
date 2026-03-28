import { randomUUID } from "node:crypto";
import net from "node:net";

import { HUB_SOCKET_PATH } from "../../config";
import { ReplyChannelSchema, type HubMessage, type ReplyChannel } from "../../types";
import type { ToolDefinition, ToolResult } from "../registry";

const MERIDIAN_TOOL_ACTOR_ID = "service:meridian-tool";
const NOTIFY_THREAD_ID = "notify";
const NOTIFY_CONNECT_TIMEOUT_MS = 10_000;

const notifyTool: ToolDefinition = {
  name: "notify",
  description: "Send a notification to the configured Meridian reply channel",
  params: {
    message: {
      type: "string",
      required: true,
      description: "Notification body to send through Meridian Hub"
    },
    urgency: {
      type: "string",
      required: false,
      description: "Optional urgency hint: low, normal, or high"
    },
    reply_channel: {
      type: "string",
      required: false,
      description: "Optional JSON override for the Meridian reply channel"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const message = requireParam(params.message);
    if (!message) {
      return {
        ok: false,
        error: "Missing required parameter: message"
      };
    }

    try {
      const replyChannel = parseReplyChannel(params.reply_channel ?? process.env.MERIDIAN_REPLY_CHANNEL);
      await sendFireAndForget(buildNotifyMessage(message, params.urgency, replyChannel));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: asError(error).message
      };
    }
  }
};

export default notifyTool;

function buildNotifyMessage(message: string, urgency: string | undefined, replyChannel: ReplyChannel): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: NOTIFY_THREAD_ID,
    actor_id: MERIDIAN_TOOL_ACTOR_ID,
    intent: "reply",
    target: "global",
    priority: toPriority(urgency),
    payload: {
      content: message,
      attachments: []
    },
    mode: "bridge",
    reply_channel: replyChannel,
    suppress_reply: false
  };
}

function parseReplyChannel(rawValue: string | undefined): ReplyChannel {
  if (!rawValue || rawValue.trim().length === 0) {
    throw new Error("Missing reply channel: pass --reply-channel or set MERIDIAN_REPLY_CHANNEL");
  }

  const parsed = JSON.parse(rawValue) as unknown;
  return ReplyChannelSchema.parse(parsed);
}

function toPriority(urgency: string | undefined): number {
  switch (urgency?.trim().toLowerCase()) {
    case "high":
      return 7;
    case "low":
      return 3;
    default:
      return 5;
  }
}

function getHubSocketPath(): string {
  return process.env.HUB_SOCKET_PATH ?? HUB_SOCKET_PATH;
}

function sendFireAndForget(message: HubMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(getHubSocketPath());
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy(new Error(`Notify connect timed out after ${NOTIFY_CONNECT_TIMEOUT_MS}ms`));
    }, NOTIFY_CONNECT_TIMEOUT_MS);

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(asError(error));
    };

    socket.once("connect", () => {
      if (settled) {
        return;
      }

      clearTimeout(timeout);

      try {
        socket.end(JSON.stringify(message));
        settled = true;
        resolve();
      } catch (error) {
        fail(error);
      }
    });

    socket.once("error", fail);
  });
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
