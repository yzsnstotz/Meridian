import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import notifyTool from "../notify";

const httpServers = new Set<http.Server>();
const originalHubRelayUrl = process.env.MERIDIAN_HUB_RELAY_URL;
const originalReplyChannel = process.env.MERIDIAN_REPLY_CHANNEL;
const originalReplyChannels = process.env.MERIDIAN_REPLY_CHANNELS;

afterEach(async () => {
  if (originalHubRelayUrl === undefined) {
    delete process.env.MERIDIAN_HUB_RELAY_URL;
  } else {
    process.env.MERIDIAN_HUB_RELAY_URL = originalHubRelayUrl;
  }

  if (originalReplyChannel === undefined) {
    delete process.env.MERIDIAN_REPLY_CHANNEL;
  } else {
    process.env.MERIDIAN_REPLY_CHANNEL = originalReplyChannel;
  }

  if (originalReplyChannels === undefined) {
    delete process.env.MERIDIAN_REPLY_CHANNELS;
  } else {
    process.env.MERIDIAN_REPLY_CHANNELS = originalReplyChannels;
  }

  await Promise.all(
    Array.from(httpServers, (server) =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }).catch(() => undefined)
    )
  );

  httpServers.clear();
});

describe("notify tool", () => {
  it("sends intent:reply to the configured reply channel", async () => {
    const { port, receivedMessages } = await startHubRelayServer(1);
    process.env.MERIDIAN_HUB_RELAY_URL = `http://127.0.0.1:${port}/api/hub-relay`;
    process.env.MERIDIAN_REPLY_CHANNEL = JSON.stringify({
      channel: "telegram",
      chat_id: "telegram:dispatch-room"
    });

    const result = await notifyTool.execute({
      message: "[Dispatcher] queued",
      urgency: "high"
    });

    expect(result).toEqual({ ok: true });
    await expect(receivedMessages).resolves.toEqual([
      expect.objectContaining({
        thread_id: "notify",
        actor_id: "service:meridian-tool",
        intent: "reply",
        target: "global",
        priority: 7,
        payload: {
          content: "[Dispatcher] queued",
          attachments: []
        },
        reply_channel: {
          channel: "telegram",
          chat_id: "telegram:dispatch-room"
        },
        suppress_reply: false
      })
    ]);
  });

  it("fans out to every explicit reply channel override", async () => {
    const { port, receivedMessages } = await startHubRelayServer(2);
    process.env.MERIDIAN_HUB_RELAY_URL = `http://127.0.0.1:${port}/api/hub-relay`;

    const result = await notifyTool.execute({
      message: "override",
      reply_channels: JSON.stringify([
        {
          channel: "telegram",
          chat_id: "telegram:ops"
        },
        {
          channel: "web",
          chat_id: "service:ops-dashboard"
        }
      ])
    });

    expect(result).toEqual({ ok: true });
    await expect(receivedMessages).resolves.toEqual([
      expect.objectContaining({
        reply_channel: {
          channel: "telegram",
          chat_id: "telegram:ops"
        }
      }),
      expect.objectContaining({
        reply_channel: {
          channel: "web",
          chat_id: "service:ops-dashboard"
        }
      })
    ]);
  });

  it("prefers the explicit reply_channel parameter over the environment", async () => {
    const { port, receivedMessages } = await startHubRelayServer(1);
    process.env.MERIDIAN_HUB_RELAY_URL = `http://127.0.0.1:${port}/api/hub-relay`;
    process.env.MERIDIAN_REPLY_CHANNEL = JSON.stringify({
      channel: "web",
      chat_id: "service:meridian-roles"
    });

    const result = await notifyTool.execute({
      message: "override",
      reply_channel: JSON.stringify({
        channel: "telegram",
        chat_id: "telegram:ops"
      })
    });

    expect(result).toEqual({ ok: true });
    await expect(receivedMessages).resolves.toEqual([
      expect.objectContaining({
        reply_channel: {
          channel: "telegram",
          chat_id: "telegram:ops"
        }
      })
    ]);
  });

  it("returns ok:false when Hub rejects the reply intent", async () => {
    const { port, receivedMessages } = await startHubRelayServer(1, {
      status: "error",
      content: "Unsupported intent"
    });
    process.env.MERIDIAN_HUB_RELAY_URL = `http://127.0.0.1:${port}/api/hub-relay`;
    process.env.MERIDIAN_REPLY_CHANNEL = JSON.stringify({
      channel: "web",
      chat_id: "web:ops"
    });

    const result = await notifyTool.execute({
      message: "[Dispatcher] queued"
    });

    expect(result).toEqual({
      ok: false,
      error: "Unsupported intent",
      data: {
        status: "error",
        thread_id: "notify",
        trace_id: expect.any(String)
      }
    });
    await expect(receivedMessages).resolves.toEqual([
      expect.objectContaining({
        intent: "reply",
        reply_channel: {
          channel: "web",
          chat_id: "web:ops"
        }
      })
    ]);
  });
});

function startHubRelayServer(
  expectedCount: number,
  response: { status?: "success" | "error"; content?: string } = {}
): Promise<{ port: number; receivedMessages: Promise<Record<string, unknown>[]> }> {
  return new Promise((resolveStart, rejectStart) => {
    const messages: Record<string, unknown>[] = [];
    let resolveMessages: (messages: Record<string, unknown>[]) => void;
    const receivedMessages = new Promise<Record<string, unknown>[]>((resolve) => {
      resolveMessages = resolve;
    });

    const server = http.createServer((request, res) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const message = JSON.parse(body) as Record<string, unknown>;
          messages.push(message);
          const hubResult = buildHubResult(message, response);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(hubResult));
          if (messages.length === expectedCount) {
            resolveMessages(messages);
          }
        } catch (error) {
          res.writeHead(400);
          res.end(String(error));
        }
      });
    });

    httpServers.add(server);
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveStart({ port, receivedMessages });
    });
  });
}

function buildHubResult(
  message: Record<string, unknown>,
  response: { status?: "success" | "error"; content?: string }
): Record<string, unknown> {
  const payload = message.payload as { content?: unknown } | undefined;
  return {
    trace_id: message.trace_id,
    thread_id: message.thread_id,
    source: "codex",
    status: response.status ?? "success",
    content: response.content ?? (typeof payload?.content === "string" ? payload.content : ""),
    attachments: [],
    timestamp: "2026-04-07T00:00:00.000Z"
  };
}
