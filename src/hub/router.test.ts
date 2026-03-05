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
  assert.equal(result.content, "[thread=codex_01]\ndone");
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

test("HubRouter returns updated agent screen content when transport response is ack-only", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:65481",
    pid: 101,
    tmux_pane: "agent_gemini_01",
    status: "idle",
    created_at: new Date().toISOString()
  });

  let callCount = 0;
  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ ok: true }),
      getStatus: async () => ({ status: "idle" }),
      getMessages: async () => {
        callCount += 1;
        if (callCount <= 1) {
          return [{ id: 7, role: "agent", content: "previous screen" }];
        }
        return [{ id: 7, role: "agent", content: "new output after run" }];
      }
    })
  });

  const result = await router.route(
    baseMessage({
      thread_id: "gemini_01",
      target: "gemini_01"
    })
  );

  assert.equal(result.status, "success");
  assert.equal(result.source, "gemini");
  assert.equal(result.content, "[thread=gemini_01]\nnew output after run");
});

test("HubRouter waits past transient spinner frames and returns stabilized reply", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:50730",
    pid: 101,
    tmux_pane: "agent_gemini_01",
    status: "idle",
    created_at: new Date().toISOString()
  });

  let callCount = 0;
  const spinnerFrame =
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n" +
    " ⠋ Let Node.js auto-configure memory (settings.json)… (esc to cancel, 0s)";
  const finalFrame = "✦ Hello! I'm Gemini CLI. How can I help?";

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ ok: true }),
      getStatus: async () => ({ status: "idle" }),
      getMessages: async () => {
        callCount += 1;
        if (callCount <= 1) {
          return [{ id: 10, role: "agent", content: "old frame" }];
        }
        if (callCount <= 3) {
          return [{ id: 11, role: "agent", content: spinnerFrame }];
        }
        return [{ id: 11, role: "agent", content: finalFrame }];
      }
    })
  });

  const result = await router.route(
    baseMessage({
      thread_id: "gemini_01",
      target: "gemini_01"
    })
  );

  assert.equal(result.status, "success");
  assert.equal(result.content, `[thread=gemini_01]\n${finalFrame}`);
});
