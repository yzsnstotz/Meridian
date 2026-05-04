import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  AgentInstanceSchema,
  BuiltInIntentSchema,
  CallerIdentitySchema,
  HubMessageSchema,
  HubResultSchema,
  IntentSchema,
  MonitorEventSchema,
  PaneOutputNotAvailableSchema,
  PaneOutputChunkSchema,
  PaneSubscribeRequestSchema,
  PaneUnsubscribeRequestSchema,
  ProviderCapabilityListSchema,
  ProviderCapabilitySchema,
  ServiceEndpointSchema,
  ThreadProgressSnapshotSchema
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

test("IntentSchema includes detach, reboot, gui, detail, and reply", () => {
  assert.equal(BuiltInIntentSchema.parse("detach"), "detach");
  assert.equal(BuiltInIntentSchema.parse("reboot"), "reboot");
  assert.equal(BuiltInIntentSchema.parse("gui"), "gui");
  assert.equal(BuiltInIntentSchema.parse("detail"), "detail");
  assert.equal(BuiltInIntentSchema.parse("reply"), "reply");
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

test("HubMessageSchema accepts stateless_call mode", () => {
  const parsed = HubMessageSchema.parse(buildHubMessage({ mode: "stateless_call" }));

  assert.equal(parsed.mode, "stateless_call");
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

test("HubMessageSchema parses optional spawn profile payload fields", () => {
  const parsed = HubMessageSchema.parse(
    buildHubMessage({
      intent: "spawn",
      target: "codex",
      payload: {
        content: "spawn",
        attachments: [],
        effort: "xhigh",
        auto_approve: true,
        integration_profile: "ads_public",
        sandbox_mode: "read-only"
      }
    })
  );

  assert.equal(parsed.payload.auto_approve, true);
  assert.equal(parsed.payload.effort, "xhigh");
  assert.equal(parsed.payload.integration_profile, "ads_public");
  assert.equal(parsed.payload.sandbox_mode, "read-only");
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

test("AgentInstanceSchema accepts optional stream capability fields", () => {
  const parsed = AgentInstanceSchema.parse({
    thread_id: "codex_01",
    agent_type: "codex",
    reasoning_effort: "high",
    mode: "bridge",
    socket_path: "/tmp/codex.sock",
    pid: 1234,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString(),
    supportsStream: true,
    codexSessionId: "session-123"
  });

  assert.equal(parsed.supportsStream, true);
  assert.equal(parsed.codexSessionId, "session-123");
  assert.equal(parsed.reasoning_effort, "high");
});

test("AgentInstanceSchema defaults auto_approve to true while honoring explicit false", () => {
  const defaultsApplied = AgentInstanceSchema.parse({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/codex.sock",
    pid: 1234,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString()
  });
  const explicitFalse = AgentInstanceSchema.parse({
    thread_id: "codex_02",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/codex-02.sock",
    pid: 1235,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString(),
    auto_approve: false
  });

  assert.equal(defaultsApplied.auto_approve, true);
  assert.equal(explicitFalse.auto_approve, false);
});

test("AgentInstanceSchema accepts optional integration_profile and sandbox_mode", () => {
  const parsed = AgentInstanceSchema.parse({
    thread_id: "codex_03",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/codex-03.sock",
    pid: 1236,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString(),
    integration_profile: "ads_public",
    sandbox_mode: "read-only"
  });

  assert.equal(parsed.integration_profile, "ads_public");
  assert.equal(parsed.sandbox_mode, "read-only");
});

test("AgentInstanceSchema accepts stateless_call mode", () => {
  const parsed = AgentInstanceSchema.parse({
    thread_id: "codex_04",
    agent_type: "codex",
    mode: "stateless_call",
    socket_path: "stateless:codex_04",
    pid: 0,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString(),
    supportsStream: true,
    sandbox_mode: "read-only"
  });

  assert.equal(parsed.mode, "stateless_call");
  assert.equal(parsed.socket_path, "stateless:codex_04");
});

test("ProviderCapabilitySchema parses ADS capability metadata", () => {
  const parsed = ProviderCapabilitySchema.parse({
    agent_type: "claude",
    supports_ads_safe: true,
    supports_read_only: true,
    supports_images: true,
    supports_text_files: true,
    supports_pdf: true,
    supports_stream_safe: true
  });

  assert.equal(parsed.agent_type, "claude");
  assert.equal(parsed.supports_stream_safe, true);
});

test("ProviderCapabilityListSchema parses multiple provider capability entries", () => {
  const parsed = ProviderCapabilityListSchema.parse([
    {
      agent_type: "codex",
      supports_ads_safe: true,
      supports_read_only: true,
      supports_images: false,
      supports_text_files: true,
      supports_pdf: false,
      supports_stream_safe: true
    },
    {
      agent_type: "gemini",
      supports_ads_safe: false,
      supports_read_only: false,
      supports_images: false,
      supports_text_files: false,
      supports_pdf: false,
      supports_stream_safe: false
    }
  ]);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]?.agent_type, "gemini");
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
      inline_keyboard: [[{ text: "Open GUI", url: "http://gui.example.com/?thread_id=claude_01" }]]
    },
    timestamp: new Date().toISOString()
  });

  assert.equal(parsed.telegram_inline_keyboard?.inline_keyboard[0]?.[0]?.text, "Open GUI");
});

test("HubResultSchema accepts optional structured progress snapshots", () => {
  const progress = ThreadProgressSnapshotSchema.parse({
    trace_id: randomUUID(),
    thread_id: "claude_01",
    source: "codex",
    status: "partial",
    event_kind: "progress",
    phase: "running",
    waiting_for_input: false,
    content: "Task is running...",
    display_text: "Task is running...",
    updated_at: new Date().toISOString()
  });

  const parsed = HubResultSchema.parse({
    trace_id: progress.trace_id,
    thread_id: "claude_01",
    source: "codex",
    status: "partial",
    content: progress.content,
    progress,
    attachments: [],
    timestamp: progress.updated_at
  });

  assert.equal(parsed.progress?.phase, "running");
  assert.equal(parsed.progress?.content, "Task is running...");
});

test("HubResultSchema accepts optional run-state metadata", () => {
  const parsed = HubResultSchema.parse({
    trace_id: randomUUID(),
    thread_id: "claude_01",
    source: "codex",
    status: "partial",
    run_state: "still_running",
    content: "Task is running...",
    attachments: [],
    timestamp: new Date().toISOString()
  });

  assert.equal(parsed.run_state, "still_running");
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

test("CallerIdentitySchema accepts valid caller_id without caller_label (wire-optionality)", () => {
  const parsed = CallerIdentitySchema.parse({ caller_id: "meridian-roles" });

  assert.equal(parsed.caller_id, "meridian-roles");
  assert.equal(parsed.caller_label, undefined);
  assert.equal(parsed.caller_version, undefined);
});

test("CallerIdentitySchema accepts full optional fields", () => {
  const parsed = CallerIdentitySchema.parse({
    caller_id: "my-service",
    caller_label: "My Service",
    caller_version: "1.0.0"
  });

  assert.equal(parsed.caller_id, "my-service");
  assert.equal(parsed.caller_label, "My Service");
  assert.equal(parsed.caller_version, "1.0.0");
});

test("CallerIdentitySchema rejects uppercase caller_id", () => {
  assert.throws(() => CallerIdentitySchema.parse({ caller_id: "MyService" }));
});

test("CallerIdentitySchema rejects caller_id starting with digit", () => {
  assert.throws(() => CallerIdentitySchema.parse({ caller_id: "1service" }));
});

test("CallerIdentitySchema rejects caller_id with dot or slash", () => {
  assert.throws(() => CallerIdentitySchema.parse({ caller_id: "my.service" }));
  assert.throws(() => CallerIdentitySchema.parse({ caller_id: "my/service" }));
});

test("BUILT_IN_INTENTS includes the four admin caller intents", () => {
  assert.equal(BuiltInIntentSchema.parse("register_caller"), "register_caller");
  assert.equal(BuiltInIntentSchema.parse("unregister_caller"), "unregister_caller");
  assert.equal(BuiltInIntentSchema.parse("rotate_caller_key"), "rotate_caller_key");
  assert.equal(BuiltInIntentSchema.parse("list_callers"), "list_callers");
});

test("HubMessageSchema parses without caller field (backward compat)", () => {
  const parsed = HubMessageSchema.parse(buildHubMessage());

  assert.equal(parsed.caller, undefined);
});

test("HubMessageSchema accepts optional caller field", () => {
  const parsed = HubMessageSchema.parse(
    buildHubMessage({
      caller: { caller_id: "my-service", caller_label: "My Service" }
    })
  );

  assert.equal(parsed.caller?.caller_id, "my-service");
  assert.equal(parsed.caller?.caller_label, "My Service");
});

test("AgentInstanceSchema parses without caller tracking fields (backward compat)", () => {
  const parsed = AgentInstanceSchema.parse({
    thread_id: "claude_05",
    agent_type: "claude",
    mode: "bridge",
    socket_path: "/tmp/claude.sock",
    pid: 9999,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  assert.equal(parsed.spawned_by, undefined);
  assert.equal(parsed.last_caller, undefined);
  assert.equal(parsed.last_caller_at, undefined);
});

test("AgentInstanceSchema accepts optional caller tracking fields", () => {
  const now = new Date().toISOString();
  const parsed = AgentInstanceSchema.parse({
    thread_id: "claude_06",
    agent_type: "claude",
    mode: "bridge",
    socket_path: "/tmp/claude-06.sock",
    pid: 8888,
    tmux_pane: null,
    status: "running",
    created_at: now,
    spawned_by: { caller_id: "web-gui" },
    last_caller: { caller_id: "my-service", caller_label: "My Service" },
    last_caller_at: now
  });

  assert.equal(parsed.spawned_by?.caller_id, "web-gui");
  assert.equal(parsed.last_caller?.caller_id, "my-service");
  assert.equal(parsed.last_caller_at, now);
});
