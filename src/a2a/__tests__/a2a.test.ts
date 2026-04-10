import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInstance, HubMessage, HubResult, ReplyChannel } from "../../types";
import { A2AClient } from "../client";
import { A2AServer } from "../server";

interface TestHubServer {
  messages: Record<string, unknown>[];
  close(): Promise<void>;
}

const tempDirectories = new Set<string>();
const clients = new Set<A2AClient>();
const servers = new Set<TestHubServer>();
const roleServers = new Set<A2AServer>();
const listedInstances: AgentInstance[] = [
  {
    thread_id: "codex_01",
    agent_type: "codex",
    model_id: "gpt-5-codex",
    mode: "bridge",
    socket_path: "/tmp/codex.sock",
    working_dir: "/tmp",
    pid: 202,
    tmux_pane: null,
    status: "idle",
    created_at: "2026-03-19T00:00:00.000Z",
    restart_safe: true,
    auto_approve: false
  }
];
const listedReplyChannels: ReplyChannel[] = [
  {
    channel: "telegram",
    chat_id: "telegram:dispatch-room",
    chat_name: "Dispatch Room"
  },
  {
    channel: "web",
    chat_id: "web:ops"
  }
];

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(Array.from(clients, (client) => client.stop()));
  await Promise.all(Array.from(roleServers, (server) => server.close().catch(() => undefined)));
  await Promise.all(Array.from(servers, (server) => server.close().catch(() => undefined)));
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));

  clients.clear();
  roleServers.clear();
  servers.clear();
  tempDirectories.clear();
});

describe("A2AServer", () => {
  it("parses sendIpcMessage-format payloads and forwards HubResult objects", async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, "roles.sock");
    const received: HubResult[] = [];
    const server = new A2AServer(async (result) => {
      received.push(result);
    }, { socketPath });
    roleServers.add(server);

    await server.listen();

    const result: HubResult = {
      trace_id: randomUUID(),
      thread_id: "dispatcher-1",
      source: "claude",
      status: "success",
      content: "done",
      attachments: [],
      timestamp: new Date().toISOString()
    };

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        socket.end(JSON.stringify(result));
      });

      socket.once("close", () => resolve());
      socket.once("error", reject);
    });

    await vi.waitFor(() => {
      expect(received).toEqual([result]);
    });
  });

  it("replaces a stale socket path before listening", async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, "roles.sock");
    await fs.writeFile(socketPath, "stale");

    const server = new A2AServer(async () => undefined, { socketPath });
    roleServers.add(server);

    await server.listen();

    const stat = await fs.stat(socketPath);
    expect(stat.isSocket()).toBe(true);
  });
});

describe("A2AClient", () => {
  it("registers the service on startup and waits for a success response", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const rolesSocketPath = path.join(directory, "roles.sock");
    const hub = await startHubServer(hubSocketPath);
    servers.add(hub);

    const client = new A2AClient({
      hubSocketPath,
      rolesSocketPath,
      retryBaseDelayMs: 10,
      maxRetryDelayMs: 20
    });
    clients.add(client);

    await client.start();

    expect(hub.messages).toHaveLength(1);
    const registration = hub.messages[0];
    expect(registration).toMatchObject({
      thread_id: "register",
      actor_id: "meridian-roles",
      intent: "register_service",
      target: "global",
      mode: "bridge",
      reply_channel: {
        channel: "web",
        chat_id: "service:meridian-roles"
      }
    });

    const payload = parsePayloadContent(registration);
    expect(payload).toEqual({
      service: "meridian-roles",
      socket_path: rolesSocketPath,
      agent_card: {
        name: "meridian-roles",
        url: rolesSocketPath,
        skills: [
          {
            id: "role-coordination",
            intents: []
          }
        ]
      }
    });
  });

  it("retries registration until the hub becomes available", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const rolesSocketPath = path.join(directory, "roles.sock");
    const client = new A2AClient({
      hubSocketPath,
      rolesSocketPath,
      retryBaseDelayMs: 10,
      maxRetryDelayMs: 20
    });
    clients.add(client);

    const startPromise = client.start();
    await sleep(30);

    const hub = await startHubServer(hubSocketPath);
    servers.add(hub);

    await expect(startPromise).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(hub.messages).toHaveLength(1);
    });
  });

  it("falls back to the next configured hub socket path when the first socket is unavailable", async () => {
    const directory = await createTempDirectory();
    const missingHubSocketPath = path.join(directory, "missing.sock");
    const workingHubSocketPath = path.join(directory, "hub.sock");
    const rolesSocketPath = path.join(directory, "roles.sock");
    const hub = await startHubServer(workingHubSocketPath);
    servers.add(hub);

    const client = new A2AClient({
      hubSocketPath: missingHubSocketPath,
      hubSocketPaths: [missingHubSocketPath, workingHubSocketPath],
      rolesSocketPath,
      retryBaseDelayMs: 10,
      maxRetryDelayMs: 20
    });
    clients.add(client);

    await client.start();

    expect(hub.messages).toHaveLength(1);
    expect(hub.messages[0]).toMatchObject({
      intent: "register_service",
      thread_id: "register"
    });
  });

  it("uses only the configured hub socket path unless extra candidates are provided", () => {
    const client = new A2AClient({
      hubSocketPath: "/tmp/hub-socks/hub-core.sock"
    });

    expect((client as unknown as { hubSocketPaths: string[] }).hubSocketPaths).toEqual([
      "/tmp/hub-socks/hub-core.sock"
    ]);
  });

  it("re-registers and flushes queued messages after the hub restarts", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const rolesSocketPath = path.join(directory, "roles.sock");
    const firstHub = await startHubServer(hubSocketPath);
    servers.add(firstHub);

    const client = new A2AClient({
      hubSocketPath,
      rolesSocketPath,
      retryBaseDelayMs: 10,
      maxRetryDelayMs: 20
    });
    clients.add(client);

    await client.start();
    await firstHub.close();
    servers.delete(firstHub);

    const outboundMessage = buildHubMessage({
      trace_id: randomUUID(),
      thread_id: "dispatcher-1"
    });

    await expect(client.send(outboundMessage)).resolves.toBeUndefined();
    await sleep(30);

    const secondHub = await startHubServer(hubSocketPath);
    servers.add(secondHub);

    await vi.waitFor(() => {
      expect(secondHub.messages).toHaveLength(2);
    });
    expect(secondHub.messages[0]).toMatchObject({ intent: "register_service" });
    expect(secondHub.messages[1]).toMatchObject({
      intent: "run",
      thread_id: "dispatcher-1",
      target: "claude_01"
    });
  });

  it("lists registered instances through the hub list contract", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const rolesSocketPath = path.join(directory, "roles.sock");
    const hub = await startHubServer(hubSocketPath, { listInstances: listedInstances });
    servers.add(hub);

    const client = new A2AClient({
      hubSocketPath,
      rolesSocketPath,
      retryBaseDelayMs: 10,
      maxRetryDelayMs: 20
    });
    clients.add(client);

    await client.start();

    await expect(client.listInstances()).resolves.toEqual(listedInstances);
    expect(hub.messages[1]).toMatchObject({
      thread_id: "list_instances",
      actor_id: "service:meridian-roles",
      intent: "list",
      target: "global",
      reply_channel: {
        channel: "web",
        chat_id: "service:meridian-roles"
      }
    });
  });

  it("lists registered reply channels through the hub registry contract", async () => {
    const directory = await createTempDirectory();
    const hubSocketPath = path.join(directory, "hub.sock");
    const rolesSocketPath = path.join(directory, "roles.sock");
    const hub = await startHubServer(hubSocketPath, { listReplyChannels: listedReplyChannels });
    servers.add(hub);

    const client = new A2AClient({
      hubSocketPath,
      rolesSocketPath,
      retryBaseDelayMs: 10,
      maxRetryDelayMs: 20
    });
    clients.add(client);

    await client.start();

    await expect(client.listReplyChannels()).resolves.toEqual(listedReplyChannels);
    expect(hub.messages[1]).toMatchObject({
      thread_id: "list_reply_channels",
      actor_id: "service:meridian-roles",
      intent: "list",
      target: "global",
      reply_channel: {
        channel: "web",
        chat_id: "service:meridian-roles"
      }
    });
    expect(parsePayloadContent(hub.messages[1])).toEqual({
      kind: "reply_channels"
    });
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-a2a-");
  tempDirectories.add(directory);
  return directory;
}

async function startHubServer(
  socketPath: string,
  options: {
    listInstances?: AgentInstance[];
    listReplyChannels?: ReplyChannel[];
  } = {}
): Promise<TestHubServer> {
  const messages: Record<string, unknown>[] = [];
  let closed = false;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    let raw = "";

    socket.on("data", (chunk: string) => {
      raw += chunk;
    });

    socket.on("end", () => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      messages.push(message);
      const content = message.intent === "list"
        ? JSON.stringify(isReplyChannelListRequest(message) ? (options.listReplyChannels ?? []) : (options.listInstances ?? []))
        : "ok";

      socket.end(JSON.stringify({
        trace_id: typeof message.trace_id === "string" ? message.trace_id : randomUUID(),
        thread_id: typeof message.thread_id === "string" ? message.thread_id : "unknown",
        source: "codex",
        status: "success",
        content,
        attachments: [],
        timestamp: new Date().toISOString()
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    messages,
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

function isReplyChannelListRequest(message: Record<string, unknown>): boolean {
  if (message.thread_id === "list_reply_channels") {
    return true;
  }

  const payload = message.payload;
  if (!payload || typeof payload !== "object" || !("content" in payload) || typeof payload.content !== "string") {
    return false;
  }

  try {
    const content = JSON.parse(payload.content) as { kind?: unknown };
    return content.kind === "reply_channels";
  } catch {
    return false;
  }
}

function buildHubMessage(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: "dispatcher-1",
    actor_id: "service:meridian-roles",
    intent: "run",
    target: "claude_01",
    priority: 5,
    mode: "bridge",
    reply_channel: {
      channel: "socket",
      chat_id: "service:meridian-roles",
      socket_path: "/tmp/meridian-roles.sock"
    },
    suppress_reply: false,
    payload: {
      content: "Run the task",
      attachments: []
    },
    ...overrides
  };
}

function parsePayloadContent(message: Record<string, unknown>): Record<string, unknown> {
  const payload = message.payload;
  if (!payload || typeof payload !== "object" || !("content" in payload) || typeof payload.content !== "string") {
    throw new Error("payload.content missing");
  }

  return JSON.parse(payload.content) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
