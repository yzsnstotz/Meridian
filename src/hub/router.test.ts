import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LOG_DIR ??= "/tmp/meridian-test-logs";

import { config } from "../config";
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

test("HubRouter detail reuses conversation history details produced for pane/chat", async () => {
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

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "final answer" }),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const runTraceId = "81f8b79e-b32f-44e7-8f07-6f1f4be8f2f7";
  await router.route(
    baseMessage({
      trace_id: runTraceId,
      thread_id: "codex_01",
      target: "codex_01",
      payload: {
        content: "ship it",
        attachments: []
      }
    })
  );

  const detailResult = await router.route(
    baseMessage({
      trace_id: "6b0cc95f-85e9-49eb-b18b-3e5f3fa0ed06",
      intent: "detail",
      thread_id: "codex_01",
      target: "codex_01",
      payload: {
        content: runTraceId,
        attachments: []
      }
    })
  );

  assert.equal(detailResult.status, "success");
  assert.match(detailResult.content, /Your message:\nship it/);
  assert.match(detailResult.content, /Agent reply:\nfinal answer/);
});

test("HubRouter run logs getMessages_threw and uses fallback when getMessages() throws", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "bridge",
    socket_path: "/tmp/agentapi-gemini_01.sock",
    pid: 201,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ ok: true }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => {
        throw new Error("HTTP 404 returned for GET /messages");
      }
    })
  });

  const result = await router.route(
    baseMessage({
      trace_id: "dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d",
      thread_id: "gemini_01",
      target: "gemini_01"
    })
  );
  assert.equal(result.status, "success");
  assert.equal(result.source, "gemini");
  assert.equal(
    result.content,
    "Agent is processing...",
    "fallback content should surface a neutral progress message when getMessages() throws on an ACK response"
  );
});

test("HubRouter forwards agent response files as HubResult attachments", async () => {
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

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({
        content: "done",
        files: [
          "/tmp/output.txt",
          {
            path: "/tmp/app.ts",
            name: "app.ts",
            mimeType: "text/plain"
          }
        ]
      }),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await router.route(baseMessage());
  assert.deepEqual(result.attachments, [
    { path: "/tmp/output.txt" },
    { path: "/tmp/app.ts", filename: "app.ts", mime_type: "text/plain" }
  ]);
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

test("HubRouter routes reboot intent through InstanceManager.restart", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 10,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  let rebootedThreadId = "";
  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    restart: async (threadId: string) => {
      rebootedThreadId = threadId;
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

  const result = await router.route(baseMessage({ intent: "reboot", target: "codex_01" }));
  assert.equal(rebootedThreadId, "codex_01");
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

test("HubRouter returns provider model catalog through InstanceManager", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    model_id: "gpt-5.4",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 20,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  let listedThreadId = "";
  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    listModels: async (threadId: string) => {
      listedThreadId = threadId;
      return {
        thread_id: threadId,
        provider: "codex",
        current_model_id: "gpt-5.4",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4" },
          { id: "codex-5.3-max", label: "Codex-5.3-Max" }
        ]
      };
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

  const result = await router.route(baseMessage({ intent: "list_models", target: "codex_01" }));

  assert.equal(listedThreadId, "codex_01");
  assert.equal(result.status, "success");
  assert.equal(result.source, "codex");
  assert.match(result.content, /codex-5\.3-max/);
});

test("HubRouter switches provider model using payload content", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    model_id: "gpt-5",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 21,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  let switchedThreadId = "";
  let switchedModelId = "";
  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    switchModel: async (threadId: string, modelId: string) => {
      switchedThreadId = threadId;
      switchedModelId = modelId;
      registry.register({
        thread_id: threadId,
        agent_type: "codex",
        model_id: modelId,
        mode: "bridge",
        socket_path: "/tmp/agentapi-codex_01.sock",
        pid: 22,
        tmux_pane: null,
        status: "idle",
        created_at: new Date().toISOString()
      });
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

  const result = await router.route(
    baseMessage({
      intent: "switch_model",
      target: "codex_01",
      payload: {
        content: "codex-5.3-max",
        attachments: []
      }
    })
  );

  assert.equal(switchedThreadId, "codex_01");
  assert.equal(switchedModelId, "codex-5.3-max");
  assert.equal(result.status, "success");
  assert.equal(result.source, "codex");
  assert.match(result.content, /codex-5\.3-max/);
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
  assert.equal(result.content, "new output after run");
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
  assert.equal(result.content, `${finalFrame}`);
});

test("HubRouter prefers Gemini edit approval over transient POST /message chrome", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:50731",
    pid: 101,
    tmux_pane: "agent_gemini_01",
    status: "idle",
    created_at: new Date().toISOString()
  });

  let callCount = 0;
  const editApprovalFrame = [
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ Action Required                                                              │",
    "│                                                                              │",
    "│ ?  Edit .gitignore: .context/ => .context/                                   │",
    "│                                                                              │",
    "│ 5   .DS_Store                                                                │",
    "│ 6   bin/agentapi                                                             │",
    "│ 7   .context/                                                                │",
    "│ 8 + docs/                                                                    │",
    "│ Apply this change?                                                           │",
    "│                                                                              │",
    "│ ● 1. Allow once                                                              │",
    "│   2. Allow for this session                                                  │",
    "│   3. Modify with external editor                                             │",
    "│   4. No, suggest changes (esc)                                               │",
    "│                                                                              │",
    "╰──────────────────────────────────────────────────────────────────────────────╯"
  ].join("\n");

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "Press Ctrl+O to expand pasted text                            1 GEMINI.md file" }),
      getStatus: async () => ({ status: "idle" }),
      getMessages: async () => {
        callCount += 1;
        if (callCount <= 1) {
          return [{ id: 40, role: "agent", content: "old frame" }];
        }
        return [{ id: 41, role: "agent", content: editApprovalFrame }];
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
  assert.match(result.content, /^Waiting for approval\.\.\./);
  assert.match(result.content, /Apply this change\?/);
  assert.doesNotMatch(result.content, /Press Ctrl\+O to expand pasted text/);
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
  // Only the latest new snapshot is returned to avoid leaking older conversation
  // segments into the result (fixes stale memo / unrelated reply issue).
  assert.equal(result.content, "part two");
});

test("HubRouter run returns only the latest complete summary block for current trace", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:61111",
    pid: 201,
    tmux_pane: "agent_gemini_01",
    status: "idle",
    created_at: new Date().toISOString()
  });

  const traceId = "dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d";
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
          return [{ id: 1, role: "agent", content: "old output" }];
        }
        if (callCount === 2) {
          return [
            {
              id: 2,
              role: "agent",
              content:
                "[[MERIDIAN_SUMMARY_BEGIN id=11111111-1111-1111-1111-111111111111]]\nold trace\n[[MERIDIAN_SUMMARY_END id=11111111-1111-1111-1111-111111111111]]"
            }
          ];
        }
        return [
          {
            id: 3,
            role: "agent",
            content:
              "[[MERIDIAN_SUMMARY_BEGIN id=dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d]]\nfirst\n[[MERIDIAN_SUMMARY_END id=dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d]]\n" +
              "[[MERIDIAN_SUMMARY_BEGIN id=dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d]]\nfinal answer\n[[MERIDIAN_SUMMARY_END id=dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d]]"
          }
        ];
      }
    })
  });

  const result = await router.route(
    baseMessage({
      trace_id: traceId,
      thread_id: "gemini_01",
      target: "gemini_01"
    })
  );

  assert.equal(result.status, "success");
  assert.equal(result.content, "final answer");
});

test("HubRouter run ignores incomplete summary block and falls back to stable reply", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:61112",
    pid: 202,
    tmux_pane: "agent_gemini_01",
    status: "idle",
    created_at: new Date().toISOString()
  });

  const traceId = "dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99e";
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
          return [{ id: 1, role: "agent", content: "old output" }];
        }
        if (callCount === 2) {
          return [
            {
              id: 2,
              role: "agent",
              content:
                "[[MERIDIAN_SUMMARY_BEGIN id=dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99e]]\nstreaming..."
            }
          ];
        }
        return [{ id: 3, role: "agent", content: "stable fallback output" }];
      }
    })
  });

  const result = await router.route(
    baseMessage({
      trace_id: traceId,
      thread_id: "gemini_01",
      target: "gemini_01"
    })
  );

  assert.equal(result.status, "success");
  assert.equal(result.content, "stable fallback output");
});

test("HubRouter run fallback does not reuse stale snapshot from before current run", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "http://127.0.0.1:61113",
    pid: 203,
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
        // Never produce a new agent reply for this run.
        return [{ id: 5, role: "agent", content: "stale old snapshot before run" }];
      }
    })
  });

  const result = await router.route(
    baseMessage({
      trace_id: "dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99f",
      thread_id: "gemini_01",
      target: "gemini_01"
    })
  );

  assert.equal(result.status, "success");
  assert.match(result.content, /Agent is processing/);
  assert.doesNotMatch(result.content, /stale old snapshot/);
  assert.ok(callCount <= 5, `expected stale polling to bail out quickly, got ${callCount} getMessages() calls`);
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
  const previousHost = config.WEB_GUI_HOST;
  const previousPort = config.WEB_GUI_PORT;
  const previousToken = config.WEB_GUI_TOKEN;
  const previousHttps = config.WEB_GUI_HTTPS;
  config.WEB_GUI_HOST = "gui.example.com";
  config.WEB_GUI_PORT = 3000;
  config.WEB_GUI_TOKEN = "secret-token";
  config.WEB_GUI_HTTPS = false;

  try {
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
    assert.equal(result.content, "final completion reply");
    assert.deepEqual(result.telegram_inline_keyboard, {
      inline_keyboard: [[{ text: "🖥 打开 GUI", url: "http://gui.example.com:3000/?thread=codex_01&token=secret-token" }]]
    });
  } finally {
    config.WEB_GUI_HOST = previousHost;
    config.WEB_GUI_PORT = previousPort;
    config.WEB_GUI_TOKEN = previousToken;
    config.WEB_GUI_HTTPS = previousHttps;
  }
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

test("HubRouter includes attached chat and bot labels in thread command responses", async () => {
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

  const attachResult = await router.route(
    baseMessage({
      intent: "attach",
      target: "codex_01",
      reply_channel: {
        channel: "telegram",
        chat_id: "telegram:-10001",
        bot_id: "777",
        chat_name: "Ops Room",
        bot_name: "@meridian_ops_bot"
      }
    })
  );

  assert.equal(attachResult.status, "success");
  assert.match(attachResult.content, /Attached chat sessions:/);
  assert.match(attachResult.content, /Ops Room via @meridian_ops_bot/);

  const listResult = await router.route(
    baseMessage({
      intent: "list",
      target: "all",
      thread_id: "global",
      reply_channel: {
        channel: "telegram",
        chat_id: "telegram:-10001",
        bot_id: "777"
      }
    })
  );

  assert.equal(listResult.status, "success");
  const listed = JSON.parse(listResult.content) as Array<Record<string, unknown>>;
  const labels = listed[0]?.attached_labels as string[] | undefined;
  assert.ok(Array.isArray(labels));
  assert.match(labels?.[0] ?? "", /Ops Room via @meridian_ops_bot/);
});

test("HubRouter detaches the current session from its thread", async () => {
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

  const attachResult = await router.route(
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
  assert.equal(attachResult.status, "success");

  const detachResult = await router.route(
    baseMessage({
      intent: "detach",
      target: "active",
      thread_id: "active",
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      }
    })
  );
  assert.equal(detachResult.status, "success");
  assert.equal(detachResult.thread_id, "codex_01");
  assert.deepEqual(router.getAttachedSessionsForThread("codex_01"), []);

  const missingActiveResult = await router.route(
    baseMessage({
      intent: "run",
      target: "active",
      thread_id: "active",
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      }
    })
  );
  assert.equal(missingActiveResult.status, "error");
  assert.match(missingActiveResult.content, /No thread is attached/);
});

test("HubRouter returns a clickable Web GUI link", async () => {
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

  const previousHost = config.WEB_GUI_HOST;
  const previousPort = config.WEB_GUI_PORT;
  const previousToken = config.WEB_GUI_TOKEN;
  const previousHttps = config.WEB_GUI_HTTPS;
  config.WEB_GUI_HOST = "gui.example.com";
  config.WEB_GUI_PORT = 3000;
  config.WEB_GUI_TOKEN = "secret-token";
  config.WEB_GUI_HTTPS = false;

  try {
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
        intent: "gui",
        target: "codex_01"
      })
    );

    assert.equal(result.status, "success");
    assert.equal(result.content, "http://gui.example.com:3000/?thread=codex_01&token=secret-token");
  } finally {
    config.WEB_GUI_HOST = previousHost;
    config.WEB_GUI_PORT = previousPort;
    config.WEB_GUI_TOKEN = previousToken;
    config.WEB_GUI_HTTPS = previousHttps;
  }
});

test("HubRouter attach result includes a Web GUI button when available", async () => {
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

  const previousHost = config.WEB_GUI_HOST;
  const previousPort = config.WEB_GUI_PORT;
  const previousToken = config.WEB_GUI_TOKEN;
  const previousHttps = config.WEB_GUI_HTTPS;
  config.WEB_GUI_HOST = "gui.example.com";
  config.WEB_GUI_PORT = 3000;
  config.WEB_GUI_TOKEN = "secret-token";
  config.WEB_GUI_HTTPS = false;

  try {
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
        target: "codex_01"
      })
    );

    assert.deepEqual(result.telegram_inline_keyboard, {
      inline_keyboard: [[{ text: "🖥 打开 GUI", url: "http://gui.example.com:3000/?thread=codex_01&token=secret-token" }]]
    });
  } finally {
    config.WEB_GUI_HOST = previousHost;
    config.WEB_GUI_PORT = previousPort;
    config.WEB_GUI_TOKEN = previousToken;
    config.WEB_GUI_HTTPS = previousHttps;
  }
});

test("HubRouter spawn result includes a Web GUI button when available", async () => {
  const registry = new InstanceRegistry();
  let spawnedThreadId = "";
  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    spawn: async () => {
      spawnedThreadId = "codex_01";
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
      return spawnedThreadId;
    },
    attach: () => ({ thread_id: "codex_01", session_id: "777:100" }),
    getAttachedThread: () => null,
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: ["777:100"], interface_id: "777" }),
    isThreadAttachableBySession: () => true
  };

  const previousHost = config.WEB_GUI_HOST;
  const previousPort = config.WEB_GUI_PORT;
  const previousToken = config.WEB_GUI_TOKEN;
  const previousHttps = config.WEB_GUI_HTTPS;
  config.WEB_GUI_HOST = "gui.example.com";
  config.WEB_GUI_PORT = 3000;
  config.WEB_GUI_TOKEN = "secret-token";
  config.WEB_GUI_HTTPS = false;

  try {
    const router = new HubRouter(registry, {
      instanceManager: fakeInstanceManager as never,
      statePath: "/tmp/meridian-router-test-state.json"
    });

    const result = await router.route(
      baseMessage({
        intent: "spawn",
        thread_id: "pending",
        target: "codex",
        reply_channel: {
          channel: "telegram",
          chat_id: "100",
          bot_id: "777"
        }
      })
    );

    assert.equal(spawnedThreadId, "codex_01");
    assert.deepEqual(result.telegram_inline_keyboard, {
      inline_keyboard: [[{ text: "🖥 打开 GUI", url: "http://gui.example.com:3000/?thread=codex_01&token=secret-token" }]]
    });
  } finally {
    config.WEB_GUI_HOST = previousHost;
    config.WEB_GUI_PORT = previousPort;
    config.WEB_GUI_TOKEN = previousToken;
    config.WEB_GUI_HTTPS = previousHttps;
  }
});

test("HubRouter forwards auto_approve on spawn", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: Array<{
    type: string;
    mode: string;
    workingDirectory: string | undefined;
    modelId: string | undefined;
    autoApprove: boolean | undefined;
  }> = [];

  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    spawn: async (
      type: string,
      mode: string,
      workingDirectory?: string,
      modelId?: string,
      autoApprove?: boolean
    ) => {
      spawnCalls.push({ type, mode, workingDirectory, modelId, autoApprove });
      registry.register({
        thread_id: "codex_01",
        agent_type: "codex",
        mode: "bridge",
        socket_path: "/tmp/agentapi-codex_01.sock",
        pid: 101,
        tmux_pane: null,
        status: "idle",
        created_at: new Date().toISOString(),
        auto_approve: autoApprove ?? false
      });
      return "codex_01";
    },
    attach: () => ({ thread_id: "codex_01", session_id: "777:100" }),
    getAttachedThread: () => null,
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: ["777:100"], interface_id: "777" }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-router-test-state.json"
  });

  const result = await router.route(
    baseMessage({
      intent: "spawn",
      thread_id: "pending",
      target: "codex",
      payload: {
        content: "spawn",
        attachments: [],
        auto_approve: true
      },
      reply_channel: {
        channel: "telegram",
        chat_id: "100",
        bot_id: "777"
      }
    })
  );

  assert.equal(result.status, "success");
  assert.deepEqual(spawnCalls, [
    {
      type: "codex",
      mode: "bridge",
      workingDirectory: undefined,
      modelId: undefined,
      autoApprove: true
    }
  ]);
  assert.equal(registry.get("codex_01")?.auto_approve, true);
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
  assert.equal(result.content, "live pane output");
  assert.equal(result.progress?.phase, "running");
  assert.equal(result.progress?.event_kind, "progress");
  assert.equal(result.progress?.waiting_for_input, false);
  assert.equal(result.progress?.display_text, "live pane output");
});

test("HubRouter keeps the latest stable progress reply when the newest frame is transient", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-gemini_01.sock",
    pid: 101,
    tmux_pane: "agent_gemini_01",
    status: "running",
    created_at: new Date().toISOString()
  });

  const transientFrame =
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n" +
    " ⠼ List your saved chat checkpoints with /chat list… (esc to cancel, 6s)";

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [
        { id: 1, role: "agent", content: "older output" },
        { id: 2, role: "agent", content: "actual stable reply" },
        { id: 3, role: "agent", content: transientFrame }
      ]
    })
  });

  const result = await router.buildProgressResultForThread(
    "gemini_01",
    "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8"
  );

  assert.equal(result.status, "partial");
  assert.equal(result.content, "actual stable reply");
  assert.equal(result.progress?.content, "actual stable reply");
  assert.equal(result.progress?.phase, "running");
});

test("HubRouter normalizes pane action-required frames into compact actionable content", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-gemini_01.sock",
    pid: 101,
    tmux_pane: "agent_gemini_01",
    status: "running",
    created_at: new Date().toISOString()
  });

  const actionRequiredFrame = [
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

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [{ id: 1, role: "agent", content: actionRequiredFrame }]
    })
  });

  const result = await router.buildProgressResultForThread(
    "gemini_01",
    "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8"
  );

  assert.equal(result.status, "partial");
  assert.match(result.content, /^Waiting for approval\.\.\./);
  assert.match(result.content, /Run this command\?/);
  assert.match(result.content, /git status && git remote -v && git log -n 3/);
  assert.doesNotMatch(result.content, /╭|╰|│/);
  assert.equal(result.progress?.phase, "waiting_for_input");
  assert.equal(result.progress?.event_kind, "approval");
  assert.equal(result.progress?.waiting_for_input, true);
});

test("HubRouter normalizes Gemini edit approval frames into compact actionable content", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "gemini_01",
    agent_type: "gemini",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-gemini_01.sock",
    pid: 101,
    tmux_pane: "agent_gemini_01",
    status: "running",
    created_at: new Date().toISOString()
  });

  const actionRequiredFrame = [
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ Action Required                                                              │",
    "│                                                                              │",
    "│ ?  Edit .gitignore: .context/ => .context/                                   │",
    "│                                                                              │",
    "│ 5   .DS_Store                                                                │",
    "│ 6   bin/agentapi                                                             │",
    "│ 7   .context/                                                                │",
    "│ 8 + docs/                                                                    │",
    "│ Apply this change?                                                           │",
    "│                                                                              │",
    "│ ● 1. Allow once                                                              │",
    "│   2. Allow for this session                                                  │",
    "│   3. Modify with external editor                                             │",
    "│   4. No, suggest changes (esc)                                               │",
    "│                                                                              │",
    "╰──────────────────────────────────────────────────────────────────────────────╯"
  ].join("\n");

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => [{ id: 1, role: "agent", content: actionRequiredFrame }]
    })
  });

  const result = await router.buildProgressResultForThread(
    "gemini_01",
    "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8"
  );

  assert.equal(result.status, "partial");
  assert.match(result.content, /^Waiting for approval\.\.\./);
  assert.match(result.content, /Apply this change\?/);
  assert.match(result.content, /Edit \.gitignore: \.context\/ => \.context\//);
  assert.match(result.content, /4\.\s*No, suggest changes/);
  assert.doesNotMatch(result.content, /╭|╰|│/);
  assert.equal(result.progress?.phase, "waiting_for_input");
  assert.equal(result.progress?.event_kind, "approval");
  assert.equal(result.progress?.waiting_for_input, true);
});

test("HubRouter falls back to canonical pending history for structured progress snapshots", async () => {
  const registry = new InstanceRegistry();
  const traceId = "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8";
  registry.register({
    thread_id: "codex_02",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-codex_02.sock",
    pid: 101,
    tmux_pane: "agent_codex_02",
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "running" }),
      getMessages: async () => []
    })
  });

  router.recordAgentPushConversation("codex_02", "Still running...", traceId);

  const result = await router.buildProgressResultForThread("codex_02", traceId);

  assert.equal(result.status, "partial");
  assert.equal(result.content, "Still running...");
  assert.equal(result.progress?.trace_id, traceId);
  assert.equal(result.progress?.content, "Still running...");
  assert.equal(result.progress?.phase, "running");
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
  assert.equal(result.content, "manual snapshot");
  assert.deepEqual(router.getMonitorUpdateSubscribersForThread("codex_01"), []);
});

test("HubRouter handlePush enables and disables push for pane_bridge instance", async () => {
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
      sendMessage: async () => ({}),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const enableResult = await router.route(
    baseMessage({
      intent: "push",
      target: "codex_01",
      payload: { content: "", attachments: [], push_enabled: true },
      reply_channel: { channel: "telegram", chat_id: "100", bot_id: "999" }
    })
  );
  assert.equal(enableResult.status, "success");
  assert.match(enableResult.content, /ON/);

  const subs = router.getPushSubscriptionsForThread("codex_01");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].chatId, "100");

  const disableResult = await router.route(
    baseMessage({
      intent: "push",
      target: "codex_01",
      payload: { content: "", attachments: [], push_enabled: false },
      reply_channel: { channel: "telegram", chat_id: "100", bot_id: "999" }
    })
  );
  assert.equal(disableResult.status, "success");
  assert.match(disableResult.content, /OFF/);
  assert.equal(router.getPushSubscriptionsForThread("codex_01").length, 0);
});

test("HubRouter handlePush queries status when push_enabled is not set", async () => {
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
      sendMessage: async () => ({}),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const queryResult = await router.route(
    baseMessage({
      intent: "push",
      target: "codex_01",
      payload: { content: "", attachments: [] },
      reply_channel: { channel: "telegram", chat_id: "100" }
    })
  );
  assert.equal(queryResult.status, "success");
  assert.match(queryResult.content, /OFF/);
});

test("HubRouter handlePush rejects bridge mode instances", async () => {
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

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({}),
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await router.route(
    baseMessage({
      intent: "push",
      target: "codex_01",
      payload: { content: "", attachments: [], push_enabled: true },
      reply_channel: { channel: "telegram", chat_id: "100" }
    })
  );
  assert.equal(result.status, "error");
  assert.match(result.content, /pane_bridge/);
});

test("HubRouter exposes conversation history after a run", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "history_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-history_01.sock",
    pid: 901,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "ack" }),
      getStatus: async () => ({ status: "idle" }),
      getMessages: async () => [
        {
          id: 1,
          role: "agent",
          content:
            "[[MERIDIAN_SUMMARY_BEGIN id=2f461d95-0157-4f90-bb4d-a63f2bfb1ed8]]done[[MERIDIAN_SUMMARY_END id=2f461d95-0157-4f90-bb4d-a63f2bfb1ed8]]"
        }
      ]
    })
  });

  await router.route(
    baseMessage({
      trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
      thread_id: "history_01",
      target: "history_01",
      intent: "run",
      payload: { content: "ship it", attachments: [] }
    })
  );

  const historyResult = await router.route(
    baseMessage({
      intent: "history",
      thread_id: "history_01",
      target: "history_01",
      payload: { content: "", attachments: [] }
    })
  );
  const parsed = JSON.parse(historyResult.content) as Array<{
    sequence: number;
    event_kind: string;
    source: string;
    type: string;
    content: string;
    replace_key: string | null;
  }>;

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.sequence, 1);
  assert.equal(parsed[0]?.event_kind, "user_send");
  assert.equal(parsed[0]?.source, "user");
  assert.equal(parsed[0]?.type, "user");
  assert.equal(parsed[0]?.content, "ship it");
  assert.equal(parsed[0]?.replace_key, null);
  assert.equal(parsed[1]?.sequence, 2);
  assert.equal(parsed[1]?.event_kind, "final_reply");
  assert.equal(parsed[1]?.source, "codex");
  assert.equal(parsed[1]?.type, "agent");
  assert.equal(parsed[1]?.content, "done");
  assert.equal(parsed[1]?.replace_key, null);
});

test("HubRouter coalesces same-trace progress snapshots and replaces them with the final reply", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "coalesce_01",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-coalesce_01.sock",
    pid: 701,
    tmux_pane: "agent_coalesce_01",
    status: "running",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    statePath: "/tmp/meridian-router-test-state.json"
  });
  const traceId = "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8";

  router.recordAgentPushConversation("coalesce_01", "Task is running...", traceId);
  router.recordAgentPushConversation("coalesce_01", "Still running...", traceId);

  const progressOnly = router.getConversationHistoryForThread("coalesce_01");
  assert.equal(progressOnly.length, 1);
  assert.equal(progressOnly[0]?.event_kind, "progress");
  assert.equal(progressOnly[0]?.content, "Still running...");
  assert.equal(progressOnly[0]?.replace_key, `${traceId}:progress`);

  router.recordAgentPushConversation("coalesce_01", "done", traceId, "final_reply");

  const withFinal = router.getConversationHistoryForThread("coalesce_01");
  assert.equal(withFinal.length, 1);
  assert.equal(withFinal[0]?.event_kind, "final_reply");
  assert.equal(withFinal[0]?.content, "done");
  assert.equal(withFinal[0]?.replace_key, null);
});

test("HubRouter keeps approval prompts durable after terminal input and final reply", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "approval_01",
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi-approval_01.sock",
    pid: 702,
    tmux_pane: "agent_approval_01",
    status: "waiting",
    created_at: new Date().toISOString()
  });

  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 2,
      updated_at: new Date().toISOString(),
      instances: registry.list(),
      session_bindings: {}
    }),
    sendTerminalInput: (threadId: string, rawInput: string) => `Sent approval action '${rawInput}' to ${threadId}.`,
    getAttachedThread: () => "approval_01",
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-router-test-state.json"
  });
  const traceId = "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8";

  router.recordAgentPushConversation(
    "approval_01",
    "Waiting for approval...\nRun this command?\n1. Allow once\n2. Allow for this session\n3. No, suggest changes",
    traceId
  );

  let history = router.getConversationHistoryForThread("approval_01");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.event_kind, "approval");

  await router.route(
    baseMessage({
      trace_id: traceId,
      intent: "terminal_input",
      thread_id: "active",
      target: "active",
      payload: {
        content: "allow",
        attachments: []
      },
      reply_channel: {
        channel: "telegram",
        chat_id: "100"
      }
    })
  );

  history = router.getConversationHistoryForThread("approval_01");
  assert.equal(history.length, 2);
  assert.equal(history[0]?.event_kind, "approval");
  assert.match(history[0]?.content ?? "", /^Waiting for approval\.\.\./);
  assert.equal(history[1]?.event_kind, "terminal_input");
  assert.equal(history[1]?.content, "allow");

  router.recordAgentPushConversation("approval_01", "done", traceId, "final_reply");

  history = router.getConversationHistoryForThread("approval_01");
  assert.equal(history.length, 3);
  assert.equal(history[0]?.event_kind, "approval");
  assert.equal(history[1]?.event_kind, "terminal_input");
  assert.equal(history[2]?.event_kind, "final_reply");
  assert.equal(history[2]?.content, "done");
});

test("HubRouter isWithinRunCompletionCooldown returns true after run completes", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "cooldown_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-cooldown_01.sock",
    pid: 501,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const router = new HubRouter(registry, {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "done" }),
      getStatus: async () => ({ status: "idle" })
    })
  });

  // Before run, no cooldown
  assert.equal(router.isWithinRunCompletionCooldown("cooldown_01", 5000), false);

  await router.route(
    baseMessage({
      trace_id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      thread_id: "cooldown_01",
      target: "cooldown_01",
      intent: "run"
    })
  );

  // After run, within cooldown
  assert.equal(router.isWithinRunCompletionCooldown("cooldown_01", 5000), true);

  // Simulate time passage beyond cooldown
  assert.equal(router.isWithinRunCompletionCooldown("cooldown_01", 5000, Date.now() + 6000), false);
});
