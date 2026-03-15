import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  BuiltInIntentSchema,
  HubMessageSchema,
  HubResultSchema,
  IntentSchema,
  MonitorEventSchema,
  PaneOutputNotAvailableSchema,
  PaneOutputChunkSchema,
  PaneSubscribeRequestSchema,
  PaneUnsubscribeRequestSchema,
  ServiceEndpointSchema
} from "./types";

function buildHubMessage(overrides: Record<string, unknown> = {}) {
  return {
    trace_id: randomUUID(),
    thread_id: "claude_01",
    actor_id: "tg:7",
    intent: "run",
    target: "claude_01",
    payload: {
      content: "hello",
      attachments: []
    },
    mode: "bridge",
    reply_channel: {
      channel: "telegram",
      chat_id: "telegram:12345"
    },
    ...overrides
  };
}

test("IntentSchema includes detach, reboot, gui, and detail", () => {
  assert.equal(BuiltInIntentSchema.parse("detach"), "detach");
  assert.equal(BuiltInIntentSchema.parse("reboot"), "reboot");
  assert.equal(BuiltInIntentSchema.parse("gui"), "gui");
  assert.equal(BuiltInIntentSchema.parse("detail"), "detail");
  assert.equal(IntentSchema.parse("delegate"), "delegate");
});

test("HubMessageSchema preserves backward compatibility and applies priority default", () => {
  const parsed = HubMessageSchema.parse(
    buildHubMessage({
      reply_channel: {
        channel: "telegram",
        chat_id: "12345"
      }
    })
  );

  assert.equal(parsed.reply_channel.chat_id, "12345");
  assert.equal(parsed.priority, 5);
  assert.equal(parsed.idempotency_key, undefined);
  assert.equal(parsed.span_id, undefined);
  assert.equal(parsed.parent_span_id, undefined);
});

test("HubMessageSchema parses new idempotency and tracing fields", () => {
  const spanId = randomUUID();
  const parentSpanId = randomUUID();
  const parsed = HubMessageSchema.parse(
    buildHubMessage({
      idempotency_key: "telegram:12345:67890",
      priority: 0,
      span_id: spanId,
      parent_span_id: parentSpanId,
      intent: "detach"
    })
  );

  assert.equal(parsed.idempotency_key, "telegram:12345:67890");
  assert.equal(parsed.priority, 0);
  assert.equal(parsed.span_id, spanId);
  assert.equal(parsed.parent_span_id, parentSpanId);
  assert.equal(parsed.intent, "detach");
});

test("MonitorEventSchema accepts optional span fields", () => {
  const spanId = randomUUID();
  const parentSpanId = randomUUID();
  const parsed = MonitorEventSchema.parse({
    trace_id: randomUUID(),
    thread_id: "claude_01",
    event_type: "task_completed",
    monitor_mode: "heartbeat",
    timestamp: new Date().toISOString(),
    span_id: spanId,
    parent_span_id: parentSpanId
  });

  assert.equal(parsed.span_id, spanId);
  assert.equal(parsed.parent_span_id, parentSpanId);
});

test("MonitorEventSchema accepts optional agent_type and last_known_pid", () => {
  const parsed = MonitorEventSchema.parse({
    trace_id: randomUUID(),
    thread_id: "claude_01",
    event_type: "agent_error",
    monitor_mode: "heartbeat",
    timestamp: new Date().toISOString(),
    agent_type: "claude",
    last_known_pid: 64339,
    error: "Heartbeat missed 3 consecutive checks",
    details: { reason: "HEALTHCHECK_TIMEOUT_PID_GONE" }
  });

  assert.equal(parsed.agent_type, "claude");
  assert.equal(parsed.last_known_pid, 64339);
  assert.equal(parsed.details?.reason, "HEALTHCHECK_TIMEOUT_PID_GONE");
});

test("HubResultSchema accepts optional Telegram inline keyboards", () => {
  const parsed = HubResultSchema.parse({
    trace_id: randomUUID(),
    thread_id: "claude_01",
    source: "codex",
    status: "success",
    content: "done",
    attachments: [],
    telegram_inline_keyboard: {
      inline_keyboard: [[{ text: "Open GUI", url: "http://gui.example.com/?thread=claude_01" }]]
    },
    timestamp: new Date().toISOString()
  });

  assert.equal(parsed.telegram_inline_keyboard?.inline_keyboard[0]?.[0]?.text, "Open GUI");
});

test("pane IPC schemas parse subscribe, output, and unsubscribe messages", () => {
  assert.equal(
    PaneSubscribeRequestSchema.parse({
      type: "subscribe_pane_output",
      thread_id: "claude_01",
      replay_lines: 200
    }).replay_lines,
    200
  );

  assert.equal(
    PaneOutputChunkSchema.parse({
      type: "pane_output",
      thread_id: "claude_01",
      chunk: "hello",
      timestamp: new Date().toISOString()
    }).chunk,
    "hello"
  );

  assert.equal(
    PaneOutputNotAvailableSchema.parse({
      type: "not_available",
      thread_id: "claude_01",
      reason: "pane output is unavailable for bridge mode"
    }).type,
    "not_available"
  );

  assert.equal(
    PaneUnsubscribeRequestSchema.parse({
      type: "unsubscribe_pane_output",
      thread_id: "claude_01"
    }).thread_id,
    "claude_01"
  );
});

test("ServiceEndpointSchema parses static service registrations", () => {
  const parsed = ServiceEndpointSchema.parse({
    service: "coordinator",
    socket_path: "/tmp/coordinator.sock",
    intents: ["delegate", "plan"],
    metadata: {
      owner: "hub"
    }
  });

  assert.equal(parsed.socket_path, "/tmp/coordinator.sock");
  assert.deepEqual(parsed.intents, ["delegate", "plan"]);
  assert.deepEqual(parsed.metadata, { owner: "hub" });
});
