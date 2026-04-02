import assert from "node:assert/strict";
import { test } from "node:test";

import { InstanceRegistry } from "./registry";

test("InstanceRegistry tracks register, status updates, and removal", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 4321,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  assert.equal(registry.has("codex_01"), true);
  assert.equal(registry.list().length, 1);

  registry.setStatus("codex_01", "running");
  assert.equal(registry.get("codex_01")?.status, "running");

  const removed = registry.unregister("codex_01");
  assert.equal(removed?.thread_id, "codex_01");
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
    tmux_pane: null,
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
    tmux_pane: null,
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
