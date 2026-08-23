import { randomUUID } from "node:crypto";
import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HubMessage, HubResult } from "../../types";
import { sendViaHttpRelay } from "../ipc-bridge";

interface TestHttpRelayServer {
  messages: Record<string, unknown>[];
  url: string;
  close(): Promise<void>;
}

const relayServers = new Set<TestHttpRelayServer>();
const originalHubRelayUrl = process.env.MERIDIAN_HUB_RELAY_URL;

afterEach(async () => {
  vi.restoreAllMocks();

  if (originalHubRelayUrl === undefined) {
    delete process.env.MERIDIAN_HUB_RELAY_URL;
  } else {
    process.env.MERIDIAN_HUB_RELAY_URL = originalHubRelayUrl;
  }

  await Promise.all(Array.from(relayServers, (server) => server.close().catch(() => undefined)));
  relayServers.clear();
});

describe("sendViaHttpRelay", () => {
  it("sends a Hub message via HTTP relay and returns the parsed result", async () => {
    const relay = await startHttpRelayServer();
    relayServers.add(relay);
    process.env.MERIDIAN_HUB_RELAY_URL = relay.url;

    const message = buildHubMessage();
    const result = await sendViaHttpRelay(message, 5000);

    expect(result).toMatchObject({
      trace_id: message.trace_id,
      status: "success",
      content: "ok"
    });
    expect(relay.messages).toHaveLength(1);
    expect(relay.messages[0]).toMatchObject({
      trace_id: message.trace_id
    });
  });

  it("injects a web reply channel when none is provided", async () => {
    const relay = await startHttpRelayServer();
    relayServers.add(relay);
    process.env.MERIDIAN_HUB_RELAY_URL = relay.url;

    const message = buildHubMessage({ reply_channel: undefined });
    await sendViaHttpRelay(message, 5000);

    expect(relay.messages[0]).toMatchObject({
      reply_channel: {
        channel: "web",
        chat_id: "service:meridian-tool"
      }
    });
  });

  it("rejects when the relay returns an empty body", async () => {
    const relay = await startHttpRelayServer({ responseMode: "empty" });
    relayServers.add(relay);
    process.env.MERIDIAN_HUB_RELAY_URL = relay.url;

    const message = buildHubMessage();
    const error = await sendViaHttpRelay(message, 5000).then(
      () => null,
      (caughtError) => caughtError as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("HTTP relay completed without a response body");
    expect(error?.message).toContain(`trace_id=${message.trace_id}`);
    expect(error?.message).toContain("transport=http-relay");
    expect(error?.message).toContain("response_path_failure=empty-body");
  });

  it("rejects when the relay returns invalid JSON", async () => {
    const relay = await startHttpRelayServer({ responseMode: "invalid_json" });
    relayServers.add(relay);
    process.env.MERIDIAN_HUB_RELAY_URL = relay.url;

    const message = buildHubMessage();
    const error = await sendViaHttpRelay(message, 5000).then(
      () => null,
      (caughtError) => caughtError as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("Invalid HTTP relay response");
    expect(error?.message).toContain("transport=http-relay");
    expect(error?.message).toContain("response_path_failure=invalid-body");
  });

  it("rejects when the relay is unreachable", async () => {
    process.env.MERIDIAN_HUB_RELAY_URL = "http://127.0.0.1:1/api/hub-relay";

    const message = buildHubMessage();
    const error = await sendViaHttpRelay(message, 5000).then(
      () => null,
      (caughtError) => caughtError as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/ECONNREFUSED|EADDRNOTAVAIL/);
  });

  it("does not use HUB_SOCKET_PATH or direct socket transport", async () => {
    const relay = await startHttpRelayServer();
    relayServers.add(relay);
    process.env.MERIDIAN_HUB_RELAY_URL = relay.url;

    const message = buildHubMessage();
    await sendViaHttpRelay(message, 5000);

    expect(relay.messages).toHaveLength(1);
    expect(relay.messages[0]).not.toHaveProperty("reply_channel.socket_path");
  });
});

async function startHttpRelayServer(
  options: { responseMode?: "success" | "empty" | "invalid_json" } = {}
): Promise<TestHttpRelayServer> {
  const messages: Record<string, unknown>[] = [];
  let closed = false;
  const responseMode = options.responseMode ?? "success";

  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      messages.push(message);

      if (responseMode === "empty") {
        response.statusCode = 200;
        response.end("");
        return;
      }

      if (responseMode === "invalid_json") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end("{invalid");
        return;
      }

      const result: HubResult = {
        trace_id: typeof message.trace_id === "string" ? message.trace_id : randomUUID(),
        thread_id: typeof message.thread_id === "string" ? message.thread_id : "dispatcher-1",
        source: "codex",
        status: "success",
        content: "ok",
        attachments: [],
        timestamp: new Date().toISOString()
      };

      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind HTTP relay test server");
  }

  return {
    messages,
    url: `http://127.0.0.1:${address.port}/api/hub-relay`,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
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
