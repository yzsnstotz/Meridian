import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HubMessage, HubResult } from "../../types";
import { sendAndWait } from "../ipc-bridge";

interface TestHubServer {
  messages: Record<string, unknown>[];
  callbackSocketPaths: string[];
  close(): Promise<void>;
}

const tempDirectories = new Set<string>();
const servers = new Set<TestHubServer>();
const originalHubSocketPath = process.env.HUB_SOCKET_PATH;

afterEach(async () => {
  vi.restoreAllMocks();

  if (originalHubSocketPath === undefined) {
    delete process.env.HUB_SOCKET_PATH;
  } else {
    process.env.HUB_SOCKET_PATH = originalHubSocketPath;
  }

  await Promise.all(Array.from(servers, (server) => server.close().catch(() => undefined)));
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));

  servers.clear();
  tempDirectories.clear();
});

describe("sendAndWait", () => {
  it("sends a Hub message through a temp reply socket and returns the matching callback", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, { callbackMode: "success" });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;

    const message = buildHubMessage();
    const result = await sendAndWait(message, 200);

    expect(result).toMatchObject({
      trace_id: message.trace_id,
      thread_id: message.thread_id,
      status: "success",
      content: "ok"
    });
    expect(hub.messages).toHaveLength(1);
    expect(hub.messages[0]).toMatchObject({
      trace_id: message.trace_id,
      reply_channel: {
        channel: "socket"
      }
    });

    const callbackSocketPath = hub.callbackSocketPaths[0];
    expect(callbackSocketPath).toMatch(/^\/tmp\/meridian-tool-[0-9a-f-]+\.sock$/);
    await expect(fs.access(callbackSocketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out when the hub does not callback and removes the temp socket", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, { callbackMode: "none" });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;

    const message = buildHubMessage();

    await expect(sendAndWait(message, 50)).rejects.toThrow("Hub timeout after 50ms");
    const callbackSocketPath = hub.callbackSocketPaths[0];
    expect(callbackSocketPath).toBeDefined();
    await expect(fs.access(callbackSocketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up the temp socket when interrupted by SIGINT", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, { callbackMode: "none" });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;

    const message = buildHubMessage();
    const pending = sendAndWait(message, 0);

    await vi.waitFor(() => {
      expect(hub.messages).toHaveLength(1);
    });

    process.emit("SIGINT");

    await expect(pending).rejects.toThrow("Tool Gateway interrupted by SIGINT");
    const callbackSocketPath = hub.callbackSocketPaths[0];
    expect(callbackSocketPath).toBeDefined();
    await expect(fs.access(callbackSocketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-ipc-bridge-");
  tempDirectories.add(directory);
  return directory;
}

async function startHubServer(
  socketPath: string,
  options: {
    callbackMode: "success" | "none";
  }
): Promise<TestHubServer> {
  const messages: Record<string, unknown>[] = [];
  const callbackSocketPaths: string[] = [];
  let closed = false;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let raw = "";

    socket.on("data", (chunk: string) => {
      raw += chunk;
    });

    socket.once("end", () => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      messages.push(message);

      const replyChannel = message.reply_channel as { socket_path?: string } | undefined;
      if (replyChannel?.socket_path) {
        callbackSocketPaths.push(replyChannel.socket_path);
      }

      if (options.callbackMode === "success" && replyChannel?.socket_path) {
        const response: HubResult = {
          trace_id: typeof message.trace_id === "string" ? message.trace_id : randomUUID(),
          thread_id: typeof message.thread_id === "string" ? message.thread_id : "dispatcher-1",
          source: "codex",
          status: "success",
          content: "ok",
          attachments: [],
          timestamp: new Date().toISOString()
        };

        void sendCallback(replyChannel.socket_path, response);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    messages,
    callbackSocketPaths,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.unlink(socketPath).catch(() => undefined);
    }
  };
}

function sendCallback(socketPath: string, response: HubResult): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.end(JSON.stringify(response));
    });

    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

function buildHubMessage(overrides: Partial<HubMessage> = {}): Partial<HubMessage> {
  return {
    trace_id: randomUUID(),
    thread_id: "dispatcher-1",
    actor_id: "service:meridian-roles",
    intent: "run",
    target: "codex_01",
    priority: 5,
    mode: "bridge",
    payload: {
      content: "Run the worker",
      attachments: []
    },
    reply_channel: {
      channel: "web",
      chat_id: "service:meridian-roles"
    },
    ...overrides
  };
}
