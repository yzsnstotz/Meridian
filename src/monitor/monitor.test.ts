import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInstance } from "../types";
import { MonitorManager } from "./monitor";

process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY ??= "test-bootstrap-seed";

function buildInstance(overrides: Partial<AgentInstance> = {}): AgentInstance {
  return {
    thread_id: "codex_99",
    agent_type: "codex",
    model_id: "gpt-5.5",
    reasoning_effort: "high",
    sandbox_mode: "read-only",
    auto_approve: false,
    supportsStream: true,
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_99.sock",
    working_dir: "/tmp",
    pid: 1234,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString(),
    restart_safe: true,
    spawn_trace_id: null,
    ...overrides
  } as AgentInstance;
}

test("MonitorManager.register skips stateless_call instances (no agentapi socket to probe)", async () => {
  const connectCalls: string[] = [];
  const subscribeCalls: number[] = [];

  const manager = new MonitorManager({
    reporter: { report: async () => undefined },
    clientFactory: () => ({
      connect: async (socketPath: string) => {
        connectCalls.push(socketPath);
      },
      disconnect: () => undefined,
      subscribeEvents: () => {
        subscribeCalls.push(1);
        return { close: () => undefined } as never;
      },
      getStatus: async () => ({ status: "idle" } as never)
    })
  });

  manager.register(buildInstance({
    thread_id: "codex_stateless_42",
    mode: "stateless_call",
    socket_path: "stateless:codex_stateless_42",
    pid: 0
  }));

  // Allow any (intentionally absent) async startTask work to run.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connectCalls, [], "stateless instance must not trigger a socket connect");
  assert.deepEqual(subscribeCalls, [], "stateless instance must not subscribe to SSE events");
});

test("MonitorManager.register still attaches non-stateless instances", async () => {
  const connectCalls: string[] = [];

  const manager = new MonitorManager({
    reporter: { report: async () => undefined },
    clientFactory: () => ({
      connect: async (socketPath: string) => {
        connectCalls.push(socketPath);
      },
      disconnect: () => undefined,
      subscribeEvents: () => ({ close: () => undefined } as never),
      getStatus: async () => ({ status: "idle" } as never)
    })
  });

  manager.register(buildInstance({
    thread_id: "codex_bridge_77",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_bridge_77.sock"
  }));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connectCalls, ["/tmp/agentapi-codex_bridge_77.sock"]);

  manager.shutdown();
});
