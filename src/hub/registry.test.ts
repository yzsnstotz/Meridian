import assert from "node:assert/strict";
import { test } from "node:test";

import { InstanceRegistry } from "./registry";

test("InstanceRegistry tracks register, status updates, and removal", () => {
  const registry = new InstanceRegistry();
  const traceId = "22222222-2222-4222-8222-222222222222";
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 4321,
    status: "idle",
    created_at: new Date().toISOString(),
    spawn_trace_id: traceId
  });

  assert.equal(registry.has("codex_01"), true);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("codex_01")?.spawn_trace_id, traceId);

  registry.setStatus("codex_01", "running");
  assert.equal(registry.get("codex_01")?.status, "running");

  const removed = registry.unregister("codex_01");
  assert.equal(removed?.thread_id, "codex_01");
  assert.equal(removed?.spawn_trace_id, traceId);
  assert.equal(registry.has("codex_01"), false);
});

test("setAutoApprove updates and returns immutable copy", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "claude_01",
    agent_type: "claude",
    mode: "bridge",
    socket_path: "/tmp/agentapi-claude_01.sock",
    pid: 5678,
    status: "idle",
    auto_approve: false,
    created_at: new Date().toISOString()
  });

  assert.equal(registry.get("claude_01")?.auto_approve, false);

  const updated = registry.setAutoApprove("claude_01", true);
  assert.equal(updated?.auto_approve, true);
  assert.equal(registry.get("claude_01")?.auto_approve, true);

  const reverted = registry.setAutoApprove("claude_01", false);
  assert.equal(reverted?.auto_approve, false);
  assert.equal(registry.get("claude_01")?.auto_approve, false);
});

test("setAutoApprove returns undefined for unknown thread", () => {
  const registry = new InstanceRegistry();
  assert.equal(registry.setAutoApprove("nonexistent", true), undefined);
});

test("registry updates stream metadata without mutating identity", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 1234,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const streamEnabled = registry.setSupportsStream("codex_01", true);
  assert.equal(streamEnabled?.thread_id, "codex_01");
  assert.equal(streamEnabled?.agent_type, "codex");
  assert.equal(streamEnabled?.supportsStream, true);

  const sessionTracked = registry.setCodexSessionId("codex_01", "session-123");
  assert.equal(sessionTracked?.codexSessionId, "session-123");
  assert.equal(registry.get("codex_01")?.codexSessionId, "session-123");
});

test("setCaller updates last_caller and last_caller_at atomically", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 1234,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const caller = { caller_id: "meridian-web", caller_label: "Meridian Web" };
  const ts = new Date().toISOString();
  const updated = registry.setCaller("codex_01", caller, ts);

  assert.equal(updated?.last_caller?.caller_id, "meridian-web");
  assert.equal(updated?.last_caller?.caller_label, "Meridian Web");
  assert.equal(updated?.last_caller_at, ts);
  assert.equal(registry.get("codex_01")?.last_caller?.caller_id, "meridian-web");
  assert.equal(registry.get("codex_01")?.last_caller_at, ts);
});

test("setCaller returns undefined for unknown thread", () => {
  const registry = new InstanceRegistry();
  const caller = { caller_id: "meridian-web", caller_label: "Meridian Web" };
  assert.equal(registry.setCaller("nonexistent", caller, new Date().toISOString()), undefined);
});

test("setSpawnedBy sets spawned_by and returns updated instance", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 1234,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const caller = { caller_id: "meridian-roles", caller_label: "Meridian Roles" };
  const updated = registry.setSpawnedBy("codex_01", caller);

  assert.equal(updated?.spawned_by?.caller_id, "meridian-roles");
  assert.equal(registry.get("codex_01")?.spawned_by?.caller_id, "meridian-roles");
});

test("setSpawnedBy with undefined caller returns current instance without mutation", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 1234,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const result = registry.setSpawnedBy("codex_01", undefined);
  assert.equal(result?.spawned_by, undefined);
  assert.equal(result?.thread_id, "codex_01");
});
