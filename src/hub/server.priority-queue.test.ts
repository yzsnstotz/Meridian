import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

process.env.LOG_DIR ??= "/tmp/meridian-test-logs";

import type { HubMessage, HubResult, ReplyChannel } from "../types";
import type { ResultSender } from "./result-sender";
import type { HubRouter } from "./router";
import { HubServer } from "./server";

const routeLog: Array<{ intent: string; priority: number }> = [];

function resetRouteLog(): void {
  routeLog.length = 0;
}

function buildFakeRouter(): unknown {
  return {
    async initialize(): Promise<void> {
      return;
    },

    async route(message: HubMessage): Promise<HubResult> {
      routeLog.push({ intent: message.intent, priority: message.priority ?? 5 });
      return {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: `${message.intent}:p${message.priority ?? 5}`,
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

function buildPayload(intent: string, priority?: number): string {
  return JSON.stringify({
    trace_id: randomUUID(),
    thread_id: "codex_01",
    actor_id: "tg:123",
    intent,
    target: "codex_01",
    priority,
    payload: { content: "x", attachments: [] },
    mode: "bridge",
    reply_channel: { channel: "telegram", chat_id: "telegram:999" },
    suppress_reply: true
  });
}

type EnqueueMessage = { enqueueMessage: (raw: string) => Promise<HubResult | null> };
type InsertIntoQueue = {
  insertIntoQueue: (item: { priority: number; sequence: number; raw: string; resolve: (r: HubResult | null) => void; reject: (e: unknown) => void }) => void;
  priorityQueue: Array<{ priority: number; sequence: number; raw: string }>;
};

test("insertIntoQueue sorts by priority (lower number first)", () => {
  resetRouteLog();
  const fakeRouter = buildFakeRouter();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: new FakeResultSender() as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const accessor = server as unknown as InsertIntoQueue;
  const noop = () => {};

  accessor.insertIntoQueue({ priority: 5, sequence: 0, raw: "a", resolve: noop, reject: noop });
  accessor.insertIntoQueue({ priority: 0, sequence: 1, raw: "b", resolve: noop, reject: noop });
  accessor.insertIntoQueue({ priority: 7, sequence: 2, raw: "c", resolve: noop, reject: noop });
  accessor.insertIntoQueue({ priority: 3, sequence: 3, raw: "d", resolve: noop, reject: noop });

  const priorities = accessor.priorityQueue.map((item) => item.priority);
  assert.deepEqual(priorities, [0, 3, 5, 7], "queue should be sorted by ascending priority");
});

test("same priority preserves FIFO order via sequence", () => {
  resetRouteLog();
  const fakeRouter = buildFakeRouter();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: new FakeResultSender() as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const accessor = server as unknown as InsertIntoQueue;
  const noop = () => {};

  accessor.insertIntoQueue({ priority: 5, sequence: 0, raw: "first", resolve: noop, reject: noop });
  accessor.insertIntoQueue({ priority: 5, sequence: 1, raw: "second", resolve: noop, reject: noop });
  accessor.insertIntoQueue({ priority: 5, sequence: 2, raw: "third", resolve: noop, reject: noop });

  const raws = accessor.priorityQueue.map((item) => item.raw);
  assert.deepEqual(raws, ["first", "second", "third"], "same-priority items preserve FIFO");
});

test("/kill (priority=0) is processed before default-priority messages when queued together", async () => {
  resetRouteLog();
  const fakeRouter = buildFakeRouter();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: new FakeResultSender() as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  // Pre-populate the queue without draining, then drain once to observe order.
  const accessor = server as unknown as InsertIntoQueue & {
    priorityQueueSequence: number;
    drainPriorityQueue: () => Promise<void>;
  };

  const results: Array<HubResult | null> = [];
  const promises: Array<Promise<void>> = [];

  function enqueueWithoutDrain(raw: string, priority: number): void {
    const seq = accessor.priorityQueueSequence++;
    promises.push(
      new Promise<void>((resolve, reject) => {
        accessor.insertIntoQueue({
          priority,
          sequence: seq,
          raw,
          resolve: (r) => { results.push(r); resolve(); },
          reject
        });
      })
    );
  }

  enqueueWithoutDrain(buildPayload("run"),       5);  // default
  enqueueWithoutDrain(buildPayload("run"),       5);  // default
  enqueueWithoutDrain(buildPayload("kill", 0),   0);  // highest priority
  enqueueWithoutDrain(buildPayload("run"),       5);  // default

  // Verify pre-drain queue order: kill (0) should be at front
  assert.equal(accessor.priorityQueue[0]?.priority, 0, "kill should be first in queue before drain");

  // Now drain
  await accessor.drainPriorityQueue();
  await Promise.all(promises);

  assert.equal(results.length, 4);

  // The kill message (priority 0) should be routed first
  assert.equal(routeLog[0]?.intent, "kill", "/kill should be processed first");
  assert.equal(routeLog[0]?.priority, 0);

  // All subsequent should be run at priority 5
  for (let i = 1; i < routeLog.length; i++) {
    assert.equal(routeLog[i]?.intent, "run");
  }
});

test("monitor events default to priority 7 (lower than normal messages)", () => {
  const fakeRouter = buildFakeRouter();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: new FakeResultSender() as unknown as ResultSender,
    staticServiceEndpoints: []
  });

  const extractPriority = (server as unknown as { extractPriorityFromRaw: (raw: string) => number }).extractPriorityFromRaw;

  const monitorPayload = JSON.stringify({
    trace_id: randomUUID(),
    thread_id: "codex_01",
    event_type: "status_changed",
    monitor_mode: "sse_hook",
    timestamp: new Date().toISOString(),
    agent_status: "running"
  });
  assert.equal(extractPriority.call(server, monitorPayload), 7, "monitor events get priority 7");

  const normalPayload = buildPayload("run");
  assert.equal(extractPriority.call(server, normalPayload), 5, "normal messages get default priority 5");

  const killPayload = buildPayload("kill", 0);
  assert.equal(extractPriority.call(server, killPayload), 0, "/kill payload extracts priority 0");
});

test("list_models bypasses the global queue while a run is still in flight", async () => {
  let releaseRun: () => void = () => undefined;
  const runBlocked = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const fakeRouter = {
    async initialize(): Promise<void> {
      return;
    },
    async route(message: HubMessage): Promise<HubResult> {
      if (message.intent === "run") {
        await runBlocked;
      }
      return {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: message.intent,
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

  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: new FakeResultSender() as unknown as ResultSender,
    staticServiceEndpoints: []
  });
  const accessor = server as unknown as EnqueueMessage;

  const runPromise = accessor.enqueueMessage(
    JSON.stringify({
      trace_id: randomUUID(),
      thread_id: "codex_01",
      actor_id: "tg:123",
      intent: "run",
      target: "codex_01",
      payload: { content: "hello", attachments: [] },
      mode: "bridge",
      reply_channel: { channel: "telegram", chat_id: "telegram:999" },
      suppress_reply: true
    })
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const modelPromise = accessor.enqueueMessage(
    JSON.stringify({
      trace_id: randomUUID(),
      thread_id: "codex_01",
      actor_id: "tg:123",
      intent: "list_models",
      target: "codex_01",
      payload: { content: "", attachments: [] },
      mode: "bridge",
      reply_channel: { channel: "telegram", chat_id: "telegram:999" },
      suppress_reply: true
    })
  );

  const modelResult = await Promise.race([
    modelPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("list_models was blocked by run")), 200))
  ]);
  assert.equal(modelResult?.content, "list_models");

  releaseRun();
  const runResult = await runPromise;
  assert.equal(runResult?.content, "run");
});
