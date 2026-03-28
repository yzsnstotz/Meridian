import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import notifyTool from "../notify";

const tempDirectories = new Set<string>();
const servers = new Set<net.Server>();
const originalHubSocketPath = process.env.HUB_SOCKET_PATH;
const originalReplyChannel = process.env.MERIDIAN_REPLY_CHANNEL;
const originalReplyChannels = process.env.MERIDIAN_REPLY_CHANNELS;

afterEach(async () => {
  if (originalHubSocketPath === undefined) {
    delete process.env.HUB_SOCKET_PATH;
  } else {
    process.env.HUB_SOCKET_PATH = originalHubSocketPath;
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
    Array.from(servers, (server) =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }).catch(() => undefined)
    )
  );
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));

  servers.clear();
  tempDirectories.clear();
});

describe("notify tool", () => {
  it("sends intent:reply to the configured reply channel", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const receivedMessages = waitForHubMessages(hubSocketPath, 1);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
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
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const receivedMessages = waitForHubMessages(hubSocketPath, 2);
    process.env.HUB_SOCKET_PATH = hubSocketPath;

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
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const receivedMessages = waitForHubMessages(hubSocketPath, 1);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
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
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-notify-");
  tempDirectories.add(directory);
  return directory;
}

function waitForHubMessages(socketPath: string, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let raw = "";

      socket.on("data", (chunk: string) => {
        raw += chunk;
      });

      socket.once("end", () => {
        try {
          messages.push(JSON.parse(raw) as Record<string, unknown>);
          if (messages.length === count) {
            resolve(messages);
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    servers.add(server);
    server.once("error", reject);
    server.listen(socketPath);
  });
}
