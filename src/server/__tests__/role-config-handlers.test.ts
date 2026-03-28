import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { AgentDispatcherRole } from "../../roles/definitions/agent-dispatcher";
import { DispatcherRole } from "../../roles/definitions";
import { RoleRegistry } from "../../roles/role-registry";
import { RoleRunner } from "../../roles/role-runner";
import { createRoleHandlers, type RoleHandlers } from "../role-handlers";
import type { AppState, DispatcherConfig, ReplyChannel } from "../../types";

class MemoryStateStore {
  private currentState: AppState | null;

  constructor(initialState: AppState | null = null) {
    this.currentState = initialState ? cloneState(initialState) : null;
  }

  async load(): Promise<AppState | null> {
    return this.currentState ? cloneState(this.currentState) : null;
  }

  async save(state: AppState): Promise<void> {
    this.currentState = cloneState(state);
  }
}

describe("role config handlers", () => {
  it("prefers the active dispatcher config over stale persisted state", async () => {
    const harness = createHarness();

    await createRole(
      harness.roleHandlers,
      {
        thread_id: "dispatcher-live",
        tasks: [
          {
            task_id: "complete",
            instruction: "Already done",
            depends_on: [],
            status: "done",
            result_summary: "finished"
          }
        ],
        taskspec: "live config",
        system_prompt: "keep me elsewhere",
        user_reply_channel: {
          channel: "telegram",
          chat_id: "telegram:pm"
        }
      }
    );

    const state = await harness.stateStore.load();
    expect(state).not.toBeNull();
    if (!state) {
      throw new Error("Expected persisted state");
    }

    state.roles[0] = {
      ...state.roles[0],
      config: {
        tasks: [
          {
            task_id: "stale",
            instruction: "persisted only",
            depends_on: []
          }
        ],
        taskspec: "persisted config"
      }
    };
    await harness.stateStore.save(state);

    await expect(harness.roleHandlers.getConfig("dispatcher-live")).resolves.toEqual({
      thread_id: "dispatcher-live",
      status: "completed",
      can_edit: true,
      blocked_reason: undefined,
      config: {
        tasks: [
          {
            task_id: "complete",
            instruction: "Already done",
            depends_on: []
          }
        ],
        taskspec: "live config"
      }
    });
  });

  it("returns 404 when the dispatcher role does not exist", async () => {
    const harness = createHarness();

    await expect(harness.roleHandlers.getConfig("missing-role")).rejects.toMatchObject({
      statusCode: 404,
      message: "Role not found for thread_id=missing-role"
    });
  });

  it("accepts agent-dispatcher role creation payloads", async () => {
    const harness = createHarness();
    const request = createJsonRequest("POST", "/api/role", {
      role_type: "agent-dispatcher",
      config: {
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:pm"
          }
        ]
      }
    });
    const response = createJsonResponse();

    const handled = await harness.roleHandlers.handle(request, response.raw);

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      role_type: "agent-dispatcher"
    });
  });

  it("starts an agent-dispatcher role and returns both dispatcher ids", async () => {
    const harness = createHarness();
    const request = createJsonRequest("POST", "/api/agent-dispatcher/start", {
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channel: {
        channel: "telegram",
        chat_id: "telegram:ops"
      },
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always"
    });
    const response = createJsonResponse();

    const handled = await harness.roleHandlers.handle(request, response.raw);

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      dispatcher_id: expect.stringMatching(/^agent-dispatcher-/),
      dispatcher_thread_id: "dispatcher-thread-123"
    });
  });

  it("pauses and resumes an active agent-dispatcher role through the dedicated routes", async () => {
    const harness = createHarness();
    const startResponse = await invokeJson<{ ok: true; dispatcher_id: string; dispatcher_thread_id: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/start",
      {
        thread_id: "agent-dispatcher-live",
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ]
      }
    );

    expect(startResponse.dispatcher_id).toBe("agent-dispatcher-live");

    await expect(invokeJson(harness.roleHandlers, "POST", "/api/agent-dispatcher/agent-dispatcher-live/pause")).resolves.toEqual({
      ok: true,
      status: "paused"
    });
    expect((await harness.stateStore.load())?.roles.find((role) => role.threadId === "agent-dispatcher-live")?.status).toBe("paused");

    await expect(invokeJson(harness.roleHandlers, "POST", "/api/agent-dispatcher/agent-dispatcher-live/resume")).resolves.toEqual({
      ok: true,
      status: "active"
    });
    expect((await harness.stateStore.load())?.roles.find((role) => role.threadId === "agent-dispatcher-live")?.status).toBe("active");
  });

  it("lists reply channels from the injected channel registry", async () => {
    const harness = createHarness(undefined, undefined, [
      {
        channel: "telegram",
        chat_id: "telegram:dispatch-room",
        chat_name: "Dispatch Room"
      },
      {
        channel: "web",
        chat_id: "web:ops"
      }
    ]);

    await expect(invokeJson(harness.roleHandlers, "GET", "/api/channels")).resolves.toEqual({
      channels: [
        {
          channel: "telegram",
          chat_id: "telegram:dispatch-room",
          chat_name: "Dispatch Room"
        },
        {
          channel: "web",
          chat_id: "web:ops"
        }
      ]
    });
  });

  it("falls back to an empty channel list when the registry lookup fails", async () => {
    const harness = createHarness(undefined, undefined, new Error("hub unavailable"));

    await expect(invokeJson(harness.roleHandlers, "GET", "/api/channels")).resolves.toEqual({
      channels: []
    });
  });

  it("rejects runtime-only and non-editor fields in config patches", async () => {
    const harness = createHarness(createPersistedState({
      tasks: [],
      taskspec: "existing"
    }));

    await expect(
      harness.roleHandlers.patchConfig("dispatcher-1", {
        tasks: [
          {
            task_id: "task-a",
            instruction: "Run task A",
            depends_on: [],
            status: "running"
          }
        ]
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Invalid dispatcher config edit payload"
    });

    await expect(
      harness.roleHandlers.patchConfig("dispatcher-1", {
        tasks: [],
        user_reply_channel: {
          channel: "telegram",
          chat_id: "telegram:pm"
        }
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Invalid dispatcher config edit payload"
    });
  });

  it("returns 409 while any dispatcher task is running", async () => {
    const harness = createHarness(createPersistedState({
      tasks: [
        {
          task_id: "task-a",
          instruction: "Run task A",
          depends_on: [],
          status: "running",
          result_trace_id: "00000000-0000-4000-8000-000000000001"
        }
      ],
      taskspec: "existing"
    }));

    await expect(
      harness.roleHandlers.patchConfig("dispatcher-1", {
        tasks: [],
        taskspec: "next"
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Cannot edit dispatcher config while tasks are running"
    });
  });

  it("normalizes runtime fields, preserves non-editor config, and persists edits across reload", async () => {
    const harness = createHarness();

    await createRole(
      harness.roleHandlers,
      {
        thread_id: "dispatcher-edit",
        tasks: [],
        taskspec: "before",
        system_prompt: "system prompt stays on prompts",
        user_reply_channel: {
          channel: "telegram",
          chat_id: "telegram:pm"
        }
      }
    );

    const response = await harness.roleHandlers.patchConfig("dispatcher-edit", {
      tasks: [
        {
          task_id: "task-a",
          instruction: "Run task A",
          instruction_template: "Use the template",
          depends_on: [],
          target_agent_type: "codex"
        },
        {
          task_id: "task-b",
          instruction: "Run task B",
          depends_on: ["task-a"],
          target_model_id: "gpt-5-codex"
        }
      ],
      taskspec: "after"
    });

    expect(response).toEqual({
      thread_id: "dispatcher-edit",
      status: "active",
      can_edit: true,
      blocked_reason: undefined,
      config: {
        tasks: [
          {
            task_id: "task-a",
            instruction: "Run task A",
            instruction_template: "Use the template",
            depends_on: [],
            target_agent_type: "codex"
          },
          {
            task_id: "task-b",
            instruction: "Run task B",
            depends_on: ["task-a"],
            target_model_id: "gpt-5-codex"
          }
        ],
        taskspec: "after"
      }
    });

    const liveConfig = harness.roleHandlers.resolveRole("dispatcher-edit")?.config as DispatcherConfig;
    expect(liveConfig.tasks).toMatchObject([
      {
        task_id: "task-a",
        instruction: "Run task A",
        instruction_template: "Use the template",
        depends_on: [],
        target_agent_type: "codex",
        status: "pending"
      },
      {
        task_id: "task-b",
        instruction: "Run task B",
        depends_on: ["task-a"],
        target_model_id: "gpt-5-codex",
        status: "pending"
      }
    ]);
    expect(liveConfig.tasks[0]?.result_trace_id).toBeUndefined();
    expect(liveConfig.tasks[0]?.result_summary).toBeUndefined();
    expect(liveConfig.system_prompt).toBe("system prompt stays on prompts");
    expect(liveConfig.user_reply_channel).toEqual({
      channel: "telegram",
      chat_id: "telegram:pm"
    });

    const persistedState = await harness.stateStore.load();
    expect(persistedState?.roles[0]).toMatchObject({
      threadId: "dispatcher-edit",
      roleType: "dispatcher",
      status: "active"
    });
    const persistedConfig = persistedState?.roles[0]?.config as DispatcherConfig;
    expect(persistedConfig.tasks[0]?.status).toBe("pending");
    expect(persistedConfig.tasks[0]?.result_trace_id).toBeUndefined();
    expect(persistedConfig.tasks[0]?.result_summary).toBeUndefined();
    expect(persistedConfig.system_prompt).toBe("system prompt stays on prompts");
    expect(persistedConfig.user_reply_channel).toEqual({
      channel: "telegram",
      chat_id: "telegram:pm"
    });

    const reloadedHarness = createHarness(undefined, harness.stateStore);
    await expect(reloadedHarness.roleHandlers.getConfig("dispatcher-edit")).resolves.toEqual({
      thread_id: "dispatcher-edit",
      status: "active",
      can_edit: true,
      blocked_reason: undefined,
      config: {
        tasks: [
          {
            task_id: "task-a",
            instruction: "Run task A",
            instruction_template: "Use the template",
            depends_on: [],
            target_agent_type: "codex"
          },
          {
            task_id: "task-b",
            instruction: "Run task B",
            depends_on: ["task-a"],
            target_model_id: "gpt-5-codex"
          }
        ],
        taskspec: "after"
      }
    });
  });
});

function createHarness(
  initialState?: AppState,
  stateStore = new MemoryStateStore(initialState ?? null),
  replyChannels: ReplyChannel[] | Error = []
) {
  const log = createLogger();
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: async () => undefined,
    listInstances: () => [],
    log
  });

  registry.register("dispatcher", (threadId, config) => new DispatcherRole(threadId, config, { stateStore }));
  registry.register(
    "agent-dispatcher",
    (threadId, config) => new AgentDispatcherRole(threadId, config, {
      stateStore,
      buildSystemPrompt: () => "test system prompt",
      launchDispatcher: async () => ({
        ok: true,
        threadId: "dispatcher-thread-123"
      }),
      sessionManagerFactory: () => ({
        getDispatcherThreadId: () => "dispatcher-thread-123",
        initSession: async () => undefined,
        isPaused: () => false,
        onRestart: async () => ({
          staleWorkersKilled: [],
          dispatcherRestarted: true
        }),
        setPaused: () => undefined
      }),
      readWorkersByStatus: async () => [],
      threadTrackerFactory: () => ({
        load: async () => ({
          dispatcher_thread_id: null,
          workers: {}
        }),
        save: async () => undefined
      }),
      killThread: async () => undefined,
      signalDispatcher: async () => undefined
    })
  );

  return {
    stateStore,
    roleHandlers: createRoleHandlers({
      runner,
      registry,
      stateStore,
      listReplyChannels: async () => {
        if (replyChannels instanceof Error) {
          throw replyChannels;
        }

        return structuredClone(replyChannels);
      },
      log
    })
  };
}

async function createRole(roleHandlers: RoleHandlers, body: unknown): Promise<void> {
  const request = createJsonRequest("POST", "/api/role", body);
  const response = createJsonResponse();
  const handled = await roleHandlers.handle(request, response.raw);

  expect(handled).toBe(true);
  expect(response.statusCode).toBe(201);
}

async function invokeJson<T = unknown>(roleHandlers: RoleHandlers, method: string, url: string, body?: unknown): Promise<T> {
  const request = createJsonRequest(method, url, body);
  const response = createJsonResponse();
  const handled = await roleHandlers.handle(request, response.raw);

  expect(handled).toBe(true);
  return JSON.parse(response.body) as T;
}

function createPersistedState(config: DispatcherConfig): AppState {
  return {
    roles: [
      {
        threadId: "dispatcher-1",
        roleType: "dispatcher",
        config,
        status: "active"
      }
    ],
    promptStore: {}
  };
}

function createJsonRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: body === undefined ? {} : { "content-type": "application/json" }
  }) as IncomingMessage;
}

function createJsonResponse(): {
  raw: ServerResponse;
  statusCode: number;
  body: string;
} {
  const capture = {
    statusCode: 200,
    body: "",
    headersSent: false
  };

  const raw = {
    setHeader: () => undefined,
    end(chunk?: string) {
      capture.body = chunk ?? "";
      capture.headersSent = true;
    }
  } as unknown as ServerResponse;

  Object.defineProperty(raw, "statusCode", {
    get() {
      return capture.statusCode;
    },
    set(value: number) {
      capture.statusCode = value;
    }
  });

  Object.defineProperty(raw, "headersSent", {
    get() {
      return capture.headersSent;
    },
    set(value: boolean) {
      capture.headersSent = value;
    }
  });

  return {
    raw,
    get statusCode() {
      return capture.statusCode;
    },
    get body() {
      return capture.body;
    }
  };
}

function cloneState(state: AppState): AppState {
  return structuredClone(state);
}

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
