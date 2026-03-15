import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import type { HubMessage, HubResult, ReplyChannel } from "../types";
import type { ResultSender } from "./result-sender";
import type { HubRouter } from "./router";
import { HubServer } from "./server";

let routeCallCount = 0;

function resetRouteCounter(): void {
  routeCallCount = 0;
}

function buildFakeRouter(): unknown {
  return {
    async initialize(): Promise<void> {
      return;
    },

    async route(message: HubMessage): Promise<HubResult> {
      routeCallCount++;
      return {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: `routed-${routeCallCount}`,
        attachments: [],
        timestamp: new Date().toISOString()
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
}

class FakeResultSender {
  readonly calls: Array<{ result: HubResult; replyChannel: ReplyChannel }> = [];

  async sendResult(result: HubResult, replyChannel: ReplyChannel): Promise<void> {
    this.calls.push({ result, replyChannel });
  }
}

function buildHubMessagePayload(overrides: Partial<HubMessage> = {}): string {
  const base: HubMessage = {
    trace_id: overrides.trace_id ?? randomUUID(),
    thread_id: overrides.thread_id ?? "codex_01",
    actor_id: overrides.actor_id ?? "tg:123",
    idempotency_key: overrides.idempotency_key,
    intent: overrides.intent ?? "run",
    target: overrides.target ?? "codex_01",
    payload: overrides.payload ?? { content: "hello", attachments: [] },
    mode: overrides.mode ?? "bridge",
    reply_channel: overrides.reply_channel ?? {
      channel: "telegram",
      chat_id: "telegram:999"
    },
    suppress_reply: true
  };
  return JSON.stringify(base);
}

type HandleRawPayload = { handleRawPayload: (raw: string) => Promise<HubResult | null> };

test("same idempotency_key sent twice only routes once", async () => {
  resetRouteCounter();
  const fakeRouter = buildFakeRouter();
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const key = "dedup-key-1";
  const payload = buildHubMessagePayload({ idempotency_key: key });

  const firstResult = await (server as unknown as HandleRawPayload).handleRawPayload(payload);
  assert.equal(routeCallCount, 1, "first call should route");
  assert.equal(firstResult?.status, "success");
  assert.equal(firstResult?.content, "routed-1");

  const secondResult = await (server as unknown as HandleRawPayload).handleRawPayload(payload);
  assert.equal(routeCallCount, 1, "second call should NOT route again");
  assert.deepEqual(secondResult, firstResult, "second call returns cached result");
});

test("messages without idempotency_key are always processed", async () => {
  resetRouteCounter();
  const fakeRouter = buildFakeRouter();
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const payload = buildHubMessagePayload({ idempotency_key: undefined });

  await (server as unknown as HandleRawPayload).handleRawPayload(payload);
  await (server as unknown as HandleRawPayload).handleRawPayload(payload);
  assert.equal(routeCallCount, 2, "both calls should route because there is no key");
});

test("expired idempotency entry allows re-execution", async () => {
  resetRouteCounter();
  const fakeRouter = buildFakeRouter();
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const key = "dedup-key-ttl";
  const payload = buildHubMessagePayload({ idempotency_key: key });

  // First call — populates cache
  await (server as unknown as HandleRawPayload).handleRawPayload(payload);
  assert.equal(routeCallCount, 1);

  // Manually expire the cache entry by setting expiresAt to the past
  const cache = (server as unknown as { idempotencyCache: Map<string, { result: HubResult; expiresAt: number }> }).idempotencyCache;
  const entry = cache.get(key);
  assert.ok(entry, "cache entry must exist");
  entry.expiresAt = Date.now() - 1;

  // Second call — entry is expired, should route again
  const result = await (server as unknown as HandleRawPayload).handleRawPayload(payload);
  assert.equal(routeCallCount, 2, "expired entry should allow re-execution");
  assert.equal(result?.content, "routed-2");
});

test("different idempotency_keys are processed independently", async () => {
  resetRouteCounter();
  const fakeRouter = buildFakeRouter();
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const payloadA = buildHubMessagePayload({ idempotency_key: "key-a" });
  const payloadB = buildHubMessagePayload({ idempotency_key: "key-b" });

  await (server as unknown as HandleRawPayload).handleRawPayload(payloadA);
  await (server as unknown as HandleRawPayload).handleRawPayload(payloadB);
  assert.equal(routeCallCount, 2, "different keys route independently");

  // Replaying key-a should be cached
  await (server as unknown as HandleRawPayload).handleRawPayload(payloadA);
  assert.equal(routeCallCount, 2, "replay of key-a should be cached");
});
