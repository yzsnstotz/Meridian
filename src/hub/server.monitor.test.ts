import assert from "node:assert/strict";
import { test } from "node:test";

import type { HubResult, ReplyChannel } from "../types";
import type { ResultSender } from "./result-sender";
import type { HubRouter } from "./router";
import { HubServer } from "./server";

class FakeRouter {
  readonly completionCalls: Array<{ threadId: string; traceId: string | null }> = [];
  readonly progressCalls: Array<{ threadId: string; traceId: string | null }> = [];
  readonly statusCalls: Array<{ threadId: string; status: string }> = [];
  readonly forceDispatchCalls: string[] = [];
  attachedSessionsByThread = new Map<string, string[]>();
  monitorSubscribersByThread = new Map<string, string[]>();
  dueDispatches: Array<{ threadId: string; chatId: string }> = [];

  async route(rawMessage: unknown): Promise<HubResult> {
    void rawMessage;
    throw new Error("route() should not be called for monitor event payloads");
  }

  setInstanceStatus(threadId: string, status: string): void {
    this.statusCalls.push({ threadId, status });
  }

  getAttachedSessionsForThread(threadId: string): string[] {
    return this.attachedSessionsByThread.get(threadId) ?? [];
  }

  getMonitorUpdateSubscribersForThread(threadId: string): string[] {
    return this.monitorSubscribersByThread.get(threadId) ?? [];
  }

  resolveSourceForThread(threadId: string): "codex" {
    void threadId;
    return "codex";
  }

  async buildCompletionResultForThread(threadId: string, traceId: string | null): Promise<HubResult> {
    this.completionCalls.push({ threadId, traceId });
    return {
      trace_id: traceId ?? "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
      thread_id: threadId,
      source: "codex",
      status: "success",
      content: `[thread=${threadId}]\ncompletion`,
      attachments: [],
      timestamp: new Date().toISOString()
    };
  }

  collectDueMonitorUpdateDispatches(): Array<{ threadId: string; chatId: string }> {
    return [...this.dueDispatches];
  }

  async buildProgressResultForThread(threadId: string, traceId: string | null): Promise<HubResult> {
    this.progressCalls.push({ threadId, traceId });
    return {
      trace_id: traceId ?? "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
      thread_id: threadId,
      source: "codex",
      status: "partial",
      content: `[thread=${threadId}]\nprogress`,
      attachments: [],
      timestamp: new Date().toISOString()
    };
  }

  isThreadRunning(threadId: string): boolean {
    void threadId;
    return true;
  }

  forceMonitorUpdateDispatchNow(threadId: string): void {
    this.forceDispatchCalls.push(threadId);
  }
}

class FakeResultSender {
  readonly calls: Array<{ result: HubResult; replyChannel: ReplyChannel }> = [];

  async sendResult(result: HubResult, replyChannel: ReplyChannel): Promise<void> {
    this.calls.push({ result, replyChannel });
  }
}

test("HubServer forwards task_completed monitor event to all attached sessions", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.attachedSessionsByThread.set("codex_01", ["chat-a", "chat-b"]);
  const fakeResultSender = new FakeResultSender();

  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender
  });

  const result = await (server as unknown as { handleRawPayload: (raw: string) => Promise<HubResult | null> })
    .handleRawPayload(
      JSON.stringify({
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "codex_01",
        event_type: "task_completed",
        monitor_mode: "sse_hook",
        timestamp: new Date().toISOString(),
        agent_status: "stable"
      })
    );

  assert.equal(result, null);
  assert.deepEqual(fakeRouter.statusCalls, [{ threadId: "codex_01", status: "waiting" }]);
  assert.deepEqual(fakeRouter.completionCalls, [
    { threadId: "codex_01", traceId: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8" }
  ]);
  assert.equal(fakeResultSender.calls.length, 2);
  assert.deepEqual(
    fakeResultSender.calls.map((entry) => entry.replyChannel.chat_id),
    ["chat-a", "chat-b"]
  );
  assert.ok(fakeResultSender.calls.every((entry) => entry.result.status === "success"));
});

test("HubServer skips task_completed push when no session is attached", async () => {
  const fakeRouter = new FakeRouter();
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender
  });

  const result = await (server as unknown as { handleRawPayload: (raw: string) => Promise<HubResult | null> })
    .handleRawPayload(
      JSON.stringify({
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "codex_01",
        event_type: "task_completed",
        monitor_mode: "sse_hook",
        timestamp: new Date().toISOString()
      })
    );

  assert.equal(result, null);
  assert.deepEqual(fakeRouter.statusCalls, [{ threadId: "codex_01", status: "waiting" }]);
  assert.equal(fakeRouter.completionCalls.length, 0);
  assert.equal(fakeResultSender.calls.length, 0);
});

test("HubServer sends completion to /update subscribers even without attach", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.monitorSubscribersByThread.set("codex_01", ["chat-update"]);
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender
  });

  const result = await (server as unknown as { handleRawPayload: (raw: string) => Promise<HubResult | null> })
    .handleRawPayload(
      JSON.stringify({
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "codex_01",
        event_type: "task_completed",
        monitor_mode: "sse_hook",
        timestamp: new Date().toISOString()
      })
    );

  assert.equal(result, null);
  assert.deepEqual(fakeRouter.statusCalls, [{ threadId: "codex_01", status: "waiting" }]);
  assert.equal(fakeRouter.completionCalls.length, 1);
  assert.equal(fakeResultSender.calls.length, 1);
  assert.equal(fakeResultSender.calls[0]?.replyChannel.chat_id, "chat-update");
});

test("HubServer flushes periodic monitor progress updates for due subscriptions", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.dueDispatches = [
    { threadId: "codex_01", chatId: "chat-a" },
    { threadId: "codex_01", chatId: "chat-b" }
  ];
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender
  });

  await (server as unknown as { flushMonitorProgressUpdates: () => Promise<void> }).flushMonitorProgressUpdates();

  assert.equal(fakeRouter.progressCalls.length, 1);
  assert.equal(fakeResultSender.calls.length, 2);
  assert.ok(fakeResultSender.calls.every((entry) => entry.result.status === "partial"));
});
