import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../config";
import { classifyAgentOutput } from "../shared/agent-output";
import type { HubResult, ReplyChannel, ServiceEndpoint, ThreadProgressSnapshot } from "../types";
import { PaneBroadcaster } from "./pane-broadcaster";
import { OutputBus } from "./output-bus";
import type { ResultSender } from "./result-sender";
import type { HubRouter } from "./router";
import { HubServer, resolveStaticServiceEndpoints } from "./server";

class FakeRouter {
  readonly completionCalls: Array<{ threadId: string; traceId: string | null }> = [];
  readonly progressSnapshotCalls: Array<{ threadId: string; traceId: string | null }> = [];
  readonly recordCalls: Array<{ threadId: string; rawContent: string; traceId: string | null; eventKindHint?: "progress" | "final_reply" }> = [];
  readonly statusCalls: Array<{ threadId: string; status: string }> = [];
  readonly forceDispatchCalls: string[] = [];
  attachedSessionsByThread = new Map<string, string[]>();
  monitorSubscribersByThread = new Map<string, string[]>();
  pushSubscriptionsByThread = new Map<
    string,
    Array<{ chatId: string; botId?: string; replyChannel: ReplyChannel }>
  >();
  activeRunTraceByThread = new Map<string, string>();
  activeRuns = new Set<string>();
  latestConversationEntryByKey = new Map<
    string,
    { raw_content?: string; content?: string; details_text?: string }
  >();
  dueDispatches: Array<{ threadId: string; chatId: string; botId?: string; replyChannel: ReplyChannel }> = [];

  async initialize(): Promise<void> {
    return;
  }

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
      content: `completion`,
      attachments: [],
      timestamp: new Date().toISOString()
    };
  }

  collectDueMonitorUpdateDispatches(): Array<{ threadId: string; chatId: string }> {
    return [...this.dueDispatches];
  }

  async buildProgressSnapshotForThread(threadId: string, traceId: string | null): Promise<ThreadProgressSnapshot> {
    this.progressSnapshotCalls.push({ threadId, traceId });
    return {
      trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
      thread_id: threadId,
      source: "codex",
      status: "partial",
      event_kind: "progress",
      phase: "running",
      waiting_for_input: false,
      content: `progress`,
      display_text: "progress",
      updated_at: new Date().toISOString()
    };
  }

  recordAgentPushConversation(
    threadId: string,
    rawContent: string,
    traceId: string | null,
    eventKindHint?: "progress" | "final_reply"
  ): void {
    this.recordCalls.push({ threadId, rawContent, traceId, eventKindHint });
    this.latestConversationEntryByKey.set(this.makeConversationKey(threadId, traceId), {
      raw_content: rawContent,
      content: rawContent,
      details_text: rawContent
    });
  }

  isThreadRunning(threadId: string): boolean {
    void threadId;
    return true;
  }

  forceMonitorUpdateDispatchNow(threadId: string): void {
    this.forceDispatchCalls.push(threadId);
  }

  resolveInstanceForThread(): null {
    return null;
  }

  registerServiceEndpoint(): void {
    return;
  }

  getPushSubscriptionsForThread(
    threadId: string
  ): Array<{ chatId: string; botId?: string; replyChannel: ReplyChannel }> {
    return this.pushSubscriptionsByThread.get(threadId) ?? [];
  }

  isRunActiveForThread(threadId: string): boolean {
    return this.activeRuns.has(threadId);
  }

  isWithinRunCompletionCooldown(): boolean {
    return false;
  }

  getActiveRunTraceId(threadId: string): string | null {
    return this.activeRunTraceByThread.get(threadId) ?? null;
  }

  getLatestConversationEntry(
    threadId: string,
    traceId?: string | null,
    type: "user" | "agent" | null = null
  ): { raw_content?: string; content?: string; details_text?: string } | null {
    void type;
    return this.latestConversationEntryByKey.get(this.makeConversationKey(threadId, traceId ?? null)) ?? null;
  }

  resolveReplyChannelForSession(session: string): ReplyChannel {
    const separatorIndex = session.indexOf(":");
    if (separatorIndex <= 0) {
      return { channel: "telegram", chat_id: session };
    }
    const candidateBotId = session.slice(0, separatorIndex);
    if (!/^\d+$/.test(candidateBotId)) {
      return { channel: "telegram", chat_id: session };
    }
    return {
      channel: "telegram",
      chat_id: session.slice(separatorIndex + 1),
      bot_id: candidateBotId
    };
  }

  private makeConversationKey(threadId: string, traceId: string | null): string {
    return `${threadId}::${traceId ?? "null"}`;
  }
}

class FakeResultSender {
  readonly calls: Array<{ result: HubResult; replyChannel: ReplyChannel }> = [];

  async sendResult(result: HubResult, replyChannel: ReplyChannel): Promise<void> {
    this.calls.push({ result, replyChannel });
  }
}

class FakePaneBroadcaster {
  readonly subscribeCalls: Array<{ threadId: string }> = [];
  private pushCallback: ((threadId: string, chunk: string) => void) | null = null;

  async subscribe(): Promise<{ kind: "not_available"; payload: { type: "not_available"; thread_id: string; reason: string } }> {
    this.subscribeCalls.push({ threadId: "codex_01" });
    return {
      kind: "not_available",
      payload: {
        type: "not_available",
        thread_id: "codex_01",
        reason: "pane output is unavailable for bridge mode"
      }
    };
  }

  unsubscribe(): boolean {
    return true;
  }

  registerPushCallback(callback: (threadId: string, chunk: string) => void): void {
    this.pushCallback = callback;
  }

  emitPush(threadId: string, chunk: string): void {
    this.pushCallback?.(threadId, chunk);
  }

  cleanupSocket(): void {
    return;
  }

  close(): void {
    return;
  }
}

class InspectableOutputBus extends OutputBus {
  readonly snapshots: Array<{ traceId: string; snapshot: string }> = [];

  override pushSnapshot(traceId: string, snapshot: string): void {
    this.snapshots.push({ traceId, snapshot });
    super.pushSnapshot(traceId, snapshot);
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

test("HubServer decodes bot-aware session targets for monitor completion delivery", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.attachedSessionsByThread.set("codex_01", ["777:chat-a"]);
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
  assert.equal(fakeResultSender.calls.length, 1);
  assert.equal(fakeResultSender.calls[0]?.replyChannel.chat_id, "chat-a");
  assert.equal(fakeResultSender.calls[0]?.replyChannel.bot_id, "777");
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
    {
      threadId: "codex_01",
      chatId: "chat-a",
      replyChannel: { channel: "telegram", chat_id: "chat-a" }
    },
    {
      threadId: "codex_01",
      chatId: "chat-b",
      replyChannel: { channel: "telegram", chat_id: "chat-b" }
    }
  ];
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender
  });

  await (server as unknown as { flushMonitorProgressUpdates: () => Promise<void> }).flushMonitorProgressUpdates();
  await (server as unknown as { flushMonitorProgressUpdates: () => Promise<void> }).flushMonitorProgressUpdates();

  assert.equal(fakeRouter.progressSnapshotCalls.length, 2);
  const expectedCalls = config.TELEGRAM_PUSH_WHITELIST_ONLY ? 0 : 2;
  assert.equal(fakeResultSender.calls.length, expectedCalls);
  if (expectedCalls > 0) {
    assert.ok(fakeResultSender.calls.every((entry) => entry.result.status === "partial"));
    assert.ok(fakeResultSender.calls.every((entry) => entry.result.content === "progress"));
    assert.deepEqual(
      fakeRouter.recordCalls,
      [{
        threadId: "codex_01",
        rawContent: "progress",
        traceId: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        eventKindHint: "progress"
      }]
    );
  }
});

test("HubServer adds reboot and kill buttons to agent_error alerts", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.attachedSessionsByThread.set("codex_01", ["chat-a"]);
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
        event_type: "agent_error",
        monitor_mode: "sse_hook",
        timestamp: new Date().toISOString(),
        error: "boom"
      })
    );

  assert.equal(result, null);
  assert.deepEqual(fakeResultSender.calls[0]?.result.telegram_inline_keyboard, {
    inline_keyboard: [[
      { text: "🔄 Reboot", callback_data: "hub:reboot:codex_01" },
      { text: "❌ Kill", callback_data: "hub:kill:codex_01" }
    ]]
  });
});

test("HubServer monitor alert includes agent_type, last_known_pid, and reason", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.attachedSessionsByThread.set("claude_01", ["chat-a"]);
  const fakeResultSender = new FakeResultSender();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender
  });

  await (server as unknown as { handleRawPayload: (raw: string) => Promise<HubResult | null> })
    .handleRawPayload(
      JSON.stringify({
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "claude_01",
        event_type: "agent_error",
        monitor_mode: "heartbeat",
        timestamp: new Date().toISOString(),
        agent_type: "claude",
        last_known_pid: 64339,
        error: "Heartbeat missed 3 consecutive checks",
        details: { reason: "HEALTHCHECK_TIMEOUT_PID_GONE" }
      })
    );

  assert.equal(fakeResultSender.calls.length, 1);
  const content = fakeResultSender.calls[0]?.result.content ?? "";
  assert.match(content, /agent_type=claude/);
  assert.match(content, /last_known_pid=64339/);
  assert.match(content, /reason=HEALTHCHECK_TIMEOUT_PID_GONE/);
  assert.match(content, /thread=claude_01/);
});

test("HubServer sends agent_error alert to /update subscribers even without attach", async () => {
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
        event_type: "agent_error",
        monitor_mode: "heartbeat",
        timestamp: new Date().toISOString(),
        error: "Process exited"
      })
    );

  assert.equal(result, null);
  assert.equal(fakeResultSender.calls.length, 1);
  assert.equal(fakeResultSender.calls[0]?.replyChannel.chat_id, "chat-update");
  assert.equal(fakeResultSender.calls[0]?.result.status, "error");
  assert.match(fakeResultSender.calls[0]?.result.content ?? "", /agent_error/);
});

test("resolveStaticServiceEndpoints returns coordinator registration only when fully configured", () => {
  const endpoints = resolveStaticServiceEndpoints({
    COORDINATOR_SOCKET_PATH: "/tmp/coordinator.sock",
    COORDINATOR_INTENTS: ["delegate", "plan"]
  } as never);

  assert.deepEqual(endpoints, [
    {
      service: "coordinator",
      socket_path: "/tmp/coordinator.sock",
      intents: ["delegate", "plan"]
    } satisfies ServiceEndpoint
  ]);
  assert.deepEqual(
    resolveStaticServiceEndpoints({
      COORDINATOR_SOCKET_PATH: "",
      COORDINATOR_INTENTS: ["delegate"]
    } as never),
    []
  );
});

test("HubServer routes subscribe_pane_output payloads through PaneBroadcaster", async () => {
  const paneBroadcaster = new FakePaneBroadcaster();
  const server = new HubServer({
    router: new FakeRouter() as unknown as HubRouter,
    resultSender: new FakeResultSender() as unknown as ResultSender,
    paneBroadcaster: paneBroadcaster as unknown as PaneBroadcaster
  });

  const writes: string[] = [];
  await (server as unknown as {
    handleSocketPayload: (
      socket: { writable: boolean; write: (chunk: string) => void; end: (chunk?: string) => void },
      raw: string,
      closeOnComplete: boolean
    ) => Promise<void>;
  }).handleSocketPayload(
    {
      writable: true,
      write: (chunk: string) => {
        writes.push(chunk);
      },
      end: (chunk?: string) => {
        if (chunk) {
          writes.push(chunk);
        }
      }
    },
    JSON.stringify({
      type: "subscribe_pane_output",
      thread_id: "codex_01"
    }),
    true
  );

  assert.deepEqual(paneBroadcaster.subscribeCalls, [{ threadId: "codex_01" }]);
  assert.equal(JSON.parse(writes[0] ?? "{}").type, "not_available");
});

test("HubServer routes approval pane pushes through OutputBus using the active trace id", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.pushSubscriptionsByThread.set("codex_01", [
    {
      chatId: "chat-push",
      replyChannel: { channel: "telegram", chat_id: "chat-push" }
    }
  ]);
  fakeRouter.activeRuns.add("codex_01");
  fakeRouter.activeRunTraceByThread.set("codex_01", "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8");

  const fakeResultSender = new FakeResultSender();
  const paneBroadcaster = new FakePaneBroadcaster();
  const outputBus = new InspectableOutputBus();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    paneBroadcaster: paneBroadcaster as unknown as PaneBroadcaster,
    outputBus
  });

  (server as unknown as { registerPushCallback: () => void }).registerPushCallback();
  const approvalFrame = [
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ Action Required                                                              │",
    "│                                                                              │",
    "│ ?  Shell git status && git remote -v && git log -n 3 [current working direc… │",
    "│                                                                              │",
    "│ git status && git remote -v && git log -n 3                                  │",
    "│ Allow execution of: 'git, git, git'?                                         │",
    "│                                                                              │",
    "│ ● 1. Allow once                                                              │",
    "│   2. Allow for this session                                                  │",
    "│   3. No, suggest changes (esc)                                               │",
    "│                                                                              │",
    "╰──────────────────────────────────────────────────────────────────────────────╯"
  ].join("\n");
  const approvalPrompt = classifyAgentOutput(approvalFrame);
  assert.equal(approvalPrompt.kind, "action_required");

  paneBroadcaster.emitPush("codex_01", approvalFrame);
  await (server as unknown as { flushPushAccumulator: (threadId: string) => Promise<void> }).flushPushAccumulator("codex_01");

  assert.deepEqual(outputBus.snapshots, [
    {
      traceId: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
      snapshot: approvalPrompt.text
    }
  ]);
  assert.equal(fakeResultSender.calls.length, 1);
  assert.equal(fakeResultSender.calls[0]?.result.trace_id, "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8");
  assert.equal(fakeResultSender.calls[0]?.replyChannel.chat_id, "chat-push");
  assert.match(fakeResultSender.calls[0]?.result.content ?? "", /^Waiting for approval\.\.\./);
  assert.deepEqual(fakeRouter.recordCalls, [
    {
      threadId: "codex_01",
      rawContent: approvalPrompt.text,
      traceId: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
      eventKindHint: "progress"
    }
  ]);
});

test("HubServer still suppresses non-approval pane pushes while a run is active", async () => {
  const fakeRouter = new FakeRouter();
  fakeRouter.pushSubscriptionsByThread.set("codex_01", [
    {
      chatId: "chat-push",
      replyChannel: { channel: "telegram", chat_id: "chat-push" }
    }
  ]);
  fakeRouter.activeRuns.add("codex_01");
  fakeRouter.activeRunTraceByThread.set("codex_01", "2f461d95-0157-4f90-bb4d-a63f2bfb1ed9");

  const fakeResultSender = new FakeResultSender();
  const paneBroadcaster = new FakePaneBroadcaster();
  const outputBus = new InspectableOutputBus();
  const server = new HubServer({
    router: fakeRouter as unknown as HubRouter,
    resultSender: fakeResultSender as unknown as ResultSender,
    paneBroadcaster: paneBroadcaster as unknown as PaneBroadcaster,
    outputBus
  });

  (server as unknown as { registerPushCallback: () => void }).registerPushCallback();
  paneBroadcaster.emitPush("codex_01", "Implemented the requested changes.");
  await (server as unknown as { flushPushAccumulator: (threadId: string) => Promise<void> }).flushPushAccumulator("codex_01");

  assert.deepEqual(outputBus.snapshots, []);
  assert.equal(fakeResultSender.calls.length, 0);
  assert.deepEqual(fakeRouter.recordCalls, []);
});
