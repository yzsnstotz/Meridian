import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

process.env.LOG_DIR ??= "/tmp/meridian-test-logs";
process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY ??= "test-bootstrap-key-test-bootstrap-key-test-bootstrap-key-1234";

import type { HubMessage, HubResult, ReplyChannel } from "../types";
import { OutputBus } from "./output-bus";
import type { ResultSender } from "./result-sender";
import type { HubRouter } from "./router";
import { HubServer } from "./server";

class FakeResultSender {
  readonly calls: Array<{ result: HubResult; replyChannel: ReplyChannel }> = [];

  async sendResult(result: HubResult, replyChannel: ReplyChannel): Promise<void> {
    this.calls.push({ result, replyChannel });
  }
}

function buildMessage(overrides: Partial<HubMessage> = {}): string {
  const base: HubMessage = {
    trace_id: overrides.trace_id ?? randomUUID(),
    thread_id: overrides.thread_id ?? "codex_01",
    actor_id: overrides.actor_id ?? "telegram:123",
    intent: overrides.intent ?? "run",
    target: overrides.target ?? "codex_01",
    payload: overrides.payload ?? {
      content: "hello",
      attachments: []
    },
    mode: overrides.mode ?? "bridge",
    reply_channel: overrides.reply_channel ?? {
      channel: "telegram",
      chat_id: "telegram:999"
    },
    suppress_reply: overrides.suppress_reply ?? false
  };
  return JSON.stringify(base);
}

function waitForSocketConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

function waitForSocketLine(socket: net.Socket, match: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for socket line containing ${match}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.includes(match)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

type HandleRawPayload = { handleRawPayload: (raw: string) => Promise<HubResult | null> };

test("HubServer sends Telegram run replies from shared conversation history when available", async () => {
  const traceId = randomUUID();
  const fakeResultSender = new FakeResultSender();
  const fakeRouter = {
    async initialize(): Promise<void> {
      return;
    },
    async route(message: HubMessage): Promise<HubResult> {
      return {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: "summary-only result",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    },
    getLatestConversationEntry(threadId: string, requestedTraceId?: string | null, type?: "user" | "agent" | null) {
      assert.equal(threadId, "codex_01");
      assert.equal(requestedTraceId, traceId);
      assert.equal(type, "agent");
      return {
        raw_content: "shared history agent reply",
        content: "shared history summary",
        details_text: "shared history details"
      };
    },
    setInstanceStatus(): void {
      return;
    },
    getAttachedSessionsForThread(): string[] {
      return [];
    },
    getMonitorUpdateSubscribersForThread(): string[] {
      return [];
    },
    resolveSourceForThread(): "codex" {
      return "codex";
    },
    collectDueMonitorUpdateDispatches(): [] {
      return [];
    },
    isThreadRunning(): boolean {
      return false;
    },
    forceMonitorUpdateDispatchNow(): void {
      return;
    },
    resolveInstanceForThread(): null {
      return null;
    },
    registerServiceEndpoint(): void {
      return;
    }
  };

  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const result = await (server as unknown as HandleRawPayload).handleRawPayload(
    buildMessage({
      trace_id: traceId,
      thread_id: "codex_01",
      target: "codex_01",
      intent: "run"
    })
  );

  assert.equal(result?.content, "summary-only result");
  assert.equal(fakeResultSender.calls.length, 1);
  assert.equal(fakeResultSender.calls[0]?.result.content, "shared history agent reply");
  assert.equal(fakeResultSender.calls[0]?.result.summary_text, "shared history summary");
  assert.equal(fakeResultSender.calls[0]?.result.details_text, "shared history details");
});

test("HubServer falls back to routed result when shared history has no matching entry", async () => {
  const fakeResultSender = new FakeResultSender();
  const fakeRouter = {
    async initialize(): Promise<void> {
      return;
    },
    async route(message: HubMessage): Promise<HubResult> {
      return {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: "status reply",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    },
    getLatestConversationEntry(): null {
      return null;
    },
    setInstanceStatus(): void {
      return;
    },
    getAttachedSessionsForThread(): string[] {
      return [];
    },
    getMonitorUpdateSubscribersForThread(): string[] {
      return [];
    },
    resolveSourceForThread(): "codex" {
      return "codex";
    },
    collectDueMonitorUpdateDispatches(): [] {
      return [];
    },
    isThreadRunning(): boolean {
      return false;
    },
    forceMonitorUpdateDispatchNow(): void {
      return;
    },
    resolveInstanceForThread(): null {
      return null;
    },
    registerServiceEndpoint(): void {
      return;
    }
  };

  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  await (server as unknown as HandleRawPayload).handleRawPayload(
    buildMessage({
      intent: "status",
      trace_id: randomUUID()
    })
  );

  assert.equal(fakeResultSender.calls.length, 1);
  assert.equal(fakeResultSender.calls[0]?.result.content, "status reply");
});

test("HubServer streams A2A output bus messages to subscribed sockets", async () => {
  const socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-hub-a2a-stream-"));
  const socketPath = path.join(socketDir, "hub.sock");
  const outputBus = new OutputBus();
  const fakeResultSender = new FakeResultSender();
  const liveText = "live output bus reply";
  let routed = false;
  const fakeRouter = {
    async initialize(): Promise<void> {
      return;
    },
    ensureBuiltinCallers(): void {
      return;
    },
    registerServiceEndpoint(): void {
      return;
    },
    persistOnShutdown(): void {
      return;
    },
    async route(message: HubMessage): Promise<HubResult> {
      routed = true;
      outputBus.pushDelta(message.trace_id, {
        traceId: message.trace_id,
        phase: "working",
        text: liveText,
        final: false
      });
      return {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: "done",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    },
    getLatestConversationEntry(): null {
      return null;
    },
    setInstanceStatus(): void {
      return;
    },
    getAttachedSessionsForThread(): string[] {
      return [];
    },
    getMonitorUpdateSubscribersForThread(): string[] {
      return [];
    },
    resolveSourceForThread(): "codex" {
      return "codex";
    },
    collectDueMonitorUpdateDispatches(): [] {
      return [];
    },
    isThreadRunning(): boolean {
      return false;
    },
    forceMonitorUpdateDispatchNow(): void {
      return;
    },
    resolveInstanceForThread(): null {
      return null;
    }
  };
  const server = new HubServer({
    socketPath,
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    outputBus,
    staticServiceEndpoints: []
  });
  let subscriber: net.Socket | null = null;
  let requester: net.Socket | null = null;

  try {
    await server.start();
    subscriber = net.createConnection(socketPath);
    subscriber.setEncoding("utf8");
    await waitForSocketConnect(subscriber);
    const liveLinePromise = waitForSocketLine(subscriber, liveText);
    subscriber.write(`${JSON.stringify({ type: "a2a_stream_subscribe", thread_id: "codex_01" })}\n`);

    requester = net.createConnection(socketPath);
    await waitForSocketConnect(requester);
    requester.end(
      buildMessage({
        trace_id: randomUUID(),
        thread_id: "codex_01",
        target: "codex_01",
        intent: "run",
        suppress_reply: true
      })
    );

    const liveLine = await liveLinePromise;
    assert.equal(routed, true);
    assert.match(liveLine, /"type":"a2a_message"/);
    assert.match(liveLine, /live output bus reply/);
  } finally {
    subscriber?.destroy();
    requester?.destroy();
    await server.stop();
    await fs.promises.rm(socketDir, { recursive: true, force: true });
  }
});
