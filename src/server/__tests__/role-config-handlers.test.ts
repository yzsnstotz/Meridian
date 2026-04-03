import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { AgentDispatcherRole } from "../../roles/definitions/agent-dispatcher";
import { DispatcherRole } from "../../roles/definitions";
import { RoleRegistry } from "../../roles/role-registry";
import { RoleRunner } from "../../roles/role-runner";
import updateStatusTool from "../../tool-gateway/tools/update-status";
import { createRoleHandlers, type RoleHandlers } from "../role-handlers";
import type { AppState, DispatcherConfig, HubMessage, HubResult, ReplyChannel } from "../../types";

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

  it("drives /api/agent-dispatcher/start through real sidecar state and detail lookup", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-start-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const commandFilePath = path.join(tempDir, "agent_dispatch_command.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const stateStore = new MemoryStateStore();
    const log = createLogger();
    const attachToThread = vi.fn().mockResolvedValue(undefined);
    const registry = new RoleRegistry();
    const runner = new RoleRunner({
      sendToHub: async () => undefined,
      listInstances: () => [],
      log
    });

    await fs.writeFile(dispatchPlanPath, [
      "# Demo Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 1 | A-01 | Produce output | CODEX-HIGH | — | Demo PRD | Run the demo worker |"
    ].join("\n"), "utf8");
    await fs.writeFile(commandFilePath, "# Worker Command\n", "utf8");

    registry.register("dispatcher", (threadId, config) => new DispatcherRole(threadId, config, { stateStore }));
    registry.register(
      "agent-dispatcher",
      (threadId, config) => new AgentDispatcherRole(threadId, config, {
        stateStore,
        buildSystemPrompt: () => "test system prompt",
        launchDispatcher: async () => ({
          ok: true,
          threadId: "dispatcher-thread-e2e"
        }),
        killThread: async () => undefined,
        signalDispatcher: async () => undefined
      })
    );

    const roleHandlers = createRoleHandlers({
      runner,
      registry,
      stateStore,
      getThreadDetail: async () => [
        "Attached dispatcher session",
        "",
        "Worker A-01 finished."
      ].join("\n"),
      attachToThread: async (threadId) => {
        await attachToThread(threadId);
      },
      log
    });

    try {
      await expect(invokeJson<{
        ok: true;
        dispatcher_id: string;
        dispatcher_thread_id: string;
      }>(roleHandlers, "POST", "/api/agent-dispatcher/start", {
        thread_id: "agent-dispatcher-e2e",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: commandFilePath,
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always"
      })).resolves.toEqual({
        ok: true,
        dispatcher_id: "agent-dispatcher-e2e",
        dispatcher_thread_id: "dispatcher-thread-e2e"
      });

      await expect(fs.readFile(sidecarPath, "utf8")).resolves.toSatisfy((raw) => {
        const parsed = JSON.parse(raw) as {
          dispatcher?: { thread_id?: string | null };
        };

        return parsed.dispatcher?.thread_id === "dispatcher-thread-e2e";
      });

      await expect(updateStatusTool.execute({
        plan: dispatchPlanPath,
        worker: "A-01",
        status: "in_progress",
        thread_id: "worker-thread-456"
      })).resolves.toEqual({
        ok: true,
        data: {
          worker: "A-01",
          status: "in_progress"
        }
      });

      await expect(invokeJson(roleHandlers, "GET", "/api/role/agent-dispatcher-e2e")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-e2e",
        role_type: "agent-dispatcher",
        status: "active",
        dispatcher_thread_id: "dispatcher-thread-e2e",
        current_worker: "A-01",
        session_log: expect.arrayContaining([
          "Attached dispatcher session",
          "Worker A-01 finished."
        ]),
        dispatch_plan: {
          rows: [
            expect.objectContaining({
              worker: "A-01",
              status: "🔄"
            })
          ]
        }
      });
      expect(attachToThread).toHaveBeenCalledWith("dispatcher-thread-e2e");

      await expect(updateStatusTool.execute({
        plan: dispatchPlanPath,
        worker: "A-01",
        status: "done"
      })).resolves.toEqual({
        ok: true,
        data: {
          worker: "A-01",
          status: "done"
        }
      });
      await expect(fs.readFile(sidecarPath, "utf8")).resolves.toContain('"workers": {}');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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

  it("returns a reconciliation report from POST /api/reconcile for the active agent-dispatcher", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-reconcile-route-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const commandFilePath = path.join(tempDir, "agent_dispatch_command.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const reportPath = path.join(tempDir, "dev_history", "R-04_report.md");
    const lifecycleStore = new LifecycleStore(sidecarPath);

    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 4 | R-04 | Reconcile API Endpoint & Post-HubResult Trigger | CODEX | N-02 | TaskSpec v1.1 | |"
    ].join("\n"), "utf8");
    await fs.writeFile(commandFilePath, "# Worker Command\n", "utf8");
    await fs.writeFile(reportPath, "# report\n", "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-04": {
          thread_id: "worker-thread-456",
          trace_id: "trace-123",
          started_at: "2026-04-03T00:00:00.000Z",
          last_seen_at: "2026-04-03T00:00:00.000Z",
          status: "running",
          expected_outputs: [reportPath],
          hub_result: null
        }
      },
      last_reconciled_at: null
    });

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        null,
        null,
        async (message) => {
          if (message.thread_id === "dispatcher-thread-123") {
            return buildHubResult('{"status":"running"}');
          }

          if (message.thread_id === "worker-thread-456") {
            return buildHubResult('{"status":"completed"}');
          }

          throw new Error(`Unexpected thread lookup: ${message.thread_id}`);
        }
      );

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-reconcile",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: commandFilePath,
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always"
      });

      await expect(invokeJson(harness.roleHandlers, "POST", "/api/reconcile")).resolves.toEqual({
        changed: [
          {
            workerId: "R-04",
            from: "running",
            to: "completed",
            trigger: "hub_status:completed:outputs_present"
          }
        ],
        unchanged: ["dispatcher"]
      });
      expect(lifecycleStore.load().workers["R-04"]?.status).toBe("completed");
      expect(lifecycleStore.load().last_reconciled_at).not.toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns 404 from POST /api/reconcile when no active agent-dispatcher exists", async () => {
    const harness = createHarness();
    const request = createJsonRequest("POST", "/api/reconcile");
    const response = createJsonResponse();

    const handled = await harness.roleHandlers.handle(request, response.raw);

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: "No active agent dispatcher is running"
    });
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

  it("returns enriched agent-dispatcher detail for the dashboard and role view", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 5 | N-10 | API Layer | CODEX-XHIGH | N-09 | PRD v2.2 | ready |",
      "| 🔄 | 6 | N-11 | GUI | CODEX | N-10 | PRD v2.2 | running |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {
        "N-11": {
          thread_id: "worker-thread-456",
          started_at: "2026-03-28T00:00:00.000Z"
        }
      }
    }, null, 2)}\n`, "utf8");

    try {
      const attachToThread = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness(
        undefined,
        undefined,
        [],
        [
          "Detail for trace=trace-123 thread=dispatcher-thread-123",
          "",
          "Your message:",
          "Run worker N-11",
          "",
          "Agent reply:",
          "Updated the GUI dashboard."
        ].join("\n"),
        attachToThread
      );

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-detail",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always"
      });

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-detail")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-detail",
        role_type: "agent-dispatcher",
        status: "active",
        dispatcher_thread_id: "dispatcher-thread-123",
        current_worker: "N-11",
        last_log_line: "Updated the GUI dashboard.",
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        session_log: expect.arrayContaining([
          "Your message:",
          "Agent reply:",
          "Updated the GUI dashboard."
        ]),
        dispatch_plan: {
          rows: [
            expect.objectContaining({
              status: "✅",
              worker: "N-10"
            }),
            expect.objectContaining({
              status: "🔄",
              worker: "N-11"
            })
          ]
        }
      });
      expect(attachToThread).toHaveBeenCalledWith("dispatcher-thread-123");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
  replyChannels: ReplyChannel[] | Error = [],
  threadDetail: string | Error | null = null,
  attachToThread: ((threadId: string) => Promise<void>) | Error | null = null,
  sendHubRequest: ((message: HubMessage) => Promise<HubResult>) | Error | null = null
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

  const roleHandlersOptions = {
    runner,
    registry,
    stateStore,
    listReplyChannels: async () => {
      if (replyChannels instanceof Error) {
        throw replyChannels;
      }

      return structuredClone(replyChannels);
    },
    getThreadDetail: async () => {
      if (threadDetail instanceof Error) {
        throw threadDetail;
      }

      return threadDetail ?? "";
    },
    attachToThread: async (threadId: string) => {
      if (attachToThread instanceof Error) {
        throw attachToThread;
      }

      await attachToThread?.(threadId);
    },
    ...(sendHubRequest === null
      ? {}
      : {
          sendHubRequest: async (message: HubMessage) => {
            if (sendHubRequest instanceof Error) {
              throw sendHubRequest;
            }

            return sendHubRequest(message);
          }
        })
  };

  return {
    stateStore,
    roleHandlers: createRoleHandlers({
      ...roleHandlersOptions,
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

function buildHubResult(content: string): HubResult {
  return {
    trace_id: "trace-123",
    thread_id: "dispatcher-thread-123",
    source: "codex",
    status: "success",
    run_state: "completed",
    content,
    attachments: [],
    timestamp: "2026-04-03T00:00:00.000Z"
  };
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
