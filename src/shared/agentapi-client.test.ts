import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AgentAPIClient,
  type AgentEvent,
  type EventSourceFactory,
  type EventSourceLike
} from "./agentapi-client";

interface TestServer {
  socketPath: string;
  close: () => Promise<void>;
}

class FakeEventSource implements EventSourceLike {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private closed = false;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown): void {
    if (this.closed) {
      return;
    }

    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await wait(5);
  }

  assert.fail(`Condition was not met within ${timeoutMs}ms`);
}

async function createAgentApiServer(
  onRequest: (request: http.IncomingMessage, body: string, response: http.ServerResponse) => void
): Promise<TestServer> {
  const tempDir = mkdtempSync(path.join("/tmp", "agentapi-client-test-"));
  const socketPath = path.join(tempDir, "agentapi.sock");

  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      onRequest(request, body, response);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test("connect + sendMessage + getStatus over unix socket", async () => {
  const seenMessages: Array<{ content: string; attachments: Array<{ path: string }> }> = [];

  const server = await createAgentApiServer((request, body, response) => {
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "running", thread_id: "claude_01" }));
      return;
    }

    if (request.method === "POST" && request.url === "/message") {
      seenMessages.push(JSON.parse(body) as { content: string; attachments: Array<{ path: string }> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const client = new AgentAPIClient({ threadId: "claude_01" });
    await client.connect(server.socketPath);

    const status = await client.getStatus();
    assert.equal(status.status, "running");
    assert.equal(status.thread_id, "claude_01");

    const messageResult = await client.sendMessage("hello from test", [{ path: "/tmp/demo.txt" }]);
    assert.equal(messageResult.ok, true);
    assert.equal(seenMessages.length, 1);
    assert.equal(seenMessages[0]?.content, "hello from test");
    assert.equal(seenMessages[0]?.attachments[0]?.path, "/tmp/demo.txt");

    client.disconnect();
  } finally {
    await server.close();
  }
});

test("subscribeEvents retries with exponential backoff and logs reconnect attempts", async () => {
  const server = await createAgentApiServer((request, _, response) => {
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "idle" }));
      return;
    }

    if (request.method === "GET" && request.url === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        Connection: "keep-alive",
        "cache-control": "no-cache"
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  const eventSourceInstances: FakeEventSource[] = [];
  const eventSourceFactory: EventSourceFactory = () => {
    const instance = new FakeEventSource();
    eventSourceInstances.push(instance);
    return instance;
  };

  const logs: Array<{ level: string; message: string }> = [];
  let reconnectAttemptCount = 0;
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => {
      const message = typeof args[1] === "string" ? args[1] : "";
      logs.push({ level: "warn", message });
    },
    error: (...args: unknown[]) => {
      const message = typeof args[1] === "string" ? args[1] : "";
      logs.push({ level: "error", message });
    }
  };

  try {
    const client = new AgentAPIClient({
      threadId: "codex_01",
      eventSourceFactory,
      monitorLogger: logger,
      baseReconnectDelayMs: 5,
      maxReconnectDelayMs: 20,
      maxReconnectAttempts: 5,
      onSseReconnectAttempt: () => {
        reconnectAttemptCount += 1;
      }
    });

    await client.connect(server.socketPath);

    const receivedEvents: AgentEvent[] = [];
    const subscription = client.subscribeEvents((event) => {
      receivedEvents.push(event);
    });

    assert.equal(eventSourceInstances.length, 1);
    eventSourceInstances[0]?.emit("error", { message: "stream dropped" });

    await waitFor(() => eventSourceInstances.length >= 2, 300);
    eventSourceInstances[1]?.emit("message", {
      type: "message",
      data: JSON.stringify({ event_type: "status_changed", status: "running" })
    });

    await waitFor(() => receivedEvents.length === 1, 300);

    assert.equal(receivedEvents[0]?.thread_id, "codex_01");
    assert.deepEqual(receivedEvents[0]?.data, { event_type: "status_changed", status: "running" });
    assert.ok(
      logs.some((entry) => entry.level === "warn" && entry.message.includes("scheduling reconnect"))
    );
    assert.equal(reconnectAttemptCount, 1);

    subscription.close();
    client.disconnect();
  } finally {
    await server.close();
  }
});

test("errors include thread_id and socketPath context", async () => {
  const missingSocket = path.join(tmpdir(), `missing-agentapi-${Date.now()}.sock`);
  const client = new AgentAPIClient({ threadId: "ctx_thread" });

  await assert.rejects(
    client.connect(missingSocket),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("thread_id=ctx_thread") &&
      error.message.includes(`socketPath=${missingSocket}`)
  );
});
