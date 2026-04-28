import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { AgentDispatcherRole } from "../../roles/definitions/agent-dispatcher";
import type { LaunchConfig, LaunchResult } from "../../roles/agent-dispatcher/launcher";
import type { LaunchDispatchWorkerConfig, LaunchDispatchWorkerResult } from "../../roles/agent-dispatcher/worker-launcher";
import { PromptStore } from "../../roles/prompt-store";
import { RoleRegistry } from "../../roles/role-registry";
import { RoleRunner } from "../../roles/role-runner";
import killTool from "../../tool-gateway/tools/kill";
import updateStatusTool from "../../tool-gateway/tools/update-status";
import { createRoleHandlers, type RoleHandlers } from "../role-handlers";
import type { AppState, DispatcherConfig, DispatchWorkerState, HubMessage, HubResult, ReplyChannel } from "../../types";

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
  it("returns 404 when the dispatcher role does not exist", async () => {
    const harness = createHarness();

    await expect(harness.roleHandlers.getConfig("missing-role")).rejects.toMatchObject({
      statusCode: 404,
      message: "Role not found for thread_id=missing-role"
    });
  });

  it("returns service health from GET /api/health", async () => {
    const harness = createHarness(createPersistedState({
      tasks: [
        {
          task_id: "health-check",
          instruction: "verify service",
          depends_on: [],
          status: "pending"
        }
      ]
    }));

    await expect(invokeJson<{
      ok: true;
      version: string;
      uptime: number;
      agents_count: number;
      roles_count: number;
    }>(harness.roleHandlers, "GET", "/api/health")).resolves.toMatchObject({
      ok: true,
      version: "1.2.0",
      agents_count: 1,
      roles_count: 1
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

  it("returns a prompt preview for the agent-dispatcher start form", async () => {
    const harness = createHarness();

    await expect(invokeJson<{ system_prompt: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/prompt-preview",
      {
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always",
        auto_approve: true
      }
    )).resolves.toMatchObject({
      system_prompt: expect.stringContaining("__MERIDIAN_AGENT_DISPATCHER_ROLE_ID__")
    });

    await expect(invokeJson<{ system_prompt: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/prompt-preview",
      {
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always",
        auto_approve: true
      }
    )).resolves.toMatchObject({
      system_prompt: expect.stringContaining("auto_approve: true")
    });
  });

  it("materializes the real dispatcher id when starting from the preview prompt", async () => {
    const harness = createHarness();
    const preview = await invokeJson<{ system_prompt: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/prompt-preview",
      {
        dispatch_plan_path: "/tmp/dispatch_plan.md",
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
      }
    );

    const started = await invokeJson<{
      ok: true;
      dispatcher_id: string;
      dispatcher_thread_id: string;
    }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/start",
      {
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always",
        system_prompt: preview.system_prompt
      }
    );

    const state = await harness.stateStore.load();
    const persistedRole = state?.roles.find((role) => role.threadId === started.dispatcher_id);
    expect(persistedRole).toBeDefined();
    expect(persistedRole?.config).toMatchObject({
      system_prompt: expect.stringContaining(`dispatcher_role_id: ${started.dispatcher_id}`)
    });
    expect((persistedRole?.config as { system_prompt?: string }).system_prompt).not.toContain(
      "__MERIDIAN_AGENT_DISPATCHER_ROLE_ID__"
    );
    expect((persistedRole?.config as { system_prompt?: string }).system_prompt).not.toContain(
      "agent-dispatcher-preview"
    );
  });

  it("infers detached repo and docs roots for agent-dispatcher preview and start", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-detached-dispatch-"));
    const dispatchRepoRoot = path.join(workspaceRoot, "projects", "clawso");
    const docsRoot = path.join(workspaceRoot, "Docs");
    const dispatchPlanPath = path.join(
      docsRoot,
      "Projects",
      "clawso",
      "branch",
      "feat-cli",
      "taskspec",
      "dispatch_plan.md"
    );
    const commandFilePath = path.join(path.dirname(dispatchPlanPath), "agent_dispatch_command.md");
    const harness = createHarness();

    await fs.mkdir(path.join(workspaceRoot, ".git"));
    await fs.mkdir(path.join(dispatchRepoRoot, ".git"), { recursive: true });
    await fs.mkdir(path.dirname(dispatchPlanPath), { recursive: true });
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(commandFilePath, "# Command\n", "utf8");
    const canonicalDispatchRepoRoot = await fs.realpath(dispatchRepoRoot);
    const canonicalDocsRoot = await fs.realpath(docsRoot);

    try {
      const preview = await invokeJson<{ system_prompt: string }>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/prompt-preview",
        {
          dispatch_plan_path: dispatchPlanPath,
          command_file_path: commandFilePath,
          user_reply_channels: [
            {
              channel: "telegram",
              chat_id: "telegram:ops"
            }
          ]
        }
      );

      expect(preview.system_prompt).toContain(`dispatch_repo_root: ${canonicalDispatchRepoRoot}`);
      expect(preview.system_prompt).toContain(`docs_root: ${canonicalDocsRoot}`);

      const started = await invokeJson<{
        ok: true;
        dispatcher_id: string;
        dispatcher_thread_id: string;
      }>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/start",
        {
          thread_id: "agent-dispatcher-detached-roots",
          dispatch_plan_path: dispatchPlanPath,
          command_file_path: commandFilePath,
          user_reply_channels: [
            {
              channel: "telegram",
              chat_id: "telegram:ops"
            }
          ]
        }
      );

      await expect(harness.roleHandlers.getConfig(started.dispatcher_id)).resolves.toMatchObject({
        config: {
          dispatch_plan_path: dispatchPlanPath,
          command_file_path: commandFilePath,
          dispatch_repo_root: canonicalDispatchRepoRoot,
          docs_root: canonicalDocsRoot
        }
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns view-only agent-dispatcher launch config", async () => {
    const harness = createHarness();

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-config",
      role_type: "agent-dispatcher",
      dispatch_plan_path: "/tmp/dispatch_plan.md",
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

    await expect(harness.roleHandlers.getConfig("agent-dispatcher-config")).resolves.toEqual({
      thread_id: "agent-dispatcher-config",
      status: "active",
      can_edit: true,
      config: {
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        dispatch_repo_root: "/tmp",
        docs_root: "/tmp/Docs",
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always",
        auto_approve: false
      }
    });
  });

  it("persists validator config when starting an agent-dispatcher", async () => {
    const harness = createHarness();

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-validator-start",
      role_type: "agent-dispatcher",
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: [
        {
          channel: "telegram",
          chat_id: "telegram:ops"
        }
      ],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always",
      validator: {
        enabled: true,
        agent_type: "codex",
        pass_threshold: 0.85,
        max_fix_cycles: 2,
        base_branch: "main"
      }
    });

    await expect(harness.roleHandlers.getConfig("agent-dispatcher-validator-start")).resolves.toMatchObject({
      config: {
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          pass_threshold: 0.85,
          max_fix_cycles: 2,
          base_branch: "main"
        }
      }
    });

    const state = await harness.stateStore.load();
    expect(state?.roles.find((role) => role.threadId === "agent-dispatcher-validator-start")?.config)
      .toMatchObject({
        validator: {
          enabled: true,
          agent_type: "codex",
          pass_threshold: 0.85,
          max_fix_cycles: 2,
          base_branch: "main"
        }
      });
  });

  it("persists validator config patches for an agent-dispatcher", async () => {
    const harness = createHarness({
      roles: [
        {
          threadId: "agent-dispatcher-validator-patch",
          roleType: "agent-dispatcher",
          config: {
            tasks: [],
            dispatch_plan_path: "/tmp/dispatch_plan.md",
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
          },
          status: "active"
        }
      ],
      promptStore: {}
    });

    await expect(harness.roleHandlers.patchConfig("agent-dispatcher-validator-patch", {
      validator: {
        enabled: true,
        agent_type: "codex",
        pass_threshold: 0.9,
        max_fix_cycles: 1,
        base_branch: "main"
      }
    })).resolves.toMatchObject({
      config: {
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          pass_threshold: 0.9,
          max_fix_cycles: 1,
          base_branch: "main"
        }
      }
    });

    const state = await harness.stateStore.load();
    expect(state?.roles.find((role) => role.threadId === "agent-dispatcher-validator-patch")?.config)
      .toMatchObject({
        validator: {
          enabled: true,
          agent_type: "codex",
          pass_threshold: 0.9,
          max_fix_cycles: 1,
          base_branch: "main"
        }
      });
  });

  it("uses the default agent-dispatcher prompt and restores it when the override is cleared", async () => {
    const harness = createHarness();
    const promptStore = new PromptStore({
      stateStore: harness.stateStore,
      resolveRole: harness.roleHandlers.resolveRole
    });

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-prompt",
      role_type: "agent-dispatcher",
      dispatch_plan_path: "/tmp/dispatch_plan.md",
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

    await expect(promptStore.getPrompts("agent-dispatcher-prompt")).resolves.toEqual({
      system_prompt: expect.stringContaining("dispatch_plan_path: /tmp/dispatch_plan.md"),
      tasks: []
    });

    await promptStore.setSystemPrompt("agent-dispatcher-prompt", "custom dispatcher prompt");
    await expect(promptStore.getPrompts("agent-dispatcher-prompt")).resolves.toEqual({
      system_prompt: "custom dispatcher prompt",
      tasks: []
    });

    await promptStore.setSystemPrompt("agent-dispatcher-prompt", "   ");
    await expect(promptStore.getPrompts("agent-dispatcher-prompt")).resolves.toEqual({
      system_prompt: expect.stringContaining("dispatch_plan_path: /tmp/dispatch_plan.md"),
      tasks: []
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

    registry.register("dispatcher", (threadId, config) => new AgentDispatcherRole(threadId, config, {
      stateStore,
      buildSystemPrompt: () => "test system prompt",
      launchDispatcher: async () => ({
        ok: true,
        threadId: "dispatcher-thread-e2e"
      }),
      killThread: async () => undefined,
      signalDispatcher: async () => undefined
    }));
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
      await expect(fs.readFile(sidecarPath, "utf8")).resolves.toContain('"status": "completed"');
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

  it("pauses and resumes a startup-rehydrated agent-dispatcher role", async () => {
    const config = {
      tasks: [],
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: [
        {
          channel: "telegram" as const,
          chat_id: "telegram:ops"
        }
      ],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always",
      use_agent_dispatcher: true
    };
    const harness = createHarness({
      roles: [
        {
          threadId: "agent-dispatcher-rehydrated",
          roleType: "agent-dispatcher",
          config,
          status: "active"
        }
      ],
      promptStore: {}
    });

    const role = harness.registry.create("agent-dispatcher", "agent-dispatcher-rehydrated", config);
    await harness.runner.activate(role, { needsReactivation: false });

    await expect(
      invokeJson(harness.roleHandlers, "POST", "/api/agent-dispatcher/agent-dispatcher-rehydrated/pause")
    ).resolves.toEqual({
      ok: true,
      status: "paused"
    });
    expect((await harness.stateStore.load())?.roles.find((entry) => entry.threadId === "agent-dispatcher-rehydrated")?.status)
      .toBe("paused");

    await expect(
      invokeJson(harness.roleHandlers, "POST", "/api/agent-dispatcher/agent-dispatcher-rehydrated/resume")
    ).resolves.toEqual({
      ok: true,
      status: "active"
    });
    expect((await harness.stateStore.load())?.roles.find((entry) => entry.threadId === "agent-dispatcher-rehydrated")?.status)
      .toBe("active");
  });

  it("starts a new Hub session via POST /api/agent-dispatcher/:id/start-hub", async () => {
    const harness = createHarness();
    const startResponse = await invokeJson<{ ok: true; dispatcher_id: string; dispatcher_thread_id: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/start",
      {
        thread_id: "agent-dispatcher-start-hub-route",
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }]
      }
    );

    expect(startResponse.dispatcher_id).toBe("agent-dispatcher-start-hub-route");

    await expect(
      invokeJson<{ ok: true; dispatcher_thread_id: string }>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-start-hub-route/start-hub"
      )
    ).resolves.toEqual({
      ok: true,
      dispatcher_thread_id: "dispatcher-thread-123"
    });
  });

  it("persists agent-dispatcher model_id and approval policy in role detail", async () => {
    const harness = createHarness();

    const startResponse = await invokeJson<{ dispatcher_id: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/start",
      {
        thread_id: "agent-dispatcher-model-route",
        dispatch_plan_path: "/tmp/dispatch_plan.md",
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
        agent_type: "claude",
        model_id: "claude-opus-4-6",
        auto_approve: true
      }
    );

    const detail = await invokeJson<{ model_id?: string; agent_type?: string; auto_approve?: boolean }>(
      harness.roleHandlers,
      "GET",
      `/api/role/${encodeURIComponent(startResponse.dispatcher_id)}`
    );

    expect(detail.agent_type).toBe("claude");
    expect(detail.model_id).toBe("claude-opus-4-6");
    expect(detail.auto_approve).toBe(true);
    expect((await harness.stateStore.load())?.roles.find((entry) => entry.threadId === startResponse.dispatcher_id)?.config)
      .toMatchObject({
        agent_type: "claude",
        model_id: "claude-opus-4-6",
        auto_approve: true
      });
  });

  it("starts a new Hub session for a startup-rehydrated agent-dispatcher role", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-start-hub-rehydrated-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const config = {
      tasks: [],
      dispatch_plan_path: dispatchPlanPath,
      command_file_path: path.join(tempDir, "agent_dispatch_command.md"),
      user_reply_channels: [
        {
          channel: "telegram" as const,
          chat_id: "telegram:ops"
        }
      ],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always",
      use_agent_dispatcher: true
    };

    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness({
        roles: [
          {
            threadId: "agent-dispatcher-rehydrated-start-hub",
            roleType: "agent-dispatcher",
            config,
            status: "active"
          }
        ],
        promptStore: {}
      });

      const role = harness.registry.create(
        "agent-dispatcher",
        "agent-dispatcher-rehydrated-start-hub",
        config
      );
      await harness.runner.activate(role, { needsReactivation: false });

      await expect(
        invokeJson<{ ok: true; dispatcher_thread_id: string }>(
          harness.roleHandlers,
          "POST",
          "/api/agent-dispatcher/agent-dispatcher-rehydrated-start-hub/start-hub"
        )
      ).resolves.toEqual({
        ok: true,
        dispatcher_thread_id: "dispatcher-thread-123"
      });

      await expect(fs.readFile(sidecarPath, "utf8")).resolves.toContain('"thread_id": "dispatcher-thread-123"');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continues an abandoned worker and restarts dispatcher flow", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-worker-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const reportPath = path.join(tempDir, "dev_history", "v1_round", "delta_check_report.md");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⚠️ ABANDONED | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | local IPC failed |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-08": buildLifecycleWorker({
          thread_id: "worker-thread-stale",
          status: "abandoned",
          expected_outputs: [reportPath]
        })
      },
      last_reconciled_at: null
    });

    const killSpy = vi.spyOn(killTool, "execute").mockResolvedValue({
      ok: true,
      data: {
        thread_id: "worker-thread-stale"
      }
    });

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-worker", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/roles/agent-dispatcher-continue-worker/worker/R-08/continue"
      )).resolves.toEqual({
        ok: true,
        status: "continued",
        message: "continued: R-08",
        dispatcher_thread_id: "dispatcher-thread-123",
        worker: "R-08",
        resume_result: {
          worker: "R-08",
          action: "retry",
          status: "pending",
          thread_id: "worker-thread-stale",
          thread_killed: true,
          retry_count: 1
        }
      });

      expect(killSpy).toHaveBeenCalledWith({
        thread_id: "worker-thread-stale"
      });
      expect(lifecycleStore.load().workers["R-08"]?.status).toBe("pending");
      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| ⬜ | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | local IPC failed |");
    } finally {
      killSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not continue an abandoned worker while another non-human row is running", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-blocked-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });
    const launchDispatcher = vi.fn(async () => ({
      ok: true,
      threadId: "dispatcher-thread-123"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 5 | R-07 | Integration Repair | CODEX | — | CLI Integration PRD | running |",
      "| ⚠️ ABANDONED | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | local IPC failed |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-07": buildLifecycleWorker({
          thread_id: "worker-thread-running",
          status: "running"
        }),
        "R-08": buildLifecycleWorker({
          thread_id: "worker-thread-stale",
          status: "abandoned"
        })
      },
      last_reconciled_at: null
    });

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, launchDispatcher);
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-blocked", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/roles/agent-dispatcher-continue-blocked/worker/R-08/continue"
      )).resolves.toEqual({
        ok: true,
        status: "still_blocked",
        message: "still blocked: running worker(s): R-07",
        worker: "R-08",
        running_workers: ["R-07"]
      });

      expect(launchDispatcher).toHaveBeenCalledTimes(1);
      expect(lifecycleStore.load().workers["R-08"]?.status).toBe("abandoned");
      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| ⚠️ ABANDONED | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | local IPC failed |");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("kills orphaned worker threads and restores dispatch files when continue hits a detached run bootstrap failure", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-bootstrap-failure-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });
    const bootstrapError = "run launch failed: ENOENT";
    const launchDispatchWorker = vi.fn(async () => ({
      ok: false,
      threadId: "worker-thread-orphaned",
      error: bootstrapError
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⚠️ ABANDONED | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | local IPC failed |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-08": buildLifecycleWorker({
          thread_id: "worker-thread-stale",
          status: "abandoned",
          retry_count: 2
        })
      },
      last_reconciled_at: null
    });
    const killSpy = vi.spyOn(killTool, "execute").mockResolvedValue({
      ok: true,
      data: {
        thread_id: "worker-thread-stale"
      }
    });

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-bootstrap", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/roles/agent-dispatcher-continue-bootstrap/worker/R-08/continue"
      )).resolves.toEqual({
        ok: true,
        status: "local_tool_bootstrap_failed",
        message: `local tool bootstrap failed: ${bootstrapError}`,
        worker: "R-08",
        error: bootstrapError
      });

      expect(launchDispatchWorker).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenNthCalledWith(1, {
        thread_id: "worker-thread-stale"
      });
      expect(killSpy).toHaveBeenNthCalledWith(2, {
        thread_id: "worker-thread-orphaned"
      });
      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| ⬜ | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | local IPC failed |"
      );
      expect(lifecycleStore.load().workers["R-08"]).toMatchObject({
        thread_id: "worker-thread-stale",
        status: "pending",
        retry_count: 3
      });
    } finally {
      killSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continues a paused dispatcher and returns it to active state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-paused-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 5 | R-07 | Integration Repair | CODEX | — | CLI Integration PRD | done |"
    ].join("\n"), "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-paused", dispatchPlanPath);

      await expect(
        invokeJson(harness.roleHandlers, "POST", "/api/agent-dispatcher/agent-dispatcher-continue-paused/pause")
      ).resolves.toEqual({
        ok: true,
        status: "paused"
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-paused/continue"
      )).resolves.toEqual({
        ok: true,
        status: "plan_complete",
        message: "plan complete: all non-human workers are terminal",
        dispatcher_thread_id: "dispatcher-thread-123"
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not process validation while another worker is running during continue", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-validation-blocked-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | N-02 | Build Complete | CODEX | — | TaskSpec | awaiting validation |",
      "| 🔄 | 2 | R-04 | Runtime Followup | CODEX | N-02 | TaskSpec | still running |",
      "| ⬜ | 3 | R-05 | Later Work | CODEX | R-04 | TaskSpec | blocked |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-02": buildLifecycleWorker({
          thread_id: "worker-thread-n02",
          status: "awaiting_validation",
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: []
          }
        }),
        "R-04": buildLifecycleWorker({
          thread_id: "worker-thread-r04",
          status: "running"
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    const fetchSpy = vi.fn(async () => {
      throw new Error("validation should not run while another worker is active");
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const harness = createHarness();
      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-continue-validation-blocked",
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
        kill_policy: "always",
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          pass_threshold: 0.7,
          max_fix_cycles: 3,
          base_branch: "main"
        }
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-validation-blocked/continue"
      )).resolves.toEqual({
        ok: true,
        status: "still_blocked",
        message: "still blocked: running worker(s): R-04",
        running_workers: ["R-04"]
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns immediately after starting validation during continue", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-validation-async-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | N-02 | Build Complete | CODEX | — | TaskSpec | awaiting validation |",
      "| ⬜ | 2 | R-04 | Runtime Followup | CODEX | N-02 | TaskSpec | blocked by validation |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-02": buildLifecycleWorker({
          thread_id: "worker-thread-n02",
          status: "awaiting_validation",
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: []
          }
        })
      },
      last_reconciled_at: null
    });

    let timeout: NodeJS.Timeout | undefined;
    let runStarted = false;
    const fetchSpy = vi.fn((input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input.toString();
      const pathname = new URL(url).pathname;
      if (pathname === "/api/spawn") {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          thread_id: "validator-thread-n02"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
      }

      if (pathname === "/api/run") {
        runStarted = true;
        return new Promise<Response>(() => undefined);
      }

      throw new Error(`unexpected Meridian API request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const harness = createHarness();
      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-continue-validation-async",
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
        kill_policy: "always",
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          pass_threshold: 0.7,
          max_fix_cycles: 3,
          base_branch: "main"
        }
      });

      const result = await Promise.race([
        invokeJson(
          harness.roleHandlers,
          "POST",
          "/api/agent-dispatcher/agent-dispatcher-continue-validation-async/continue"
        ),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve({ timed_out: true }), 50);
        })
      ]);

      expect(result).toEqual({
        ok: true,
        status: "validation_in_progress",
        message: "validation started for N-02",
        worker: "N-02",
        validation_outcome: "started"
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(runStarted).toBe(true);
      expect(lifecycleStore.load().workers["N-02"]?.validation?.validator_thread_id).toBe("validator-thread-n02");
    } finally {
      if (timeout) clearTimeout(timeout);
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks continuation when a worker reply reported hit limit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-hit-limit-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 5 | R-07 | Integration Repair | CODEX | — | CLI Integration PRD | done |",
      "| ⬜ | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | review output |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "R-07": buildLifecycleWorker({
          thread_id: "worker-thread-r07",
          status: "completed",
          hub_result: {
            ...buildHubResult(":hit limit"),
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-r07"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-hit-limit", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-hit-limit/continue"
      )).resolves.toEqual({
        ok: true,
        status: "manual_intervention_required",
        message: "manual intervention required: R-07 reported hit limit",
        worker: "R-07",
        error: ":hit limit"
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continues the sole pre-marked running worker when no worker thread was ever recorded", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-pre-marked-worker-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | Ω+2 | R-10 | Feature Branch Scope Isolation | CODEX-HIGH | PR-REVIEW | TaskSpec | pre-marked before spawn failed |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "DISPATCHER": buildLifecycleWorker({
          thread_id: "dispatcher-thread-123",
          status: "completed"
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-pre-marked-worker", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-pre-marked-worker/continue"
      )).resolves.toEqual({
        ok: true,
        status: "continued",
        message: "continued: R-10",
        dispatcher_thread_id: "dispatcher-thread-123",
        worker: "R-10",
        resume_result: {
          worker: "R-10",
          action: "retry",
          status: "pending",
          thread_id: null,
          thread_killed: false,
          retry_count: 0
        }
      });

      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| ⬜ | Ω+2 | R-10 | Feature Branch Scope Isolation | CODEX-HIGH | PR-REVIEW | TaskSpec | pre-marked before spawn failed |"
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("directly launches the sole eligible pending worker without relaunching dispatcher hub", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-sole-eligible-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const launchDispatcher = vi.fn(async () => ({
      ok: true,
      threadId: "dispatcher-thread-123"
    }));
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-r11"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | Ω+2 | R-11 | GUI | CODEX-HIGH | — | TaskSpec | ready |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, launchDispatcher, launchDispatchWorker);
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-sole-eligible", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-sole-eligible/continue"
      )).resolves.toEqual({
        ok: true,
        status: "continued",
        message: "continued: R-11",
        dispatcher_thread_id: "dispatcher-thread-123",
        worker: "R-11"
      });

      expect(launchDispatcher).toHaveBeenCalledTimes(1);
      expect(launchDispatchWorker).toHaveBeenCalledWith(expect.objectContaining({
        workerId: "R-11",
        agentType: "codex",
        modelId: "gpt-5.5 high",
        mode: "bridge",
        killPolicy: "always",
        commandFilePath: "/tmp/agent_dispatch_command.md",
        dispatchPlanPath,
        dispatchRepoRoot: tempDir
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("selects the first eligible pending worker through service-owned continue when multiple workers are available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-first-eligible-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const launchDispatcher = vi.fn(async () => ({
      ok: true,
      threadId: "dispatcher-thread-123"
    }));
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-r12"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | R-10 | Foundation | CODEX | — | TaskSpec | done |",
      "| ⬜ | 2 | R-12 | First eligible | CODEX-HIGH | R-10 | TaskSpec | ready |",
      "| ⬜ | 2 | R-13 | Also eligible | CODEX-HIGH | R-10 | TaskSpec | ready |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, launchDispatcher, launchDispatchWorker);
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-first-eligible", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-first-eligible/continue"
      )).resolves.toEqual({
        ok: true,
        status: "continued",
        message: "continued: R-12",
        dispatcher_thread_id: "dispatcher-thread-123",
        worker: "R-12"
      });

      expect(launchDispatcher).toHaveBeenCalledTimes(1);
      expect(launchDispatchWorker).toHaveBeenCalledWith(expect.objectContaining({
        workerId: "R-12",
        dispatchPlanPath
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clears a stale dispatcher thread during continue when attach reports the thread missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-missing-dispatcher-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });
    const launchDispatcher = vi.fn(async () => ({
      ok: true,
      threadId: "dispatcher-thread-123"
    }));
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-r11"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | Ω+2 | R-11 | GUI | CODEX-HIGH | — | TaskSpec | ready |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    });

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        null,
        new Error("attach failed: No registered agent instance found for thread_id=dispatcher-thread-123"),
        null,
        launchDispatcher,
        launchDispatchWorker
      );
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-missing", dispatchPlanPath);

      const response = await invokeJson<Record<string, unknown>>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-missing/continue"
      );

      expect(response).toMatchObject({
        ok: true,
        status: "continued",
        message: "continued: R-11",
        worker: "R-11"
      });
      expect(response).not.toHaveProperty("dispatcher_thread_id");
      expect(lifecycleStore.load().dispatcher.status).toBe("abandoned");
      expect(launchDispatcher).toHaveBeenCalledTimes(1);
      expect(launchDispatchWorker).toHaveBeenCalledWith(expect.objectContaining({
        workerId: "R-11",
        dispatchPlanPath
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
          hub_result: null,
          command_preamble: null,
          retry_count: 0
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

  it("falls back to persisted agent-dispatcher state for POST /api/reconcile after restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-reconcile-persisted-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const commandFilePath = path.join(tempDir, "agent_dispatch_command.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const outputPath = path.join(tempDir, "final.txt");
    const lifecycleStore = new LifecycleStore(sidecarPath);

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 4 | R-04 | Reconcile API Endpoint & Post-HubResult Trigger | CODEX | N-02 | TaskSpec v1.1 | |"
    ].join("\n"), "utf8");
    await fs.writeFile(commandFilePath, "# Worker Command\n", "utf8");
    await fs.writeFile(outputPath, "done\n", "utf8");
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
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    try {
      const harness = createHarness(
        {
          roles: [
            {
              threadId: "agent-dispatcher-rehydrated",
              roleType: "agent-dispatcher",
              config: {
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
              },
              status: "needs_reactivation"
            }
          ],
          promptStore: {}
        },
        undefined,
        [],
        null,
        null,
        async (message) => {
          if (message.thread_id === "dispatcher-thread-123") {
            return buildHubResult("{\"status\":\"running\"}");
          }

          if (message.thread_id === "worker-thread-456") {
            return buildHubResult("{\"status\":\"completed\"}");
          }

          throw new Error(`Unexpected thread lookup: ${message.thread_id}`);
        }
      );

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

  it("resumes a stuck worker through POST /api/roles/:threadId/worker/:workerId/resume", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-resume-route-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 2 | N-04 | Resume Worker Tool | CODEX-XHIGH | R-03 | CLI Integration PRD | running |",
      "| ⬜ | 3 | R-04 | GUI Resume Buttons | CODEX-XHIGH | N-04 | CLI Integration PRD | blocked |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": {
          thread_id: "worker-thread-456",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-04-05T00:00:00.000Z",
          last_seen_at: "2026-04-05T00:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    const killSpy = vi.spyOn(killTool, "execute").mockResolvedValue({
      ok: true,
      data: {
        thread_id: "worker-thread-456"
      }
    });

    try {
      const harness = createHarness();

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-resume",
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

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/roles/agent-dispatcher-resume/worker/N-04/resume",
        {
          action: "skip"
        }
      )).resolves.toEqual({
        ok: true,
        result: {
          worker: "N-04",
          action: "skip",
          status: "skipped",
          thread_id: "worker-thread-456",
          thread_killed: true,
          retry_count: 0
        }
      });

      expect(killSpy).toHaveBeenCalledWith({
        thread_id: "worker-thread-456"
      });
      expect(lifecycleStore.load().workers["N-04"]?.status).toBe("skipped");
      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| ⛔ SKIPPED | 2 | N-04 | Resume Worker Tool | CODEX-XHIGH | R-03 | CLI Integration PRD | running |");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects force-complete without force from the resume worker route", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-resume-route-force-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 2 | N-04 | Resume Worker Tool | CODEX-XHIGH | R-03 | CLI Integration PRD | running |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": {
          thread_id: "worker-thread-456",
          trace_id: null,
          started_at: "2026-04-05T00:00:00.000Z",
          last_seen_at: "2026-04-05T00:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    try {
      const harness = createHarness();

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-resume-force",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }]
      });

      const request = createJsonRequest(
        "POST",
        "/api/roles/agent-dispatcher-resume-force/worker/N-04/resume",
        {
          action: "force-complete"
        }
      );
      const response = createJsonResponse();

      const handled = await harness.roleHandlers.handle(request, response.raw);

      expect(handled).toBe(true);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "force-complete requires force=true"
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates a tracked worker status through PATCH /api/roles/:threadId/worker/:workerId/status", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-status-route-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 2 | N-04 | Resume Worker Tool | CODEX-XHIGH | R-03 | CLI Integration PRD | done |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": {
          thread_id: "worker-thread-456",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-04-05T00:00:00.000Z",
          last_seen_at: "2026-04-05T00:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-456",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Completed once already.",
            summary_text: "Completed once already.",
            details_text: "Agent reply:\nCompleted once already.",
            attachments: [],
            timestamp: "2026-04-05T00:10:00.000Z"
          },
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    try {
      const harness = createHarness();

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-status-update",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }]
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "PATCH",
        "/api/roles/agent-dispatcher-status-update/worker/N-04/status",
        {
          status: "pending"
        }
      )).resolves.toEqual({
        ok: true,
        result: {
          worker: "N-04",
          status: "pending",
          thread_id: "worker-thread-456",
          lifecycle_updated: true
        }
      });

      expect(lifecycleStore.load().workers["N-04"]?.status).toBe("pending");
      // Explicit status changes must override the terminal-success guard so
      // that completed workers can be redone from both the GUI and the CLI.
      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| ⬜ | 2 | N-04 | Resume Worker Tool | CODEX-XHIGH | R-03 | CLI Integration PRD | done |");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates markdown-only worker rows through PATCH /api/roles/:threadId/worker/:workerId/status", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-status-route-markdown-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 3 | R-04 | GUI Resume Buttons | CODEX-XHIGH | N-04 | CLI Integration PRD | done |"
    ].join("\n"), "utf8");

    try {
      const harness = createHarness();

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-status-markdown",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }]
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "PATCH",
        "/api/roles/agent-dispatcher-status-markdown/worker/R-04/status",
        {
          status: "skipped"
        }
      )).resolves.toEqual({
        ok: true,
        result: {
          worker: "R-04",
          status: "skipped",
          thread_id: null,
          lifecycle_updated: false
        }
      });

      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| ⛔ SKIPPED | 3 | R-04 | GUI Resume Buttons | CODEX-XHIGH | N-04 | CLI Integration PRD | done |");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("GET /api/channels", () => {
    beforeEach(() => {
      vi.stubEnv("ALLOWED_USER_IDS", "");
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      vi.stubEnv("TELEGRAM_BOT_TOKENS", "");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
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
        ],
        telegram_bot_numeric_ids: [],
        telegram_allowed_user_ids: []
      });
    });

    it("falls back to an empty channel list when the registry lookup fails and env has no presets", async () => {
      const harness = createHarness(undefined, undefined, new Error("hub unavailable"));

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/channels")).resolves.toEqual({
        channels: [],
        telegram_bot_numeric_ids: [],
        telegram_allowed_user_ids: []
      });
    });

    it("merges Telegram presets from ALLOWED_USER_IDS and bot tokens when hub lookup fails", async () => {
      vi.stubEnv("ALLOWED_USER_IDS", "6137086342");
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "7628441374:AAFx");

      const harness = createHarness(undefined, undefined, new Error("hub unavailable"));

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/channels")).resolves.toEqual({
        channels: [
          {
            channel: "telegram",
            chat_id: "telegram:6137086342",
            bot_id: "7628441374",
            chat_name: "Allowed operator 6137086342 (ALLOWED_USER_IDS · bot 7628441374)"
          }
        ],
        telegram_bot_numeric_ids: ["7628441374"],
        telegram_allowed_user_ids: ["6137086342"]
      });
    });

    it("dedupes hub channels against env presets with the same channel, chat_id, and bot_id", async () => {
      vi.stubEnv("ALLOWED_USER_IDS", "6137086342");
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "7628441374:AAFx");

      const harness = createHarness(undefined, undefined, [
        {
          channel: "telegram",
          chat_id: "telegram:6137086342",
          bot_id: "7628441374",
          chat_name: "Hub label"
        }
      ]);

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/channels")).resolves.toEqual({
        channels: [
          {
            channel: "telegram",
            chat_id: "telegram:6137086342",
            bot_id: "7628441374",
            chat_name: "Hub label"
          }
        ],
        telegram_bot_numeric_ids: ["7628441374"],
        telegram_allowed_user_ids: ["6137086342"]
      });
    });
  });

  it("returns enriched agent-dispatcher detail for the dashboard and role view", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T01:00:00.000Z"));

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Model | Code | Provider | Model ID | Assign When |",
      "|-------|------|----------|----------|-------------|",
      "| Codex XHigh | CODEX-XHIGH | codex | gpt-5.4 xhigh | Architecture and deep integration |",
      "| Codex | CODEX | codex | gpt-5.4 medium | Straightforward implementation work |",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 4 | N-09 | Pre-flight | CODEX | — | PRD v2.2 | plan-only history |",
      "| ✅ | 5 | N-10 | API Layer | CODEX-XHIGH | N-09 | PRD v2.2 | ready |",
      "| 🔄 | 6 | N-11 | GUI | CODEX | N-10 | PRD v2.2 | running |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-03-27T23:55:00.000Z",
        status: "running"
      },
      workers: {
        "N-10": {
          thread_id: "worker-thread-123",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-03-27T23:56:00.000Z",
          last_seen_at: "2026-03-27T23:57:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "codex_17",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Completed API layer.",
            details_text: [
              "Your message:",
              "Implement N-10 API layer",
              "",
              "Agent reply:",
              "Completed API layer."
            ].join("\n"),
            attachments: [],
            timestamp: "2026-03-27T23:57:00.000Z"
          }
        },
        "N-11": {
          thread_id: "worker-thread-456",
          trace_id: "22222222-2222-4222-8222-222222222222",
          started_at: "2026-03-28T00:00:00.000Z",
          last_seen_at: "2026-03-28T00:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null
        }
      },
      last_reconciled_at: null
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
        tasks: expect.arrayContaining([
          expect.objectContaining({
            task_id: "N-09",
            status: "done",
            depends_on: []
          }),
          expect.objectContaining({
            task_id: "N-10",
            status: "done",
            depends_on: ["N-09"]
          }),
          expect.objectContaining({
            task_id: "N-11",
            status: "running",
            depends_on: ["N-10"]
          })
        ]),
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
        dispatch_details: expect.arrayContaining([
          expect.objectContaining({
            worker_id: "N-09",
            status: "completed",
            task: "Pre-flight",
            model: "CODEX",
            applied_model: "gpt-5.4 medium",
            worker_thread_id: "",
            trace_id: null,
            command: null,
            reply: null
          }),
          expect.objectContaining({
            worker_id: "N-10",
            status: "completed",
            task: "API Layer",
            model: "CODEX-XHIGH",
            applied_model: "gpt-5.4 xhigh",
            trace_id: "11111111-1111-4111-8111-111111111111",
            command: expect.objectContaining({
              trace_id: "11111111-1111-4111-8111-111111111111",
              sender_name: "dispatcher-thread-123",
              sender_agent_type: "codex",
              sender_model: null,
              timestamp: "2026-03-27T23:56:00.000Z",
              content: "Implement N-10 API layer"
            }),
            reply: expect.objectContaining({
              trace_id: "11111111-1111-4111-8111-111111111111",
              sender_name: "codex_17",
              sender_agent_type: "codex",
              sender_model: "gpt-5.4 xhigh",
              timestamp: "2026-03-27T23:57:00.000Z",
              content: "Completed API layer."
            })
          }),
          expect.objectContaining({
            worker_id: "N-11",
            status: "running",
            task: "GUI",
            model: "CODEX",
            applied_model: "gpt-5.4 medium",
            trace_id: "22222222-2222-4222-8222-222222222222",
            command: null,
            reply: null
          })
        ]),
        dispatch_plan: {
          rows: expect.arrayContaining([
            expect.objectContaining({
              status: "✅",
              worker: "N-09",
              stale: false
            }),
            expect.objectContaining({
              status: "✅",
              worker: "N-10",
              stale: false
            }),
            expect.objectContaining({
              status: "🔄",
              worker: "N-11",
              stale: true,
              stale_label: "⚠️ STALE",
              stale_duration_minutes: 60,
              last_seen_at: "2026-03-28T00:00:00.000Z",
              thread_id: "worker-thread-456"
            })
          ])
        }
      });
      expect(attachToThread).toHaveBeenCalledWith("dispatcher-thread-123");
    } finally {
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads Function Group dispatch tables in agent-dispatcher detail responses", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-function-group-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Function Group | Cases | Model | Depends On | Report File |",
      "|--------|-------|--------|----------------|-------|-------|------------|-------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment health check | — | CODEX | — | `reports/PRE-FLIGHT.md` |",
      "| ✅ | 1 | E-01 | Auth session | 8 | CODEX | PRE-FLIGHT | `reports/E-01.md` |",
      "| ✅ | 1 | E-02 | File adapter | 14 | CODEX | PRE-FLIGHT | `reports/E-02.md` |",
      "| ⬜ | Ω | SUMMARY-GATE | Sector validation report | — | OPUS | all E-XX | `reports/sector_validation_report.md` |"
    ].join("\n"), "utf8");

    try {
      const harness = createHarness();

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-function-group",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always"
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "GET",
        "/api/role/agent-dispatcher-function-group"
      )).resolves.toMatchObject({
        thread_id: "agent-dispatcher-function-group",
        continue_worker: "SUMMARY-GATE",
        dispatch_plan: {
          rows: expect.arrayContaining([
            expect.objectContaining({
              status: "✅",
              worker: "PRE-FLIGHT",
              task: "Environment health check",
              model: "CODEX"
            }),
            expect.objectContaining({
              status: "⬜",
              worker: "SUMMARY-GATE",
              task: "Sector validation report",
              model: "OPUS",
              depends_on: "all E-XX"
            })
          ])
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("shows failed dispatch detail status when a completed hub result contains a blocking report", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-blocked-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ❌ | 0 | PRE-FLIGHT | Env health check | CODEX-HIGH | — | TaskSpec | blocks all batches |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-27T04:00:00.000Z",
        status: "running"
      },
      workers: {
        "PRE-FLIGHT": buildLifecycleWorker({
          thread_id: "codex_05",
          status: "completed",
          expected_outputs: [path.join(tempDir, "reports", "PRE-FLIGHT.md")],
          hub_result: {
            ...buildHubResult([
              "⛔ BLOCKED — PRE-FLIGHT cannot certify the baseline.",
              "",
              "`npx tsc --noEmit` exits `1` because the repo root has no `tsconfig.json`."
            ].join("\n")),
            trace_id: "33333333-3333-4333-8333-333333333333",
            thread_id: "codex_05"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-blocked-detail", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "GET",
        "/api/role/agent-dispatcher-blocked-detail"
      )).resolves.toMatchObject({
        tasks: [
          expect.objectContaining({
            task_id: "PRE-FLIGHT",
            status: "failed"
          })
        ],
        dispatch_details: [
          expect.objectContaining({
            worker_id: "PRE-FLIGHT",
            status: "failed",
            reply: expect.objectContaining({
              content: expect.stringContaining("⛔ BLOCKED")
            })
          })
        ],
        dispatch_plan: {
          rows: [
            expect.objectContaining({
              worker: "PRE-FLIGHT",
              lifecycle_status: "failed"
            })
          ]
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("demotes dispatcher lifecycle state during detail fetch when attach reports the thread missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-missing-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 6 | N-11 | GUI | CODEX | N-10 | PRD v2.2 | ready |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    });

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        "unused",
        new Error("attach failed: No registered agent instance found for thread_id=dispatcher-thread-123")
      );

      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-missing-detail", dispatchPlanPath);

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-missing-detail")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-missing-detail",
        status: "needs_reactivation",
        dispatcher_thread_id: null,
        session_log: expect.arrayContaining([
          "Role status: needs_reactivation",
          "Dispatcher lifecycle was demoted after Hub reported the thread missing."
        ])
      });
      expect(lifecycleStore.load().dispatcher.status).toBe("abandoned");
      expect((await harness.stateStore.load())?.roles.find((role) => role.threadId === "agent-dispatcher-missing-detail")?.status)
        .toBe("needs_reactivation");
      await expect(invokeJson<Array<{ thread_id: string; status: string }>>(harness.roleHandlers, "GET", "/api/roles")).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thread_id: "agent-dispatcher-missing-detail",
            status: "needs_reactivation"
          })
        ])
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not surface the synthetic DISPATCHER entry as the current running worker", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-synthetic-worker-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 6 | N-11 | GUI | CODEX | N-10 | PRD v2.2 | ready |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "DISPATCHER": buildLifecycleWorker({
          thread_id: "dispatcher-thread-123",
          status: "running"
        })
      },
      last_reconciled_at: null
    });

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        "unused",
        new Error("attach failed: No registered agent instance found for thread_id=dispatcher-thread-123")
      );

      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-synthetic-worker", dispatchPlanPath);

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-synthetic-worker")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-synthetic-worker",
        status: "needs_reactivation",
        dispatcher_thread_id: null,
        current_worker: null,
        dispatch_details: []
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces the raw empty detail-cache message with structured dispatcher context", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-empty-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
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
        "No cached detail found. Send a new request first, then run /detail again.",
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
        dispatcher_thread_id: "dispatcher-thread-123",
        current_worker: "N-11",
        last_log_line: "Dispatcher detail cache is empty. Send a new request to the dispatcher, then refresh this page.",
        session_log: [
          "Role status: active",
          `Dispatch plan: ${dispatchPlanPath}`,
          "Dispatcher thread: dispatcher-thread-123",
          "Current worker: N-11",
          "Worker thread: worker-thread-456",
          "Worker started: 2026-03-28T00:00:00.000Z",
          "Dispatcher detail cache is empty. Send a new request to the dispatcher, then refresh this page."
        ]
      });
      expect(attachToThread).toHaveBeenCalledWith("dispatcher-thread-123");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to persisted dispatcher history when the live detail cache is empty", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-persisted-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 6 | R-11 | GUI | CODEX-HIGH | N-10 | PRD v2.2 | ready |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "DISPATCHER": buildLifecycleWorker({
          thread_id: "dispatcher-thread-123",
          status: "completed",
          hub_result: {
            trace_id: "33333333-3333-4333-8333-333333333333",
            thread_id: "dispatcher-thread-123",
            source: "codex",
            status: "success",
            content: "Dispatcher paused.",
            details_text: [
              "Your message:",
              "Review the live plan and select the next worker.",
              "",
              "Agent reply:",
              "The next eligible worker is R-11."
            ].join("\n"),
            attachments: [],
            timestamp: "2026-04-08T00:21:00.000Z"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const attachToThread = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness(
        undefined,
        undefined,
        [],
        "No cached detail found. Send a new request first, then run /detail again.",
        attachToThread
      );

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-persisted-detail",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always"
      });

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-persisted-detail")).resolves.toMatchObject({
        dispatcher_thread_id: "dispatcher-thread-123",
        last_log_line: "The next eligible worker is R-11.",
        session_log: expect.arrayContaining([
          "Persisted dispatcher history:",
          "Your message:",
          "Review the live plan and select the next worker.",
          "Agent reply:",
          "The next eligible worker is R-11."
        ])
      });
      expect(attachToThread).toHaveBeenCalledWith("dispatcher-thread-123");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not expose a stale dispatcher thread id after lifecycle marked the dispatcher unavailable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-stale-thread-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-stale-thread",
          roleType: "agent-dispatcher",
          status: "needs_reactivation",
          config: {
            tasks: [],
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
            kill_policy: "always",
            use_agent_dispatcher: true
          }
        }
      ],
      promptStore: {}
    };

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 7 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | awaiting restart |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: "2026-04-07T14:00:00.000Z",
        status: "abandoned"
      },
      workers: {},
      last_reconciled_at: "2026-04-07T14:15:00.000Z"
    }, null, 2)}\n`, "utf8");

    try {
      const attachToThread = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness(persistedState, undefined, [], "unused", attachToThread);

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-stale-thread")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-stale-thread",
        status: "needs_reactivation",
        dispatcher_thread_id: null,
        current_worker: null,
        session_log: [
          "Role status: needs_reactivation",
          `Dispatch plan: ${dispatchPlanPath}`,
          "Dispatcher thread: pending",
          "Current worker: idle"
        ]
      });
      expect(attachToThread).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects needs_reactivation from /api/roles when lifecycle already marked the dispatcher abandoned", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-list-stale-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-list-stale",
          roleType: "agent-dispatcher",
          status: "active",
          config: {
            tasks: [],
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
            kill_policy: "always",
            use_agent_dispatcher: true
          }
        }
      ],
      promptStore: {}
    };

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 7 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | awaiting restart |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: "2026-04-07T14:00:00.000Z",
        status: "abandoned"
      },
      workers: {},
      last_reconciled_at: "2026-04-07T14:15:00.000Z"
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(persistedState);

      await expect(invokeJson<Array<{ thread_id: string; status: string }>>(harness.roleHandlers, "GET", "/api/roles")).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thread_id: "agent-dispatcher-list-stale",
            status: "needs_reactivation",
            task_count: 1
          })
        ])
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects completed for finished agent-dispatcher plans instead of persisted active", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-list-complete-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-list-complete",
          roleType: "agent-dispatcher",
          status: "active",
          config: {
            tasks: [],
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
            kill_policy: "always",
            use_agent_dispatcher: true
          }
        }
      ],
      promptStore: {}
    };

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | R-01 | Complete work | CODEX | — | PRD | done |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "completed"
      },
      workers: {
        "R-01": buildLifecycleWorker({
          status: "completed"
        })
      },
      last_reconciled_at: "2026-04-07T14:15:00.000Z"
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(persistedState);

      await expect(invokeJson<Array<{ thread_id: string; status: string }>>(harness.roleHandlers, "GET", "/api/roles")).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thread_id: "agent-dispatcher-list-complete",
            status: "completed",
            task_count: 1
          })
        ])
      );
      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-list-complete")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-list-complete",
        status: "completed",
        current_worker: null
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clears sticky terminal agent-dispatcher status when the plan is no longer terminal", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-list-retry-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-retry-active",
          roleType: "agent-dispatcher",
          status: "failed",
          config: {
            tasks: [],
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
            kill_policy: "always",
            use_agent_dispatcher: true
          }
        }
      ],
      promptStore: {}
    };

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | Ω-1 | V-01-A | Retry verification | CODEX-XHIGH | BATCH-2-GATE | TaskSpec | running retry |",
      "| ⬜ | Ω-1 | V-01-B | Human verification | HUMAN | V-01-A | TaskSpec | human follow-up |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "pending"
      },
      workers: {
        "V-01-A": buildLifecycleWorker({
          status: "running"
        })
      },
      last_reconciled_at: "2026-04-07T14:15:00.000Z"
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(persistedState);

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-retry-active")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-retry-active",
        status: "active",
        current_worker: "V-01-A"
      });
      expect((await harness.stateStore.load())?.roles.find((role) => role.threadId === "agent-dispatcher-retry-active")?.status)
        .toBe("active");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects scheduler run state from /api/roles instead of persisted active", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-scheduler-list-status-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const schedulerStatePath = path.join(tempDir, "scheduler_state.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "scheduler-list-waiting",
          roleType: "scheduler",
          status: "active",
          config: {
            dispatch_plan_path: dispatchPlanPath,
            command_file_path: path.join(tempDir, "agent_dispatch_command.md"),
            dispatch_repo_root: tempDir,
            docs_root: tempDir,
            user_reply_channels: [
              {
                channel: "web",
                chat_id: "web:ops"
              }
            ],
            agent_type: "codex",
            mode: "pane_bridge",
            kill_policy: "always",
            auto_approve: true,
            scheduler_mode: "cron",
            cron_expression: "0 6 * * *",
            timezone: "Asia/Tokyo",
            report_base_dir: path.join(tempDir, "reports"),
            catch_up_policy: "skip_missed"
          }
        }
      ],
      promptStore: {}
    };

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 1 | R-01 | Active scheduler task | CODEX | — | PRD | running |",
      "| ⬜ | 1 | R-02 | Pending scheduler task | CODEX | R-01 | PRD | pending |"
    ].join("\n"), "utf8");
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      status: "waiting",
      current_run_id: null,
      current_dispatcher_thread_id: null,
      completed_cycles: 1,
      next_run_at: "2026-04-26T21:00:00.000Z",
      last_run_completed_at: "2026-04-26T06:52:50.422Z",
      last_run_outcome: "completed",
      last_report_path: null,
      plan_lock_owner: null,
      run_history: []
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(persistedState);

      await expect(invokeJson<Array<{ thread_id: string; status: string }>>(harness.roleHandlers, "GET", "/api/roles")).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thread_id: "scheduler-list-waiting",
            role_type: "scheduler",
            status: "waiting",
            task_count: 2
          })
        ])
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects config patches with unrecognized fields with 400", async () => {
    const harness = createHarness(createPersistedState({
      tasks: [],
      taskspec: "existing"
    }));

    await expect(
      harness.roleHandlers.patchConfig("dispatcher-1", {
        tasks: [],
        taskspec: "next"
      })
    ).rejects.toMatchObject({
      statusCode: 400
    });
  });

  it("logs attach failures with dispatcher thread and role context", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-attach-log-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 6 | N-11 | GUI | CODEX | N-10 | PRD v2.2 | running |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {}
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        "Dispatcher detail",
        new Error("attach failed")
      );

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-attach-log",
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

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-attach-log")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-attach-log"
      });
      expect(harness.log.warn).toHaveBeenCalledWith(
        "Failed to attach dispatcher session before detail fetch",
        expect.objectContaining({
          thread_id: "dispatcher-thread-123",
          role_id: "agent-dispatcher-attach-log",
          error: "attach failed"
        })
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reactivates persisted agent-dispatcher when start-dispatcher-hub targets inactive role", async () => {
    const persistedState: AppState = {
      roles: [
        {
          threadId: "ad-persisted-1",
          roleType: "agent-dispatcher",
          config: {
            dispatch_plan_path: "/tmp/dispatch_plan.md",
            command_file_path: "/tmp/agent_dispatch_command.md",
            tasks: [],
            user_reply_channels: [{ channel: "web", chat_id: "test" }],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always"
          },
          status: "needs_reactivation"
        }
      ],
      promptStore: {}
    };

    const harness = createHarness(persistedState);

    const result = await invokeJson<{ ok: boolean; dispatcher_thread_id: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/ad-persisted-1/start-hub"
    );

    expect(result.ok).toBe(true);
    expect(result.dispatcher_thread_id).toBe("dispatcher-thread-123");
  });

  it("reactivates persisted agent-dispatcher when resume targets inactive role", async () => {
    const persistedState: AppState = {
      roles: [
        {
          threadId: "ad-persisted-2",
          roleType: "agent-dispatcher",
          config: {
            dispatch_plan_path: "/tmp/dispatch_plan.md",
            command_file_path: "/tmp/agent_dispatch_command.md",
            tasks: [],
            user_reply_channels: [{ channel: "web", chat_id: "test" }],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always"
          },
          status: "active"
        }
      ],
      promptStore: {}
    };

    const harness = createHarness(persistedState);

    const result = await invokeJson<{ ok: boolean; status: string }>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/ad-persisted-2/resume"
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("active");
  });
});

function createHarness(
  initialState?: AppState,
  stateStore = new MemoryStateStore(initialState ?? null),
  replyChannels: ReplyChannel[] | Error = [],
  threadDetail: string | Error | null = null,
  attachToThread: ((threadId: string) => Promise<void>) | Error | null = null,
  sendHubRequest: ((message: HubMessage) => Promise<HubResult>) | Error | null = null,
  launchDispatcher: ((config: LaunchConfig) => Promise<LaunchResult>) | null = null,
  launchDispatchWorker: ((config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult>) | null = null
) {
  const log = createLogger();
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: async () => undefined,
    listInstances: () => [],
    log
  });

  const agentDispatcherFactory = (threadId: string, config: unknown) => new AgentDispatcherRole(threadId, config, {
    stateStore,
    buildSystemPrompt: () => "test system prompt",
    launchDispatcher: launchDispatcher ?? (async () => ({
      ok: true,
      threadId: "dispatcher-thread-123"
    })),
    sessionManagerFactory: () => ({
      getDispatcherThreadId: () => "dispatcher-thread-123",
      initSession: async () => undefined,
      isPaused: () => false,
      prepareFreshDispatcherLaunch: async () => undefined,
      onRestart: async () => ({
        staleWorkersKilled: [],
        dispatcherRestarted: true
      }),
      setPaused: () => undefined
    }),
    readWorkersByStatus: async () => [],
    lifecycleStoreFactory: () => ({
      load: () => ({
        version: 2,
        dispatcher: {
          thread_id: null,
          started_at: null,
          status: "pending"
        },
        workers: {},
        last_reconciled_at: null
      }),
      save: () => undefined
    }),
    killThread: async () => undefined,
    signalDispatcher: async () => undefined
  });
  registry.register("dispatcher", agentDispatcherFactory);
  registry.register("agent-dispatcher", agentDispatcherFactory);

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
    log,
    registry,
    runner,
    stateStore,
    roleHandlers: createRoleHandlers({
      ...roleHandlersOptions,
      launchDispatchWorker: launchDispatchWorker ?? (async () => ({
        ok: true,
        threadId: "worker-thread-continued"
      })),
      log
    })
  };
}

async function createRole(roleHandlers: RoleHandlers, body: unknown): Promise<void> {
  const request = createJsonRequest("POST", "/api/agent-dispatcher/start", body);
  const response = createJsonResponse();
  const handled = await roleHandlers.handle(request, response.raw);

  expect(handled).toBe(true);
  expect(response.statusCode).toBe(201);
}

async function createAgentDispatcherRole(
  roleHandlers: RoleHandlers,
  threadId: string,
  dispatchPlanPath: string
): Promise<void> {
  await createRole(roleHandlers, {
    thread_id: threadId,
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

function buildLifecycleWorker(overrides: Partial<DispatchWorkerState> = {}): DispatchWorkerState {
  return {
    thread_id: "worker-thread-456",
    trace_id: "11111111-1111-4111-8111-111111111111",
    started_at: "2026-04-05T00:00:00.000Z",
    last_seen_at: "2026-04-05T00:00:00.000Z",
    status: "running",
    expected_outputs: [],
    hub_result: null,
    command_preamble: null,
    retry_count: 0,
    ...overrides
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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}
