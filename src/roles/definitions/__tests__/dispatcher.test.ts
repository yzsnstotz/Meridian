import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppState, AgentInstance, DispatcherConfig, HubMessage, HubResult } from "../../../types";
import type { Logger, RoleContext } from "../../base-role";
import { DispatcherRole } from "../dispatcher";

class MemoryStateStore {
  savedStates: AppState[] = [];
  private currentState: AppState | null = null;

  async load(): Promise<AppState | null> {
    return this.currentState ? cloneState(this.currentState) : null;
  }

  async save(state: AppState): Promise<void> {
    const snapshot = cloneState(state);
    this.currentState = snapshot;
    this.savedStates.push(snapshot);
  }
}

const idleInstances: AgentInstance[] = [
  {
    thread_id: "claude_01",
    agent_type: "claude",
    model_id: "opus",
    mode: "bridge",
    socket_path: "/tmp/claude.sock",
    working_dir: "/tmp",
    pid: 101,
    tmux_pane: null,
    status: "idle",
    created_at: "2026-03-19T00:00:00.000Z",
    restart_safe: true,
    auto_approve: false
  },
  {
    thread_id: "codex_01",
    agent_type: "codex",
    model_id: "gpt-5-codex",
    mode: "bridge",
    socket_path: "/tmp/codex.sock",
    working_dir: "/tmp",
    pid: 202,
    tmux_pane: null,
    status: "idle",
    created_at: "2026-03-19T00:00:00.000Z",
    restart_safe: true,
    auto_approve: false
  }
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DispatcherRole", () => {
  it("dispatches root tasks on activation, persists state, and uses the socket reply channel", async () => {
    const stateStore = new MemoryStateStore();
    const sendToHub = createSendToHubMock();
    const role = new DispatcherRole(
      "dispatcher-1",
      {
        tasks: [
          {
            task_id: "root",
            instruction: "root instruction",
            instruction_template: "templated instruction",
            depends_on: [],
            target_thread_id: "claude_99"
          },
          {
            task_id: "child",
            instruction: "child instruction",
            depends_on: ["root"]
          }
        ]
      },
      {
        stateStore,
        traceIdFactory: createTraceIdFactory("00000000-0000-4000-8000-000000000001")
      }
    );

    await role.onActivate(createContext({ sendToHub }));

    expect(sendToHub).toHaveBeenCalledTimes(1);
    expect(sendToHub).toHaveBeenCalledWith(
      expect.objectContaining<Partial<HubMessage>>({
        trace_id: "00000000-0000-4000-8000-000000000001",
        thread_id: "dispatcher-1",
        actor_id: "service:meridian-roles",
        intent: "run",
        target: "claude_99",
        suppress_reply: false,
        reply_channel: {
          channel: "socket",
          chat_id: "service:meridian-roles",
          socket_path: "/tmp/meridian-roles.sock"
        },
        payload: {
          content: "templated instruction",
          attachments: []
        }
      })
    );

    const config = role.config as DispatcherConfig;
    expect(config.tasks[0]).toMatchObject({
      status: "running",
      result_trace_id: "00000000-0000-4000-8000-000000000001"
    });
    expect(config.tasks[1]?.status).toBe("pending");

    expect(stateStore.savedStates.at(-1)?.roles[0]).toMatchObject({
      threadId: "dispatcher-1",
      roleType: "dispatcher",
      status: "active"
    });
    expect(
      ((stateStore.savedStates.at(-1)?.roles[0]?.config as DispatcherConfig).tasks[0])?.result_trace_id
    ).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("advances the DAG on matching results and routes tasks strictly by trace_id", async () => {
    const stateStore = new MemoryStateStore();
    const sendToHub = createSendToHubMock();
    const role = new DispatcherRole(
      "dispatcher-2",
      {
        tasks: [
          {
            task_id: "A",
            instruction: "task A",
            depends_on: [],
            target_thread_id: "claude_01"
          },
          {
            task_id: "B",
            instruction: "task B",
            depends_on: ["A"],
            target_agent_type: "codex"
          },
          {
            task_id: "C",
            instruction: "task C",
            depends_on: ["A"]
          }
        ]
      },
      {
        stateStore,
        traceIdFactory: createTraceIdFactory(
          "00000000-0000-4000-8000-000000000010",
          "00000000-0000-4000-8000-000000000011",
          "00000000-0000-4000-8000-000000000012"
        )
      }
    );

    await role.onActivate(createContext({ sendToHub }));
    expect(sendToHub).toHaveBeenCalledTimes(1);

    await role.onInboundResult(
      buildResult({
        trace_id: "00000000-0000-4000-8000-000000000099",
        thread_id: "other-thread",
        content: "ignore me"
      })
    );
    expect(sendToHub).toHaveBeenCalledTimes(1);

    await role.onInboundResult(
      buildResult({
        trace_id: "00000000-0000-4000-8000-000000000010",
        thread_id: "dispatcher-2",
        status: "success",
        content: "root finished"
      })
    );

    expect(sendToHub).toHaveBeenCalledTimes(3);
    expect(sendToHub.mock.calls[1]?.[0]).toMatchObject({
      trace_id: "00000000-0000-4000-8000-000000000011",
      target: "codex_01",
      suppress_reply: false
    });
    expect(sendToHub.mock.calls[2]?.[0]).toMatchObject({
      trace_id: "00000000-0000-4000-8000-000000000012",
      target: "claude_01",
      suppress_reply: false
    });

    const config = role.config as DispatcherConfig;
    expect(config.tasks).toMatchObject([
      { task_id: "A", status: "done", result_summary: "root finished" },
      { task_id: "B", status: "running", result_trace_id: "00000000-0000-4000-8000-000000000011" },
      { task_id: "C", status: "running", result_trace_id: "00000000-0000-4000-8000-000000000012" }
    ]);
  });

  it("marks downstream tasks as failed and emits the completion summary only once", async () => {
    const stateStore = new MemoryStateStore();
    const sendToHub = createSendToHubMock();
    const role = new DispatcherRole(
      "dispatcher-3",
      {
        tasks: [
          {
            task_id: "root",
            instruction: "task root",
            depends_on: []
          },
          {
            task_id: "left",
            instruction: "task left",
            depends_on: ["root"]
          },
          {
            task_id: "right",
            instruction: "task right",
            depends_on: ["root"]
          }
        ],
        user_reply_channel: {
          channel: "telegram",
          chat_id: "telegram:123"
        }
      },
      {
        stateStore,
        traceIdFactory: createTraceIdFactory(
          "00000000-0000-4000-8000-000000000020",
          "00000000-0000-4000-8000-000000000021"
        )
      }
    );

    await role.onActivate(createContext({ sendToHub }));
    await role.onInboundResult(
      buildResult({
        trace_id: "00000000-0000-4000-8000-000000000020",
        thread_id: "dispatcher-3",
        status: "error",
        content: "root failed"
      })
    );
    await role.onInboundResult(
      buildResult({
        trace_id: "00000000-0000-4000-8000-000000009999",
        thread_id: "dispatcher-3",
        status: "success",
        content: "unrelated late result"
      })
    );

    expect(sendToHub).toHaveBeenCalledTimes(2);
    const summaryMessage = sendToHub.mock.calls[1]?.[0];
    expect(summaryMessage).toBeDefined();
    if (!summaryMessage) {
      throw new Error("Expected completion summary message");
    }
    expect(summaryMessage.payload).toBeDefined();
    if (!summaryMessage.payload) {
      throw new Error("Expected completion summary payload");
    }
    expect(summaryMessage.reply_channel).toEqual({
      channel: "telegram",
      chat_id: "telegram:123"
    });
    expect(summaryMessage.intent).toBe("reply");
    expect(summaryMessage.target).toBe("global");
    expect(summaryMessage.suppress_reply).toBe(true);
    expect(summaryMessage.payload.content).toContain("# Dispatcher Summary: dispatcher-3");
    expect(summaryMessage.payload.content).toContain("- root: failed | root failed");
    expect(summaryMessage.payload.content).toContain("- left: failed | Blocked by failed dependency: root");
    expect(summaryMessage.payload.content).toContain("- right: failed | Blocked by failed dependency: root");

    const config = role.config as DispatcherConfig;
    expect(config.tasks).toMatchObject([
      { task_id: "root", status: "failed", result_summary: "root failed" },
      { task_id: "left", status: "failed", result_summary: "Blocked by failed dependency: root" },
      { task_id: "right", status: "failed", result_summary: "Blocked by failed dependency: root" }
    ]);
    expect(stateStore.savedStates.at(-1)?.roles[0]?.status).toBe("completed");
  });

  it("resolves targets by model id, agent type, and idle fallback", async () => {
    const sendToHub = createSendToHubMock();
    const role = new DispatcherRole(
      "dispatcher-4",
      {
        tasks: [
          {
            task_id: "model",
            instruction: "use specific model",
            depends_on: [],
            target_model_id: "gpt-5-codex"
          },
          {
            task_id: "agent",
            instruction: "use agent type",
            depends_on: [],
            target_agent_type: "claude"
          },
          {
            task_id: "fallback",
            instruction: "use any idle instance",
            depends_on: []
          }
        ]
      },
      {
        stateStore: new MemoryStateStore(),
        traceIdFactory: createTraceIdFactory(
          "00000000-0000-4000-8000-000000000030",
          "00000000-0000-4000-8000-000000000031",
          "00000000-0000-4000-8000-000000000032"
        )
      }
    );

    await role.onActivate(createContext({ sendToHub }));

    expect(sendToHub).toHaveBeenCalledTimes(3);
    expect(sendToHub.mock.calls[0]?.[0]).toMatchObject({ target: "codex_01" });
    expect(sendToHub.mock.calls[1]?.[0]).toMatchObject({ target: "claude_01" });
    expect(sendToHub.mock.calls[2]?.[0]).toMatchObject({ target: "claude_01" });
  });

  it("throws on cyclic task graphs", async () => {
    const role = new DispatcherRole(
      "dispatcher-5",
      {
        tasks: [
          {
            task_id: "A",
            instruction: "task A",
            depends_on: ["B"]
          },
          {
            task_id: "B",
            instruction: "task B",
            depends_on: ["A"]
          }
        ]
      },
      {
        stateStore: new MemoryStateStore(),
        traceIdFactory: createTraceIdFactory("00000000-0000-4000-8000-000000000040")
      }
    );

    await expect(role.onActivate(createContext())).rejects.toThrow(/Circular dependency detected/);
  });

  it("serializes concurrent completions so T2 only fires once", async () => {
    const sendToHub = createSendToHubMock();
    const role = new DispatcherRole(
      "dispatcher-6",
      {
        tasks: [
          {
            task_id: "root",
            instruction: "task root",
            depends_on: [],
            target_thread_id: "claude_01"
          },
          {
            task_id: "left",
            instruction: "task left",
            depends_on: ["root"],
            target_thread_id: "claude_01"
          },
          {
            task_id: "right",
            instruction: "task right",
            depends_on: ["root"],
            target_thread_id: "codex_01"
          }
        ],
        user_reply_channel: {
          channel: "web",
          chat_id: "web:abc"
        }
      },
      {
        stateStore: new MemoryStateStore(),
        traceIdFactory: createTraceIdFactory(
          "00000000-0000-4000-8000-000000000050",
          "00000000-0000-4000-8000-000000000051",
          "00000000-0000-4000-8000-000000000052",
          "00000000-0000-4000-8000-000000000053"
        )
      }
    );

    await role.onActivate(createContext({ sendToHub }));
    await role.onInboundResult(
      buildResult({
        trace_id: "00000000-0000-4000-8000-000000000050",
        thread_id: "dispatcher-6",
        status: "success",
        content: "root complete"
      })
    );

    await Promise.all([
      role.onInboundResult(
        buildResult({
          trace_id: "00000000-0000-4000-8000-000000000051",
          thread_id: "dispatcher-6",
          status: "success",
          content: "left complete"
        })
      ),
      role.onInboundResult(
        buildResult({
          trace_id: "00000000-0000-4000-8000-000000000052",
          thread_id: "dispatcher-6",
          status: "success",
          content: "right complete"
        })
      )
    ]);

    expect(sendToHub).toHaveBeenCalledTimes(4);
    const summaryMessages = sendToHub.mock.calls
      .map((call) => call[0])
      .filter((message): message is HubMessage => Boolean(message) && message.suppress_reply === true);
    expect(summaryMessages).toHaveLength(1);
    expect(summaryMessages[0]?.intent).toBe("reply");
    expect(summaryMessages[0]?.payload.content).toContain("1. root");
    expect(summaryMessages[0]?.payload.content).toContain("2. left");
    expect(summaryMessages[0]?.payload.content).toContain("3. right");
  });
});

function createContext(overrides: {
  sendToHub?: RoleContext["sendToHub"];
  listInstances?: () => AgentInstance[];
  log?: Logger;
} = {}): RoleContext {
  return {
    sendToHub: overrides.sendToHub ?? vi.fn(async () => undefined),
    listInstances: overrides.listInstances ?? (() => idleInstances),
    log: overrides.log ?? createLogger()
  };
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createTraceIdFactory(...traceIds: string[]): () => string {
  const queue = [...traceIds];
  return () => {
    const traceId = queue.shift();
    if (!traceId) {
      throw new Error("No trace id left in test factory");
    }
    return traceId;
  };
}

function buildResult(overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: "00000000-0000-4000-8000-000000000000",
    thread_id: "dispatcher-test",
    source: "claude",
    status: "success",
    content: "ok",
    attachments: [],
    timestamp: "2026-03-19T00:00:00.000Z",
    ...overrides
  };
}

function createSendToHubMock() {
  return vi.fn<(message: Partial<HubMessage>) => Promise<void>>(async () => undefined);
}

function cloneState(state: AppState): AppState {
  return JSON.parse(JSON.stringify(state)) as AppState;
}
