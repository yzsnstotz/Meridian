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
