import { describe, expect, it, vi } from "vitest";

import type { AppState, DispatchThreadStateV2, HubMessage } from "../../../types";
import type { Logger, RoleContext } from "../../base-role";
import { AgentDispatcherRole } from "../agent-dispatcher";

class MemoryStateStore {
  private state: AppState | null;

  constructor(initialState: AppState | null = null) {
    this.state = initialState ? structuredClone(initialState) : null;
  }

  async load(): Promise<AppState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: AppState): Promise<void> {
    this.state = structuredClone(state);
  }
}

describe("AgentDispatcherRole", () => {
  it("constructs with a valid config and normalizes the primary reply channel", () => {
    const role = createHarness().role;

    expect(role.config.dispatch_plan_path).toBe("/tmp/dispatch_plan.md");
    expect(role.config.command_file_path).toBe("/tmp/agent_dispatch_command.md");
    expect(role.config.user_reply_channels).toHaveLength(1);
    expect(role.config.user_reply_channel).toEqual({
      channel: "telegram",
      chat_id: "telegram:pm"
    });
    expect(role.config.agent_type).toBe("codex");
    expect(role.config.mode).toBe("bridge");
    expect(role.config.kill_policy).toBe("always");
  });

  it("throws when required agent-dispatcher config is missing", () => {
    expect(() => {
      new AgentDispatcherRole("agent-dispatcher-invalid", {
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:pm"
          }
        ]
      });
    }).toThrow();
  });

  it("onActivate launches the dispatcher and records the dispatcher thread id", async () => {
    const harness = createHarness();

    await harness.role.onActivate(harness.context);

    expect(harness.buildSystemPrompt).toHaveBeenCalledWith({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: "[{\"channel\":\"telegram\",\"chat_id\":\"telegram:pm\"}]",
      default_agent_type: "codex",
      default_mode: "bridge",
      kill_policy: "always"
    });
    expect(harness.readWorkersByStatus).toHaveBeenCalledWith("/tmp/dispatch_plan.md", "🔄");
    expect(harness.launchDispatcher).toHaveBeenCalledWith({
      agentType: "codex",
      mode: "bridge",
      systemPrompt: "dispatcher prompt",
      dispatchPlanPath: "/tmp/dispatch_plan.md",
      commandFilePath: "/tmp/agent_dispatch_command.md",
      userReplyChannel: {
        channel: "telegram",
        chat_id: "telegram:pm"
      }
    });
    expect(harness.sessionManager.initSession).toHaveBeenCalledWith("dispatcher-thread-123", "/tmp/dispatch_plan.md");

    const savedState = await harness.stateStore.load();
    expect(savedState?.roles).toEqual([
      expect.objectContaining({
        threadId: "agent-dispatcher-role",
        roleType: "agent-dispatcher",
        status: "active",
        config: expect.objectContaining({
          dispatch_plan_path: "/tmp/dispatch_plan.md",
          command_file_path: "/tmp/agent_dispatch_command.md",
          user_reply_channels: [
            {
              channel: "telegram",
              chat_id: "telegram:pm"
            }
          ]
        })
      })
    ]);
  });

  it("onStatusChange(\"paused\") persists paused state and signals the dispatcher thread", async () => {
    const harness = createHarness();
    await harness.role.onActivate(harness.context);

    await harness.role.onStatusChange("agent-dispatcher-role", "paused");

    expect(harness.sessionManager.setPaused).toHaveBeenCalledWith(true);
    expect(harness.signalDispatcher).toHaveBeenCalledWith("dispatcher-thread-123", "paused");
    expect((await harness.stateStore.load())?.roles[0]?.status).toBe("paused");
  });

  it("onStatusChange(\"active\") clears paused state and signals resume", async () => {
    const harness = createHarness();
    await harness.role.onActivate(harness.context);

    await harness.role.onStatusChange("agent-dispatcher-role", "active");

    expect(harness.sessionManager.setPaused).toHaveBeenCalledWith(false);
    expect(harness.signalDispatcher).toHaveBeenCalledWith("dispatcher-thread-123", "active");
    expect((await harness.stateStore.load())?.roles[0]?.status).toBe("active");
  });

  it("onDeactivate kills the dispatcher and tracked worker threads", async () => {
    const harness = createHarness({
      lifecycleState: {
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-03-28T11:59:00.000Z",
          status: "running"
        },
        workers: {
          "N-03": {
            thread_id: "worker-thread-333",
            trace_id: null,
            started_at: "2026-03-28T12:00:00.000Z",
            last_seen_at: "2026-03-28T12:00:00.000Z",
            status: "running",
            expected_outputs: [],
            hub_result: null
          },
          "N-04": {
            thread_id: "worker-thread-444",
            trace_id: null,
            started_at: "2026-03-28T12:01:00.000Z",
            last_seen_at: "2026-03-28T12:01:00.000Z",
            status: "running",
            expected_outputs: [],
            hub_result: null
          }
        },
        last_reconciled_at: null
      }
    });
    await harness.role.onActivate(harness.context);

    await harness.role.onDeactivate();

    expect(harness.killThread).toHaveBeenCalledTimes(3);
    expect(harness.killThread).toHaveBeenCalledWith("dispatcher-thread-123");
    expect(harness.killThread).toHaveBeenCalledWith("worker-thread-333");
    expect(harness.killThread).toHaveBeenCalledWith("worker-thread-444");
    expect(harness.lifecycleState).toEqual({
      version: 2,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "pending"
      },
      workers: {},
      last_reconciled_at: null
    });
    expect((await harness.stateStore.load())?.roles).toEqual([]);
  });
});

function createHarness(options: {
  lifecycleState?: DispatchThreadStateV2;
} = {}) {
  const stateStore = new MemoryStateStore();
  const sessionManager = {
    getDispatcherThreadId: vi.fn(() => "dispatcher-thread-123"),
    initSession: vi.fn(async () => undefined),
    isPaused: vi.fn(() => false),
    onRestart: vi.fn(async () => ({
      staleWorkersKilled: [],
      dispatcherRestarted: true
    })),
    setPaused: vi.fn(() => undefined)
  };
  const buildSystemPrompt = vi.fn(() => "dispatcher prompt");
  const launchDispatcher = vi.fn(async () => ({
    ok: true,
    threadId: "dispatcher-thread-123"
  }));
  const readWorkersByStatus = vi.fn(async () => []);
  const killThread = vi.fn(async () => undefined);
  const signalDispatcher = vi.fn(async () => undefined);
  const initialLifecycleState: DispatchThreadStateV2 = options.lifecycleState ?? {
    version: 2,
    dispatcher: {
      thread_id: null,
      started_at: null,
      status: "pending"
    },
    workers: {},
    last_reconciled_at: null
  };
  let lifecycleState: DispatchThreadStateV2 = structuredClone(initialLifecycleState);

  const role = new AgentDispatcherRole("agent-dispatcher-role", {
    dispatch_plan_path: "/tmp/dispatch_plan.md",
    command_file_path: "/tmp/agent_dispatch_command.md",
    user_reply_channels: [
      {
        channel: "telegram",
        chat_id: "telegram:pm"
      }
    ],
    agent_type: "codex",
    mode: "bridge",
    kill_policy: "always"
  }, {
    stateStore,
    buildSystemPrompt,
    launchDispatcher,
    sessionManagerFactory: () => sessionManager,
    readWorkersByStatus,
    lifecycleStoreFactory: () => ({
      load: () => structuredClone(lifecycleState),
      save: (nextState) => {
        lifecycleState = structuredClone(nextState);
      }
    }),
    killThread,
    signalDispatcher
  });

  return {
    role,
    stateStore,
    sessionManager,
    buildSystemPrompt,
    launchDispatcher,
    readWorkersByStatus,
    killThread,
    signalDispatcher,
    get lifecycleState() {
      return lifecycleState;
    },
    context: createRoleContext()
  };
}

function createRoleContext(): RoleContext {
  return {
    sendToHub: vi.fn(async (_message: Partial<HubMessage>) => undefined),
    listInstances: vi.fn(async () => []),
    log: createLogger()
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
