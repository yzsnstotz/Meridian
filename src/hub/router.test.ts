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

test("HubRouter routes restart intent through InstanceManager", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "http://127.0.0.1:61010",
    pid: 10,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  let restartedThreadId = "";
  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    restart: async (threadId: string) => {
      restartedThreadId = threadId;
      return threadId;
    },
    getAttachedThread: () => null,
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-router-test-state.json"
  });

  const result = await router.route(baseMessage({ intent: "restart", target: "codex_01" }));
  assert.equal(restartedThreadId, "codex_01");
  assert.equal(result.status, "success");
  assert.match(result.content, /codex_01/);
});

test("HubRouter routes terminal_input through InstanceManager", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "cursor_01",
    agent_type: "cursor",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:61011",
    pid: 12,
    tmux_pane: "agent_cursor_01",
    status: "waiting",
    created_at: new Date().toISOString()
  });

  let sentThreadId = "";
  let sentInput = "";
  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    sendTerminalInput: (threadId: string, rawInput: string) => {
      sentThreadId = threadId;
      sentInput = rawInput;
      return `Sent approval action '${rawInput}' to ${threadId}.`;
    },
    getAttachedThread: () => "cursor_01",
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-router-test-state.json"
  });

  const result = await router.route(
    baseMessage({
      intent: "terminal_input",
      thread_id: "active",
      target: "active",
      payload: {
        content: "run",
        attachments: []
      },
      reply_channel: {
        channel: "telegram",
        chat_id: "100"
      }
    })
  );

  assert.equal(sentThreadId, "cursor_01");
  assert.equal(sentInput, "run");
  assert.equal(result.status, "success");
  assert.equal(result.source, "cursor");
  assert.equal(result.thread_id, "cursor_01");
});

test("HubRouter list omits stopped instances", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:61001",
    pid: 10,
    tmux_pane: "agent_codex_01",
    status: "stopped",
    created_at: new Date().toISOString()
  });
  registry.register({
    thread_id: "codex_02",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:61002",
    pid: 11,
    tmux_pane: "agent_codex_02",
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await router.route(baseMessage({ intent: "list", target: "all", thread_id: "global" }));
  assert.equal(result.status, "success");
  assert.match(result.content, /codex_02/);
  assert.doesNotMatch(result.content, /codex_01/);
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

test("HubRouter combines multi-part agent replies after run", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:61234",
    pid: 101,
    tmux_pane: "agent_codex_01",
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
        if (callCount === 1) {
          return [{ id: 1, role: "agent", content: "old response" }];
        }
        if (callCount <= 3) {
          return [
            { id: 1, role: "agent", content: "old response" },
            { id: 2, role: "agent", content: "part one" }
          ];
        }
        return [
          { id: 1, role: "agent", content: "old response" },
          { id: 2, role: "agent", content: "part one" },
          { id: 3, role: "agent", content: "part two" }
        ];
      }
    })
  });

  const result = await router.route(
    baseMessage({
      thread_id: "codex_01",
      target: "codex_01"
    })
  );

  assert.equal(result.status, "success");
  assert.equal(result.content, "[thread=codex_01]\npart one\n\npart two");
});

test("HubRouter normalizes monitor statuses before updating registry", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 42,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ ok: true }),
      getStatus: async () => ({ status: "running" })
    })
  });

  router.setInstanceStatus("codex_01", "stable");
  assert.equal(registry.get("codex_01")?.status, "waiting");

  router.setInstanceStatus("codex_01", "completed");
  assert.equal(registry.get("codex_01")?.status, "waiting");

  router.setInstanceStatus("codex_01", "invalid-status");
  assert.equal(registry.get("codex_01")?.status, "waiting");
});

test("HubRouter builds completion result from latest stable agent message", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 2048,
    tmux_pane: "agent_codex_01",
    status: "running",
    created_at: new Date().toISOString()
  });

  const spinnerFrame =
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n" +
    " ⠋ Let Node.js auto-configure memory (settings.json)… (esc to cancel, 0s)";

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ ok: true }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [
        { id: 1, role: "agent", content: "previous" },
        { id: 2, role: "agent", content: spinnerFrame },
        { id: 3, role: "agent", content: "final completion reply" }
      ]
    })
  });

  const result = await router.buildCompletionResultForThread(
    "codex_01",
    "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8"
  );

  assert.equal(result.status, "success");
  assert.equal(result.source, "codex");
  assert.equal(result.trace_id, "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8");
  assert.equal(result.content, "[thread=codex_01]\nfinal completion reply");
});

test("HubRouter enables and disables monitor updates via monitor_update intent", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [{ id: 1, role: "agent", content: "current output" }]
    })
  });

  const enableResult = await router.route(
    baseMessage({
      intent: "monitor_update",
      target: "codex_01",
      payload: {
        content: "/update on interval=30",
        attachments: [],
        monitor_updates_enabled: true,
        monitor_updates_interval_sec: 30
      }
    })
  );
  assert.equal(enableResult.status, "success");
  assert.match(enableResult.content, /turned ON/);
  assert.deepEqual(router.getMonitorUpdateSubscribersForThread("codex_01"), ["100"]);

  const due = router.collectDueMonitorUpdateDispatches(Date.now());
  assert.equal(due.length, 1);
  assert.equal(due[0]?.threadId, "codex_01");
  assert.equal(due[0]?.chatId, "100");

  const disableResult = await router.route(
    baseMessage({
      intent: "monitor_update",
      target: "codex_01",
      payload: {
        content: "/update off",
        attachments: [],
        monitor_updates_enabled: false
      }
    })
  );
  assert.equal(disableResult.status, "success");
  assert.match(disableResult.content, /turned OFF/);
  assert.deepEqual(router.getMonitorUpdateSubscribersForThread("codex_01"), []);
});

test("HubRouter keeps bot_id on monitor update dispatch targets", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [{ id: 1, role: "agent", content: "current output" }]
    })
  });

  const enableResult = await router.route(
    baseMessage({
      intent: "monitor_update",
      target: "codex_01",
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      },
      payload: {
        content: "/update on interval=30",
        attachments: [],
        monitor_updates_enabled: true,
        monitor_updates_interval_sec: 30
      }
    })
  );

  assert.equal(enableResult.status, "success");
  assert.deepEqual(router.getMonitorUpdateSubscribersForThread("codex_01"), ["777:100"]);
  const due = router.collectDueMonitorUpdateDispatches(Date.now());
  assert.equal(due.length, 1);
  assert.equal(due[0]?.threadId, "codex_01");
  assert.equal(due[0]?.chatId, "100");
  assert.equal(due[0]?.botId, "777");
});

test("HubRouter stores attach bindings with bot-aware session key", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" })
    })
  });

  const result = await router.route(
    baseMessage({
      intent: "attach",
      target: "codex_01",
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      }
    })
  );

  assert.equal(result.status, "success");
  assert.deepEqual(router.getAttachedSessionsForThread("codex_01"), ["777:100"]);
});

test("HubRouter list includes attachment owner and attachability by bot interface", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" })
    })
  });

  const ownerAttachResult = await router.route(
    baseMessage({
      intent: "attach",
      target: "codex_01",
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      }
    })
  );
  assert.equal(ownerAttachResult.status, "success");

  const ownerListResult = await router.route(
    baseMessage({
      intent: "list",
      target: "all",
      thread_id: "global",
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      }
    })
  );
  assert.equal(ownerListResult.status, "success");
  const ownerList = JSON.parse(ownerListResult.content) as Array<Record<string, unknown>>;
  assert.equal(ownerList[0]?.attached, true);
  assert.equal(ownerList[0]?.attached_interface, "777");
  assert.equal(ownerList[0]?.attachable, true);

  const otherListResult = await router.route(
    baseMessage({
      intent: "list",
      target: "all",
      thread_id: "global",
      reply_channel: {
        channel: "telegram",
        chat_id: "200",
        bot_id: "888"
      }
    })
  );
  assert.equal(otherListResult.status, "success");
  const otherList = JSON.parse(otherListResult.content) as Array<Record<string, unknown>>;
  assert.equal(otherList[0]?.attached, true);
  assert.equal(otherList[0]?.attached_interface, "777");
  assert.equal(otherList[0]?.attachable, false);
});

test("HubRouter rejects cross-interface attach for already attached thread", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: null,
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" })
    })
  });

  const firstAttachResult = await router.route(
    baseMessage({
      intent: "attach",
      target: "codex_01",
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      }
    })
  );
  assert.equal(firstAttachResult.status, "success");

  const crossInterfaceAttachResult = await router.route(
    baseMessage({
      intent: "attach",
      target: "codex_01",
      reply_channel: {
        channel: "telegram",
        chat_id: "200",
        bot_id: "888"
      }
    })
  );
  assert.equal(crossInterfaceAttachResult.status, "error");
  assert.match(crossInterfaceAttachResult.content, /already attached to interface=777/);
});

test("HubRouter builds monitor progress result from latest agent output", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: "agent_codex_01",
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [
        { id: 1, role: "agent", content: "old output" },
        { id: 2, role: "agent", content: "live pane output" }
      ]
    })
  });

  const result = await router.buildProgressResultForThread(
    "codex_01",
    "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8"
  );
  assert.equal(result.status, "partial");
  assert.equal(result.content, "[thread=codex_01]\nlive pane output");
});

test("HubRouter returns one-time manual monitor update without subscribing", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 101,
    tmux_pane: "agent_codex_01",
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [{ id: 1, role: "agent", content: "manual snapshot" }]
    })
  });

  const result = await router.route(
    baseMessage({
      intent: "monitor_manual_update",
      target: "codex_01",
      payload: {
        content: "/mupdate thread=codex_01",
        attachments: []
      }
    })
  );

  assert.equal(result.status, "partial");
  assert.equal(result.content, "[thread=codex_01]\nmanual snapshot");
  assert.deepEqual(router.getMonitorUpdateSubscribersForThread("codex_01"), []);
});
