import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
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
const originalCwd = process.cwd();
const TOOL_GATEWAY_REPO_ROOT = path.resolve(__dirname, "../../..");
const REPO_LOCAL_SOCKET_DIR = path.join(TOOL_GATEWAY_REPO_ROOT, ".tmp");

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);

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
    expect(path.isAbsolute(callbackSocketPath)).toBe(true);
    expect(path.basename(callbackSocketPath)).toMatch(/^meridian-tool-[0-9a-f-]+\.sock$/);
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

  it("logs an error when the hub callback trace_id does not match before receiving the correct reply", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, { callbackMode: "mismatch_then_success" });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const message = buildHubMessage();
    const result = await sendAndWait(message, 200);

    expect(result.trace_id).toBe(message.trace_id);
    expect(errorSpy).toHaveBeenCalledWith(
      "Hub callback trace_id mismatch",
      expect.objectContaining({
        expected_trace_id: message.trace_id,
        received_trace_id: expect.any(String)
      })
    );
  });

  it("logs a warning when the hub callback body is empty", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, { callbackMode: "empty" });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const message = buildHubMessage();

    await expect(sendAndWait(message, 50)).rejects.toThrow("Hub callback completed without a response body");
    expect(warnSpy).toHaveBeenCalledWith(
      "Hub callback completed without a response body",
      expect.objectContaining({
        expected_trace_id: message.trace_id
      })
    );
  });

  it("logs a warning when the hub callback body cannot be parsed", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, { callbackMode: "invalid_json" });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const message = buildHubMessage();

    await expect(sendAndWait(message, 50)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      "Hub callback body could not be parsed",
      expect.objectContaining({
        expected_trace_id: message.trace_id,
        error: expect.any(String)
      })
    );
  });

  it("falls back to a repo-local socket directory when the system temp bind is denied", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, { callbackMode: "success" });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
    process.chdir(directory);

    const originalCreateServer = net.createServer;
    let blockedTmpBind = false;
    vi.spyOn(net, "createServer").mockImplementation(((...args: Parameters<typeof net.createServer>) => {
      const server = originalCreateServer(...args);
      const originalListen = server.listen.bind(server);

      const listenMock = (...listenArgs: Parameters<net.Server["listen"]>) => {
        const candidatePath = readSocketPath(listenArgs[0]);
        if (!blockedTmpBind && candidatePath?.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
          blockedTmpBind = true;
          const error = Object.assign(
            new Error(`listen EPERM: operation not permitted ${candidatePath}`),
            { code: "EPERM" }
          );
          queueMicrotask(() => {
            server.emit("error", error);
          });
          return server;
        }

        return originalListen(...listenArgs);
      };
      server.listen = listenMock as typeof server.listen;

      return server;
    }) as typeof net.createServer);

    const result = await sendAndWait(buildHubMessage(), 200);

    expect(result.status).toBe("success");
    expect(blockedTmpBind).toBe(true);
    expect(hub.callbackSocketPaths[0]?.startsWith(`${REPO_LOCAL_SOCKET_DIR}${path.sep}`)).toBe(true);
    await expect(fs.access(hub.callbackSocketPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to inline Hub responses when callback socket binds are denied", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, {
      callbackMode: "success",
      responseMode: "inline"
    });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const originalCreateServer = net.createServer;
    let blockedBindCount = 0;
    vi.spyOn(net, "createServer").mockImplementation(((...args: Parameters<typeof net.createServer>) => {
      const server = originalCreateServer(...args);
      const originalListen = server.listen.bind(server);

      const listenMock = (...listenArgs: Parameters<net.Server["listen"]>) => {
        const candidatePath = readSocketPath(listenArgs[0]);
        if (candidatePath?.includes("meridian-tool-")) {
          blockedBindCount += 1;
          const error = Object.assign(
            new Error(`listen EPERM: operation not permitted ${candidatePath}`),
            { code: "EPERM" }
          );
          queueMicrotask(() => {
            server.emit("error", error);
          });
          return server;
        }

        return originalListen(...listenArgs);
      };
      server.listen = listenMock as typeof server.listen;

      return server;
    }) as typeof net.createServer);

    const message = buildHubMessage({ reply_channel: undefined });
    const result = await sendAndWait(message, 200);

    expect(result).toMatchObject({
      trace_id: message.trace_id,
      status: "success",
      content: "ok"
    });
    expect(blockedBindCount).toBeGreaterThan(0);
    expect(hub.messages[0]).toMatchObject({
      trace_id: message.trace_id,
      reply_channel: {
        channel: "web",
        chat_id: "service:meridian-tool"
      }
    });
    expect(hub.callbackSocketPaths).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "Tool Gateway callback socket unavailable; falling back to inline Hub response",
      expect.objectContaining({
        expected_trace_id: message.trace_id,
        error: expect.stringContaining("listen EPERM")
      })
    );
  });

  it("falls back to inline Hub responses when bind denial only appears in the error message", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const hub = await startHubServer(hubSocketPath, {
      callbackMode: "success",
      responseMode: "inline"
    });
    servers.add(hub);
    process.env.HUB_SOCKET_PATH = hubSocketPath;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const originalCreateServer = net.createServer;
    vi.spyOn(net, "createServer").mockImplementation(((...args: Parameters<typeof net.createServer>) => {
      const server = originalCreateServer(...args);
      const originalListen = server.listen.bind(server);

      const listenMock = (...listenArgs: Parameters<net.Server["listen"]>) => {
        const candidatePath = readSocketPath(listenArgs[0]);
        if (candidatePath?.includes("meridian-tool-")) {
          const error = new Error(`listen EPERM: operation not permitted ${candidatePath}`);
          queueMicrotask(() => {
            server.emit("error", error);
          });
          return server;
        }

        return originalListen(...listenArgs);
      };
      server.listen = listenMock as typeof server.listen;

      return server;
    }) as typeof net.createServer);

    const message = buildHubMessage({ reply_channel: undefined });
    const result = await sendAndWait(message, 200);

    expect(result).toMatchObject({
      trace_id: message.trace_id,
      status: "success",
      content: "ok"
    });
    expect(hub.messages[0]).toMatchObject({
      trace_id: message.trace_id,
      reply_channel: {
        channel: "web",
        chat_id: "service:meridian-tool"
      }
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Tool Gateway callback socket unavailable; falling back to inline Hub response",
      expect.objectContaining({
        expected_trace_id: message.trace_id,
        error: expect.stringContaining("listen EPERM")
      })
    );
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-ipc-bridge-"));
  tempDirectories.add(directory);
  return directory;
}

async function startHubServer(
  socketPath: string,
  options: {
    callbackMode: "success" | "none" | "mismatch_then_success" | "empty" | "invalid_json";
    responseMode?: "callback" | "inline";
  }
): Promise<TestHubServer> {
  const messages: Record<string, unknown>[] = [];
  const callbackSocketPaths: string[] = [];
  let closed = false;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
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

      const response: HubResult = {
        trace_id: typeof message.trace_id === "string" ? message.trace_id : randomUUID(),
        thread_id: typeof message.thread_id === "string" ? message.thread_id : "dispatcher-1",
        source: "codex",
        status: "success",
        content: "ok",
        attachments: [],
        timestamp: new Date().toISOString()
      };

      if (options.responseMode === "inline") {
        socket.end(JSON.stringify(response));
        return;
      }

      if (options.callbackMode === "success" && replyChannel?.socket_path) {
        void sendCallback(replyChannel.socket_path, response);
      }

      if (options.callbackMode === "mismatch_then_success" && replyChannel?.socket_path) {
        const traceId = typeof message.trace_id === "string" ? message.trace_id : randomUUID();
        const threadId = typeof message.thread_id === "string" ? message.thread_id : "dispatcher-1";
        const callbackSocketPath = replyChannel.socket_path;

        void sendCallback(callbackSocketPath, {
          trace_id: randomUUID(),
          thread_id: threadId,
          source: "codex",
          status: "success",
          content: "mismatch",
          attachments: [],
          timestamp: new Date().toISOString()
        }).then(() => {
          return sendCallback(callbackSocketPath, {
            trace_id: traceId,
            thread_id: threadId,
            source: "codex",
            status: "success",
            content: "ok",
            attachments: [],
            timestamp: new Date().toISOString()
          });
        });
      }

      if (options.callbackMode === "empty" && replyChannel?.socket_path) {
        void sendRawCallback(replyChannel.socket_path, "");
      }

      if (options.callbackMode === "invalid_json" && replyChannel?.socket_path) {
        void sendRawCallback(replyChannel.socket_path, "{invalid");
      }

      socket.end();
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
  return sendRawCallback(socketPath, JSON.stringify(response));
}

function sendRawCallback(socketPath: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.end(payload);
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

function readSocketPath(value: Parameters<net.Server["listen"]>[0]): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "path" in value && typeof value.path === "string") {
    return value.path;
  }

  return null;
}
