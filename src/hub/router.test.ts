import assert from "node:assert/strict";
import { test } from "node:test";

import type { HubMessage } from "../types";
import { InstanceRegistry } from "./registry";
import { HubRouter } from "./router";

function baseMessage(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    thread_id: "codex_01",
    actor_id: "owner",
    intent: "run",
    target: "codex_01",
    payload: {
      content: "hello",
      attachments: []
    },
    mode: "bridge",
    reply_channel: {
      channel: "telegram",
      chat_id: "100"
    },
    ...overrides
  };
}

test("HubRouter routes run intent through AgentAPIClient", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  let connectedSocketPath = "";
  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async (socketPath: string) => {
        connectedSocketPath = socketPath;
      },
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "done" }),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await router.route(baseMessage());
  assert.equal(connectedSocketPath, "/tmp/agentapi-codex_01.sock");
  assert.equal(result.status, "success");
  assert.equal(result.source, "codex");
  assert.equal(result.content, "done");
});

test("HubRouter handles list intent", async () => {
  const router = new HubRouter(new InstanceRegistry(), {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await router.route(baseMessage({ intent: "list", target: "all", thread_id: "global" }));
  assert.equal(result.status, "success");
  assert.match(result.content, /No active agent instances/);
});

test("HubRouter returns error result when target thread is missing", async () => {
  const router = new HubRouter(new InstanceRegistry(), {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await router.route(baseMessage());
  assert.equal(result.status, "error");
  assert.match(result.content, /No registered agent instance/);
});
