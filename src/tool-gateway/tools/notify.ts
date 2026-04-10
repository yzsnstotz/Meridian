import { randomUUID } from "node:crypto";
import net from "node:net";

import { HUB_SOCKET_PATH } from "../../config";
import { HubResultSchema, ReplyChannelSchema, type HubMessage, type HubResult, type ReplyChannel } from "../../types";
import { sendViaFileRelay } from "../file-relay";
import { sendViaHttpRelay } from "../ipc-bridge";
import type { ToolDefinition, ToolResult } from "../registry";

const MERIDIAN_TOOL_ACTOR_ID = "service:meridian-tool";
const MERIDIAN_REPLY_CHANNEL_ENV = "MERIDIAN_REPLY_CHANNEL";
const MERIDIAN_REPLY_CHANNELS_ENV = "MERIDIAN_REPLY_CHANNELS";
const NOTIFY_THREAD_ID = "notify";
const NOTIFY_CONNECT_TIMEOUT_MS = 10_000;

const notifyTool: ToolDefinition = {
  name: "notify",
  description: "Send a notification to the configured Meridian reply channel or channels",
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
    },
    reply_channels: {
      type: "string",
      required: false,
      description: "Optional JSON array override for Meridian reply channels"
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
      const replyChannels = resolveReplyChannels(params);
      const results = await Promise.all(
        replyChannels.map((replyChannel) =>
          sendNotifyWithFallback(buildNotifyMessage(message, params.urgency, replyChannel))
        )
      );
      const failedResult = results.find((result) => result.status !== "success");
      if (failedResult) {
        return {
          ok: false,
          error: failedResult.content,
          data: {
            status: failedResult.status,
            thread_id: failedResult.thread_id,
            trace_id: failedResult.trace_id
          }
        };
      }

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

function resolveReplyChannels(params: Record<string, string>): ReplyChannel[] {
  const explicitReplyChannels = requireParam(params.reply_channels);
  if (explicitReplyChannels) {
    return parseReplyChannels(explicitReplyChannels);
  }

  const explicitReplyChannel = requireParam(params.reply_channel);
  if (explicitReplyChannel) {
    return [parseReplyChannel(explicitReplyChannel)];
  }

  const envReplyChannels = requireParam(process.env[MERIDIAN_REPLY_CHANNELS_ENV]);
  if (envReplyChannels) {
    return parseReplyChannels(envReplyChannels);
  }

  const envReplyChannel = requireParam(process.env[MERIDIAN_REPLY_CHANNEL_ENV]);
  if (envReplyChannel) {
    return [parseReplyChannel(envReplyChannel)];
  }

  throw new Error(
    "Missing reply channel: pass --reply-channels/--reply-channel or set MERIDIAN_REPLY_CHANNELS/MERIDIAN_REPLY_CHANNEL"
  );
}

function parseReplyChannels(rawValue: string): ReplyChannel[] {
  const parsed = JSON.parse(rawValue) as unknown;
  const replyChannels = ReplyChannelSchema.array().min(1).parse(parsed);
  return replyChannels.map((replyChannel) => ({ ...replyChannel }));
}

function parseReplyChannel(rawValue: string): ReplyChannel {
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

async function sendNotifyWithFallback(message: HubMessage): Promise<HubResult> {
  try {
    return await sendNotifyAndWait(message);
  } catch (error) {
    const code = "code" in (error as NodeJS.ErrnoException) ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") {
      throw error;
    }

    console.warn("Notify socket connect failed; falling back to HTTP relay", {
      trace_id: message.trace_id,
      error: asError(error).message
    });

    try {
      return await sendViaHttpRelay(message, NOTIFY_CONNECT_TIMEOUT_MS);
    } catch (httpError) {
      console.warn("Notify HTTP relay also failed; falling back to file relay", {
        trace_id: message.trace_id,
        error: asError(httpError).message
      });

      return sendViaFileRelay(message, NOTIFY_CONNECT_TIMEOUT_MS);
    }
  }
}

function sendNotifyAndWait(message: HubMessage): Promise<HubResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rawResponse = "";
    const socket = net.createConnection(getHubSocketPath());
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(new Error(`Notify request timed out after ${NOTIFY_CONNECT_TIMEOUT_MS}ms`));
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

    const resolveResponse = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (!rawResponse.trim()) {
        reject(new Error("Notify request completed without Hub response body"));
        return;
      }

      try {
        const result = HubResultSchema.parse(JSON.parse(rawResponse));
        if (result.trace_id !== message.trace_id) {
          reject(new Error(`Notify Hub response trace_id mismatch: expected ${message.trace_id}, received ${result.trace_id}`));
          return;
        }

        resolve(result);
      } catch (error) {
        reject(new Error(`Invalid notify Hub response: ${asError(error).message}`));
      }
    };

    socket.setEncoding("utf8");

    socket.once("connect", () => {
      if (settled) {
        return;
      }

      clearTimeout(timeout);

      try {
        socket.end(JSON.stringify(message));
      } catch (error) {
        fail(error);
      }
    });

    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });

    socket.once("end", resolveResponse);
    socket.once("close", resolveResponse);
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
