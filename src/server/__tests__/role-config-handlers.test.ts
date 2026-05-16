import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { createMeridianApiClient } from "../../roles/agent-dispatcher/meridian-api-client";
import { AgentDispatcherRole } from "../../roles/definitions/agent-dispatcher";
import type { LaunchConfig, LaunchResult } from "../../roles/agent-dispatcher/launcher";
import type { PmResolverRequest, PmResolverResult } from "../../roles/agent-dispatcher/pm-resolver";
import type { LaunchDispatchWorkerConfig, LaunchDispatchWorkerResult } from "../../roles/agent-dispatcher/worker-launcher";
import { PromptStore } from "../../roles/prompt-store";
import { RoleRegistry } from "../../roles/role-registry";
import { RoleRunner } from "../../roles/role-runner";
import killTool from "../../tool-gateway/tools/kill";
import updateStatusTool from "../../tool-gateway/tools/update-status";
import { resetCallerIdentityCache } from "../../shared/caller-identity";
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
        auto_approve: false,
        pm_resolver: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          user_reply_channels: [
            {
              channel: "telegram",
              chat_id: "telegram:ops"
            }
          ]
        }
      }
    });
  });

  it("starts the configured PM resolver for an abnormal dispatcher state", async () => {
    const startPmResolver = vi.fn(async (): Promise<PmResolverResult> => ({
      ok: true,
      status: "pm_resolver_started",
      thread_id: "pm-thread-123",
      message: "PM resolver started"
    }));
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      startPmResolver
    );

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-pm",
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

    await expect(invokeJson<PmResolverResult>(
      harness.roleHandlers,
      "POST",
      "/api/agent-dispatcher/agent-dispatcher-pm/pm-resolve",
      {
        status: "manual_intervention_required",
        worker_id: "W-02",
        message: "Worker is blocked",
        error: "Missing credentials"
      }
    )).resolves.toEqual({
      ok: true,
      status: "pm_resolver_started",
      thread_id: "pm-thread-123",
      message: "PM resolver started"
    });

    expect(startPmResolver).toHaveBeenCalledWith({
      dispatcherId: "agent-dispatcher-pm",
      config: expect.objectContaining({
        pm_resolver: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          user_reply_channels: [
            {
              channel: "telegram",
              chat_id: "telegram:ops"
            }
          ]
        }
      }),
      issue: {
        status: "manual_intervention_required",
        workerId: "W-02",
        message: "Worker is blocked",
        error: "Missing credentials",
        source: "dispatcher"
      },
      otherDispatchPlanPaths: []
    });
  });

  // Regression: agent-dispatcher-738fb284 / PRE-FLIGHT spawned two PM resolvers
  // for the same `needs_pm` issue — watchdog auto-fired codex_07 (source
  // "watchdog") and the dispatcher LLM independently fired codex_08 via the
  // meridian-tool `pm-resolve` command ~47s later. Both ran in parallel against
  // the same worker. The /pm-resolve handler must refuse when a running PM
  // already targets the requested worker.
  it("does not spawn a second PM resolver while one is already running for the same worker", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolve-duplicate-"));
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
      "| ❌ | 1 | PRE-FLIGHT | Preflight checks | CODEX | — | TaskSpec | needs PM |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-preflight",
        started_at: "2026-05-11T20:58:49.597Z",
        status: "running"
      },
      workers: {
        "PRE-FLIGHT": buildLifecycleWorker({
          thread_id: "codex_06",
          status: "blocked",
          retry_count: 0
        })
      },
      pm_resolvers: [
        {
          thread_id: "codex_07",
          status: "running",
          started_at: "2026-05-11T21:03:28.935Z",
          last_seen_at: "2026-05-11T21:03:28.935Z",
          agent_type: "codex",
          model_id: "gpt-5.5",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "PRE-FLIGHT",
            message: "watchdog requested PM resolution",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: null
    });

    const startPmResolver = vi.fn(async (): Promise<PmResolverResult> => ({
      ok: true,
      status: "pm_resolver_started",
      thread_id: "should-not-spawn",
      message: "should-not-spawn"
    }));

    try {
      const harness = createHarness(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        startPmResolver
      );

      await createAgentDispatcherRole(
        harness.roleHandlers,
        "agent-dispatcher-pm-duplicate",
        dispatchPlanPath
      );

      await expect(invokeJson<PmResolverResult>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-pm-duplicate/pm-resolve",
        {
          status: "manual_intervention_required",
          worker_id: "PRE-FLIGHT",
          message: "PRE-FLIGHT needs PM",
          source: "dispatcher"
        }
      )).resolves.toEqual({
        ok: true,
        status: "pm_resolver_already_running",
        thread_id: "codex_07",
        message: "PM resolver codex_07 is already resolving worker PRE-FLIGHT"
      });

      expect(startPmResolver).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // Regression: agent-dispatcher-67f6a3fc V-01-A 2026-05-15. The PM run
  // rejected with "Request timed out — the hub may be overloaded", which
  // `recordPmResolverTransportStall` retains as a `running` entry with
  // `transport_error` set so the operator can take over via the GUI
  // talk-box. The /pm-resolve handler probed hub via
  // `findLivePmResolversForWorker`, hub returned `missing` (agent never
  // attached), the entry was demoted to `failed`, and a brand-new PM was
  // spawned — straight into the same overloaded hub. The handler must
  // honor the transport-stall retention and short-circuit with
  // `pm_resolver_already_running` so the spawn storm cannot start.
  it("does not respawn when the existing PM is transport-stalled (hub overloaded)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolve-transport-stall-"));
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
      "| ❌ | 5 | V-01-A | Validation | CODEX | — | TaskSpec | failed |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-transport-stall",
        started_at: "2026-05-15T04:00:00.000Z",
        status: "running"
      },
      workers: {
        "V-01-A": buildLifecycleWorker({
          thread_id: "codex_06",
          status: "failed",
          retry_count: 0
        })
      },
      pm_resolvers: [
        {
          thread_id: "codex_08",
          status: "running",
          started_at: "2026-05-15T04:54:03.316Z",
          last_seen_at: "2026-05-15T04:54:03.316Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "V-01-A",
            message: "manual intervention required: V-01-A reported a failed outcome",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: "run failed: Request timed out — the hub may be overloaded.",
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: null
    });

    const startPmResolver = vi.fn(async (): Promise<PmResolverResult> => ({
      ok: true,
      status: "pm_resolver_started",
      thread_id: "should-not-spawn",
      message: "should-not-spawn"
    }));

    try {
      const harness = createHarness(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        startPmResolver
      );

      await createAgentDispatcherRole(
        harness.roleHandlers,
        "agent-dispatcher-pm-transport-stall",
        dispatchPlanPath
      );

      await expect(invokeJson<PmResolverResult>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-pm-transport-stall/pm-resolve",
        {
          status: "manual_intervention_required",
          worker_id: "V-01-A",
          message: "V-01-A needs PM",
          source: "dispatcher"
        }
      )).resolves.toEqual({
        ok: true,
        status: "pm_resolver_already_running",
        thread_id: "codex_08",
        message: "PM resolver codex_08 is already resolving worker V-01-A"
      });

      expect(startPmResolver).not.toHaveBeenCalled();

      // The transport-stalled entry must remain `running` with its
      // transport_error intact so the GUI surfaces it for human takeover.
      const after = lifecycleStore.load();
      const entry = (after.pm_resolvers ?? []).find((e) => e.thread_id === "codex_08");
      expect(entry?.status).toBe("running");
      expect(entry?.transport_error).toBe(
        "run failed: Request timed out — the hub may be overloaded."
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
        threshold_type: "binary",
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
          mode: "stateless_call",
          auto_approve: false,
          threshold_type: "binary",
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
          threshold_type: "binary",
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
        threshold_type: "binary",
        pass_threshold: 0.9,
        max_fix_cycles: 1,
        base_branch: "main"
      }
    })).resolves.toMatchObject({
      config: {
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "stateless_call",
          auto_approve: false,
          threshold_type: "binary",
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
          threshold_type: "binary",
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
      // After the launch-initiated synchronous lifecycle write
      // (recordWorkerLaunchInitiated), the worker is bound to its fresh
      // thread immediately on continue, so the row reflects "running"
      // and the plan markdown syncs to 🔄. resume_worker still ran
      // (retry_count incremented to 1) — the test's pre-existing
      // assertion on resume_result captures that earlier transition.
      const r08AfterContinue = lifecycleStore.load().workers["R-08"];
      expect(r08AfterContinue?.status).toBe("running");
      expect(r08AfterContinue?.thread_id?.trim().length ?? 0).toBeGreaterThan(0);
      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| 🔄 | 5 | R-08 | Delta Check | CODEX | R-07 | CLI Integration PRD | local IPC failed |");
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

  // Regression for agent-dispatcher-4db5c870: after a service restart the
  // PM resolver lifecycle row stayed `running` (its Hub thread was already
  // dead). The dispatcher's continue path had no PM-active gate, so it
  // happily relaunched the same worker every tick, racing the dead PM and
  // never updating the worker bar. The new gate refuses to launch while a
  // PM is `running` for the same worker; the startup probe demotes truly-
  // dead PMs to `failed` so they don't permanently block this path.
  it("does not relaunch a worker while a PM resolver is still running for it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-pm-active-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-should-not-launch"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ❌ | 1 | C-01 | Implement contract | CODEX | — | TaskSpec | failed once |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-c01",
        started_at: "2026-05-09T03:59:17.681Z",
        status: "running"
      },
      workers: {
        "C-01": buildLifecycleWorker({
          thread_id: "worker-thread-c01",
          status: "failed",
          retry_count: 1
        })
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-c01",
          status: "running",
          started_at: "2026-05-09T04:00:46.316Z",
          last_seen_at: "2026-05-09T04:00:46.316Z",
          agent_type: "codex",
          model_id: null,
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "C-01",
            message: "PM is resolving C-01 block",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: null
    });

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-pm-active", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/roles/agent-dispatcher-continue-pm-active/worker/C-01/continue"
      )).resolves.toMatchObject({
        ok: true,
        status: "still_blocked",
        worker: "C-01",
        pm_resolver_thread_ids: ["pm-thread-c01"],
        message: expect.stringContaining("PM resolver(s) pm-thread-c01 resolving worker C-01")
      });

      expect(launchDispatchWorker).not.toHaveBeenCalled();
      expect(lifecycleStore.load().workers["C-01"]?.status).toBe("failed");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // Regression: agent-dispatcher-8eb13a31 / BATCH-3-GATE wedged on a PM
  // resolver thread_id (codex_11) that the Hub had no record of. The PM had
  // been registered briefly and then the agentapi spawn-retry got allocated
  // a different thread_id (codex_12), so dispatch_threads.json kept pointing
  // at the orphaned codex_11 while the relaunch gate read it as live. The
  // continue path now probes the Hub for each `running` PM and demotes
  // hub-missing entries before the gate decision so the dispatcher can
  // resume.
  it("evicts a hub-missing PM resolver so the worker is no longer wedged", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-pm-hub-missing-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-c01-relaunched"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ❌ | 1 | C-01 | Implement contract | CODEX | — | TaskSpec | wedged behind a PM |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-c01",
        started_at: "2026-05-13T03:59:17.681Z",
        status: "running"
      },
      workers: {
        "C-01": buildLifecycleWorker({
          thread_id: "worker-thread-c01",
          status: "failed",
          retry_count: 0
        })
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-c01-orphan",
          status: "running",
          started_at: "2026-05-13T04:00:46.316Z",
          last_seen_at: "2026-05-13T04:00:46.316Z",
          agent_type: "codex",
          model_id: null,
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "C-01",
            message: "PM is resolving C-01 block",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: null
    });

    const sendHubRequest = vi.fn(async (message: HubMessage): Promise<HubResult> => {
      if (message.intent === "status" && message.target === "pm-thread-c01-orphan") {
        return {
          trace_id: "trace-status-pm-missing",
          thread_id: "pm-thread-c01-orphan",
          source: "codex",
          status: "error",
          content: "No registered agent instance found for thread_id=pm-thread-c01-orphan",
          attachments: [],
          timestamp: "2026-05-13T04:05:00.000Z"
        };
      }
      throw new Error(`unexpected hub request: ${message.intent} ${message.target}`);
    });

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        null,
        null,
        sendHubRequest,
        null,
        launchDispatchWorker
      );
      await createAgentDispatcherRole(
        harness.roleHandlers,
        "agent-dispatcher-continue-pm-hub-missing",
        dispatchPlanPath
      );

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/roles/agent-dispatcher-continue-pm-hub-missing/worker/C-01/continue"
      )).resolves.toMatchObject({
        ok: true,
        status: "continued",
        worker: "C-01"
      });

      expect(launchDispatchWorker).toHaveBeenCalledTimes(1);
      const after = lifecycleStore.load();
      const orphanPm = after.pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-c01-orphan");
      // Eviction transitions the PM out of `running`. The exact terminal
      // status depends on whether the worker has independently recovered by
      // the time `markPmResolverThreadMissing` runs: when the dispatcher
      // immediately relaunches C-01 (as in this test), `recordWorkerStart`
      // promotes the demoted-to-failed PM up to `completed` via the shared
      // `reconcilePmResolversForRecoveredWorker` path. Both terminal outcomes
      // are valid — the gate's contract is "no longer wedged on running".
      expect(orphanPm?.status).not.toBe("running");
      expect(["failed", "completed"]).toContain(orphanPm?.status);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // Regression companion to the eviction test: when the Hub still routes to
  // the recorded PM thread (status="running"/"idle"), the gate must keep the
  // worker wedged. Without this assertion the eviction path could regress
  // into eagerly demoting still-live PMs every continue tick.
  it("preserves a hub-live PM resolver and keeps the worker wedged", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-pm-hub-live-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-should-not-launch"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ❌ | 1 | C-01 | Implement contract | CODEX | — | TaskSpec | failed once |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-c01",
        started_at: "2026-05-13T03:59:17.681Z",
        status: "running"
      },
      workers: {
        "C-01": buildLifecycleWorker({
          thread_id: "worker-thread-c01",
          status: "failed",
          retry_count: 1
        })
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-c01-live",
          status: "running",
          started_at: "2026-05-13T04:00:46.316Z",
          last_seen_at: "2026-05-13T04:00:46.316Z",
          agent_type: "codex",
          model_id: null,
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "C-01",
            message: "PM is resolving C-01 block",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: null
    });

    const sendHubRequest = vi.fn(async (message: HubMessage): Promise<HubResult> => {
      if (message.intent === "status" && message.target === "pm-thread-c01-live") {
        return {
          trace_id: "trace-status-pm-live",
          thread_id: "pm-thread-c01-live",
          source: "codex",
          status: "success",
          content: '{"status":"running"}',
          attachments: [],
          timestamp: "2026-05-13T04:05:00.000Z"
        };
      }
      throw new Error(`unexpected hub request: ${message.intent} ${message.target}`);
    });

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        null,
        null,
        sendHubRequest,
        null,
        launchDispatchWorker
      );
      await createAgentDispatcherRole(
        harness.roleHandlers,
        "agent-dispatcher-continue-pm-hub-live",
        dispatchPlanPath
      );

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/roles/agent-dispatcher-continue-pm-hub-live/worker/C-01/continue"
      )).resolves.toMatchObject({
        ok: true,
        status: "still_blocked",
        worker: "C-01",
        pm_resolver_thread_ids: ["pm-thread-c01-live"]
      });

      expect(launchDispatchWorker).not.toHaveBeenCalled();
      const after = lifecycleStore.load();
      const livePm = after.pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-c01-live");
      expect(livePm?.status).toBe("running");
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

  it("delivers validator feedback after a below-threshold validation finishes in the background", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-validation-feedback-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | N-03 | Findings B | CODEX-XHIGH | N-01 | TaskSpec | needs validator check |",
      "| ⬜ | 1 | N-04 | Findings C | CODEX-HIGH | N-01 | TaskSpec | must not skip N-03 fix cycle |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-03": buildLifecycleWorker({
          thread_id: "worker-thread-n03",
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

    const runRequests: Array<{ thread_id: string; content: string }> = [];
    const fetchSpy = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input.toString();
      const pathname = new URL(url).pathname;
      if (pathname === "/api/spawn") {
        return new Response(JSON.stringify({
          ok: true,
          thread_id: "validator-thread-n03"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (pathname === "/api/run") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { thread_id: string; content: string };
        runRequests.push(body);
        if (body.thread_id === "validator-thread-n03") {
          return new Response(JSON.stringify({
            ok: true,
            thread_id: "validator-thread-n03",
            status: "success",
            run_state: "completed",
            content: JSON.stringify({
              score: 0.68,
              feedback: "Add the missing protocol symbol map before moving on."
            })
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (body.thread_id === "worker-thread-n03") {
          return new Response(JSON.stringify({
            ok: true,
            thread_id: "worker-thread-n03",
            status: "success",
            run_state: "running",
            content: "feedback accepted"
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }

      if (pathname === "/api/kill") {
        return new Response(JSON.stringify({
          ok: true,
          thread_id: "validator-thread-n03",
          status: "killed"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      throw new Error(`unexpected Meridian API request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const harness = createHarness();
      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-continue-validation-feedback",
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
          pass_threshold: 0.85,
          max_fix_cycles: 3,
          base_branch: "main"
        }
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-validation-feedback/continue"
      )).resolves.toEqual({
        ok: true,
        status: "validation_in_progress",
        message: "validation started for N-03",
        worker: "N-03",
        validation_outcome: "started"
      });

      await waitForExpect(() => {
        expect(runRequests.some((request) => {
          return request.thread_id === "worker-thread-n03"
            && request.content.includes("[VALIDATOR FEEDBACK]")
            && request.content.includes("Score: 0.68")
            && request.content.includes("missing protocol symbol map");
        })).toBe(true);
      });

      expect(lifecycleStore.load().workers["N-03"]).toMatchObject({
        status: "running",
        validation: {
          current_cycle: 1,
          last_score: 0.68,
          last_feedback: "Add the missing protocol symbol map before moving on."
        }
      });
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("delivers requested worker validator feedback before starting later awaiting validation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-validation-preferred-fix-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔁 FIX 1/3 | 1 | N-04 | Findings C | CODEX-HIGH | N-01 | TaskSpec | needs validator rework |",
      "| 🔍 | 1 | N-05 | Findings D | CODEX-HIGH | N-01 | TaskSpec | awaiting validation |",
      "| ⬜ | 2 | N-06 | Synthesis | CODEX-XHIGH | N-04, N-05 | TaskSpec | blocked by validation |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": buildLifecycleWorker({
          thread_id: "worker-thread-n04",
          status: "fix_requested",
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: 0.78,
            last_feedback: "update completion tracking before synthesis",
            history: [
              {
                cycle: 1,
                score: 0.78,
                feedback: "update completion tracking before synthesis",
                validator_thread_id: "validator-thread-n04",
                timestamp: "2026-04-08T00:25:00.000Z"
              }
            ]
          }
        }),
        "N-05": buildLifecycleWorker({
          thread_id: "worker-thread-n05",
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

    const fetchSpy = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input.toString();
      const pathname = new URL(url).pathname;
      if (pathname === "/api/spawn") {
        throw new Error("N-05 validation should not start before N-04 feedback is delivered");
      }
      if (pathname === "/api/run") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { thread_id?: string; content?: string };
        expect(body.thread_id).toBe("worker-thread-n04");
        expect(body.content).toContain("update completion tracking before synthesis");
        return new Response(JSON.stringify({
          ok: true,
          thread_id: "worker-thread-n04",
          status: "accepted",
          run_state: "running"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      throw new Error(`unexpected Meridian API request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const harness = createHarness();
      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-continue-validation-preferred-fix",
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
        "/api/roles/agent-dispatcher-continue-validation-preferred-fix/worker/N-04/continue"
      )).resolves.toEqual({
        ok: true,
        status: "validation_feedback_delivered",
        message: "validator feedback delivered to N-04",
        worker: "N-04"
      });

      const updatedState = lifecycleStore.load();
      expect(updatedState.workers["N-04"]?.status).toBe("running");
      expect(updatedState.workers["N-05"]?.validation?.validator_thread_id).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("revalidates a worker after below-threshold rework before continuing downstream workers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-validation-repeat-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | N-03 | Findings B | CODEX-XHIGH | N-01 | TaskSpec | rework submitted |",
      "| ⬜ | 1 | N-04 | Findings C | CODEX-HIGH | N-03 | TaskSpec | must wait for N-03 validation |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-03": buildLifecycleWorker({
          thread_id: "worker-thread-n03",
          status: "completed",
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: 0.68,
            last_feedback: "Add the missing protocol symbol map.",
            history: [
              {
                cycle: 1,
                score: 0.68,
                feedback: "Add the missing protocol symbol map.",
                validator_thread_id: "validator-thread-n03-cycle-1",
                timestamp: "2026-04-08T00:30:00.000Z"
              }
            ]
          }
        })
      },
      last_reconciled_at: null
    });

    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-n04"
    }));
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
          thread_id: "validator-thread-n03-cycle-2"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
      }

      if (pathname === "/api/run") {
        return new Promise<Response>(() => undefined);
      }

      throw new Error(`unexpected Meridian API request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);
      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-continue-validation-repeat",
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
          pass_threshold: 0.85,
          max_fix_cycles: 3,
          base_branch: "main"
        }
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-validation-repeat/continue"
      )).resolves.toEqual({
        ok: true,
        status: "validation_in_progress",
        message: "validation started for N-03",
        worker: "N-03",
        validation_outcome: "started"
      });

      expect(launchDispatchWorker).not.toHaveBeenCalled();
      await waitForExpect(() => {
        expect(lifecycleStore.load().workers["N-03"]).toMatchObject({
          status: "awaiting_validation",
          validation: {
            validator_thread_id: "validator-thread-n03-cycle-2",
            current_cycle: 1,
            history: [
              expect.objectContaining({
                cycle: 1,
                score: 0.68
              })
            ]
          }
        });
      });
      const updatedPlan = await fs.readFile(dispatchPlanPath, "utf8");
      expect(updatedPlan).toContain("| 🔍 | 1 | N-03 | Findings B | CODEX-XHIGH | N-01 | TaskSpec | rework submitted |");
      expect(updatedPlan).toContain("| ⬜ | 1 | N-04 | Findings C | CODEX-HIGH | N-03 | TaskSpec | must wait for N-03 validation |");
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("respawns validation when the recorded validator thread is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-validation-stale-validator-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔍 | 1 | N-04 | Findings C | CODEX-HIGH | N-01 | TaskSpec | validator spawn stale |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": buildLifecycleWorker({
          thread_id: "worker-thread-n04",
          status: "awaiting_validation",
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: "validator-thread-stale",
            last_score: null,
            last_feedback: null,
            history: []
          }
        })
      },
      last_reconciled_at: null
    });

    const attachToThread = vi.fn(async (threadId: string) => {
      if (threadId === "validator-thread-stale") {
        throw new Error("No registered agent instance found for thread_id=validator-thread-stale");
      }
    });
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
          thread_id: "validator-thread-n04-fresh"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
      }

      if (pathname === "/api/run") {
        return new Promise<Response>(() => undefined);
      }

      throw new Error(`unexpected Meridian API request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const harness = createHarness(undefined, undefined, [], null, attachToThread);
      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-continue-validation-stale-validator",
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
          pass_threshold: 0.85,
          max_fix_cycles: 3,
          base_branch: "main"
        }
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-validation-stale-validator/continue"
      )).resolves.toEqual({
        ok: true,
        status: "validation_in_progress",
        message: "validation started for N-04",
        worker: "N-04",
        validation_outcome: "started"
      });

      expect(attachToThread).toHaveBeenCalledWith("validator-thread-stale");
      await waitForExpect(() => {
        expect(lifecycleStore.load().workers["N-04"]?.validation?.validator_thread_id).toBe("validator-thread-n04-fresh");
      });
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("respawns validation when the recorded validator thread is in error state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-validation-errored-validator-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath });

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔍 | 1 | N-05 | Findings D | CODEX-XHIGH | N-01 | TaskSpec | validator errored in hub registry |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-12T10:10:00.000Z",
        status: "running"
      },
      workers: {
        "N-05": buildLifecycleWorker({
          thread_id: "worker-thread-n05",
          status: "awaiting_validation",
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: "validator-thread-errored",
            last_score: null,
            last_feedback: null,
            history: []
          }
        })
      },
      last_reconciled_at: null
    });

    // Validator thread is *attachable* in the hub (so the legacy attach
    // probe alone would consider it alive), but the hub-reported status is
    // `error` — exactly the wedged state produced when the monitor cannot
    // probe a stateless instance's agentapi socket and emits a spurious
    // agent_error. The validator orchestration must classify this as
    // inactive and clear+respawn rather than report validation_in_progress
    // forever.
    const attachToThread = vi.fn(async () => undefined);
    const sendHubRequest = vi.fn(async (message: HubMessage): Promise<HubResult> => {
      if (message.intent === "status" && message.target === "validator-thread-errored") {
        return {
          trace_id: "trace-status-errored",
          thread_id: "validator-thread-errored",
          source: "codex",
          status: "success",
          content: '{"status":"error"}',
          attachments: [],
          timestamp: "2026-05-12T10:11:00.000Z"
        };
      }
      throw new Error(`unexpected hub request: ${message.intent} ${message.target}`);
    });

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
          thread_id: "validator-thread-n05-fresh"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
      }

      if (pathname === "/api/run") {
        return new Promise<Response>(() => undefined);
      }

      throw new Error(`unexpected Meridian API request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const harness = createHarness(undefined, undefined, [], null, attachToThread, sendHubRequest);
      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-continue-validation-errored-validator",
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
          pass_threshold: 0.85,
          max_fix_cycles: 3,
          base_branch: "main"
        }
      });

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-validation-errored-validator/continue"
      )).resolves.toEqual({
        ok: true,
        status: "validation_in_progress",
        message: "validation started for N-05",
        worker: "N-05",
        validation_outcome: "started"
      });

      expect(sendHubRequest).toHaveBeenCalledWith(expect.objectContaining({
        intent: "status",
        target: "validator-thread-errored"
      }));
      await waitForExpect(() => {
        expect(lifecycleStore.load().workers["N-05"]?.validation?.validator_thread_id).toBe("validator-thread-n05-fresh");
      });
    } finally {
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
        // Lifecycle status reflects what determineWorkerOutcome would
        // produce for a hub_result whose narrative contains ":hit limit"
        // (heuristic fallback maps hit-limit content to "failed"). Asking
        // the dispatcher to re-run that same heuristic over the lifecycle's
        // own output would be redundant with the Phase A marker protocol;
        // the dispatcher honors the lifecycle status instead.
        "R-07": buildLifecycleWorker({
          thread_id: "worker-thread-r07",
          status: "failed",
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

  it("blocks continuation when a failed worker reported a blocking result", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-blocked-result-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ❌ | 0 | N-01 | Extract app artifacts | CODEX-HIGH | — | Reverse PRD | foundation gate |",
      "| ⬜ | 1 | N-02 | Findings | CODEX-XHIGH | N-01 | Reverse PRD | waits on extraction |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": buildLifecycleWorker({
          thread_id: "worker-thread-n01",
          status: "failed",
          retry_count: 0,
          hub_result: {
            ...buildHubResult("Status: BLOCKED - required @phoenix namespace is absent from the extracted asar tree."),
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-n01"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-continue-blocked-result", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-continue-blocked-result/continue"
      )).resolves.toEqual({
        ok: true,
        status: "manual_intervention_required",
        message: "manual intervention required: N-01 reported a blocking failure",
        worker: "N-01",
        error: "Status: BLOCKED - required @phoenix namespace is absent from the extracted asar tree."
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives the manual-intervention reason from the MeridianStatusMarker outcome when present", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-marker-reason-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ❌ | 0 | N-04 | Generate findings | CODEX-HIGH | — | TaskSpec | foundation gate |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": buildLifecycleWorker({
          thread_id: "worker-thread-n04",
          status: "blocked",
          retry_count: 0,
          hub_result: {
            ...buildHubResult([
              "Encountered an external blocker.",
              "<<<MERIDIAN-STATUS>>>",
              "worker_id: N-04",
              "role: worker",
              "outcome: needs_pm",
              "report_path: /tmp/n-04-report.md",
              "notes: PM input required to choose between option A and option B",
              "<<<END>>>"
            ].join("\n")),
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-n04"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-marker-reason", dispatchPlanPath);

      const response = await invokeJson<Record<string, unknown>>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-marker-reason/continue"
      );

      expect(response.status).toBe("manual_intervention_required");
      expect(response.message).toBe("manual intervention required: N-04 requested PM resolution");
      expect(response.worker).toBe("N-04");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not flag manual intervention when the lifecycle has resolved a worker whose plan row is still ⛔ BLOCKED", async () => {
    // Regression: BATCH-2-GATE shipped a `blocked` marker on its first
    // reply but a later validator approved the deliverables, moving
    // lifecycle to completed. The plan markdown row stayed ⛔ BLOCKED
    // (plan-vs-lifecycle drift). Continuing the dispatcher must trust
    // the lifecycle and look beyond the stale plan row.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-stale-plan-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⛔ BLOCKED | 2 | BATCH-2-GATE | Gate batch 2 | CODEX-HIGH | — | TaskSpec | originally blocked, validator approved |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-08T00:20:00.000Z",
        status: "running"
      },
      workers: {
        "BATCH-2-GATE": buildLifecycleWorker({
          thread_id: "worker-thread-b2g",
          status: "completed",
          retry_count: 0,
          hub_result: {
            ...buildHubResult([
              "Original reply emitted before validator override.",
              "<<<MERIDIAN-STATUS>>>",
              "worker_id: BATCH-2-GATE",
              "role: worker",
              "outcome: blocked",
              "report_path: /tmp/batch-2-gate-report.md",
              "notes: original blocker since resolved by validator",
              "<<<END>>>"
            ].join("\n")),
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-b2g"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-stale-plan", dispatchPlanPath);

      const response = await invokeJson<Record<string, unknown>>(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-stale-plan/continue"
      );

      expect(response.status).not.toBe("manual_intervention_required");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not continue implementation workers when PRE-FLIGHT is blocked", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-preflight-blocked-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-continued"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⛔ BLOCKED | 0 | PRE-FLIGHT | Env health check | CODEX-HIGH | — | TaskSpec | missing Supabase auth |",
      "| ⬜ | 1 | N-01 | Workspace scaffold | CODEX-XHIGH | — | TaskSpec | should not run before PRE-FLIGHT |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-02T07:28:23.855Z",
        status: "running"
      },
      workers: {
        "PRE-FLIGHT": buildLifecycleWorker({
          thread_id: "codex_02",
          status: "blocked",
          retry_count: 1,
          hub_result: {
            ...buildHubResult("PRE-FLIGHT is still **BLOCKED**. Supabase CLI auth is missing."),
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "codex_02"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-preflight-blocked", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-preflight-blocked/continue"
      )).resolves.toEqual({
        ok: true,
        status: "manual_intervention_required",
        message: "manual intervention required: PRE-FLIGHT reported a blocking failure",
        worker: "PRE-FLIGHT",
        error: "PRE-FLIGHT is still **BLOCKED**. Supabase CLI auth is missing."
      });
      expect(launchDispatchWorker).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not continue a stale running implementation worker when PRE-FLIGHT plan status is blocked", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-preflight-plan-blocked-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const launchDispatchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-continued"
    }));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⛔ BLOCKED | 0 | PRE-FLIGHT | Env health check | CODEX-HIGH | — | TaskSpec | missing Supabase auth |",
      "| 🔄 | 1 | N-01 | Workspace scaffold | CODEX-XHIGH | — | TaskSpec | stale running mark |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-02T07:28:23.855Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-preflight-plan-blocked", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-preflight-plan-blocked/continue"
      )).resolves.toEqual({
        ok: true,
        status: "manual_intervention_required",
        message: "manual intervention required: PRE-FLIGHT is blocked",
        worker: "PRE-FLIGHT"
      });
      expect(launchDispatchWorker).not.toHaveBeenCalled();
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

      // After the launch-initiated synchronous lifecycle write the row
      // reflects 🔄 (running) immediately, instead of the previous post-
      // resume_worker ⬜ snapshot which only held until runTool's
      // recordWorkerStart eventually landed. This matches the new
      // contract that "continue: <worker>" is paired with a visible
      // running row before the response returns.
      await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| 🔄 | Ω+2 | R-10 | Feature Branch Scope Isolation | CODEX-HIGH | PR-REVIEW | TaskSpec | pre-marked before spawn failed |"
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

  it("includes runtime model override in dispatch detail responses", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-status-route-override-"));
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
      "| 🔄 | 2 | N-04 | Resume Worker Tool | CODEX | R-03 | CLI Integration PRD | retrying |"
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
          last_seen_at: "2026-04-05T00:10:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          applied_model_id: "gpt-5.5",
          applied_reasoning_effort: "high",
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    try {
      const harness = createHarness();

      await createRole(harness.roleHandlers, {
        thread_id: "agent-dispatcher-status-detail",
        role_type: "agent-dispatcher",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: "/tmp/agent_dispatch_command.md",
        user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }]
      });

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-status-detail")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-status-detail",
        dispatch_details: expect.arrayContaining([
          expect.objectContaining({
            worker_id: "N-04",
            model: "CODEX",
            applied_model: "gpt-5.5",
            status: "running"
          })
        ])
      });
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

  it("shows blocked dispatch detail status when lifecycle is blocked and the hub result contains a blocking report", async () => {
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
          status: "blocked",
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
            status: "blocked"
          })
        ],
        dispatch_details: [
          expect.objectContaining({
            worker_id: "PRE-FLIGHT",
            status: "blocked",
            reply: expect.objectContaining({
              content: expect.stringContaining("⛔ BLOCKED")
            })
          })
        ],
        dispatch_plan: {
          rows: [
            expect.objectContaining({
              worker: "PRE-FLIGHT",
              status: "⛔ BLOCKED",
              lifecycle_status: "blocked"
            })
          ]
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("shows completed dispatch detail status when lifecycle completion supersedes an old blocked reply", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-completed-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 9 | N-57 | Perf gate | CODEX-HIGH | BATCH-7-GATE | TaskSpec | PM resolved |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-05T04:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-57": buildLifecycleWorker({
          thread_id: "codex_57",
          status: "completed",
          expected_outputs: [path.join(tempDir, "reports", "N-57.md")],
          hub_result: {
            ...buildHubResult([
              "Earlier in the run this task was BLOCKED by missing output evidence.",
              "PM later verified the report and marked the worker complete."
            ].join("\n")),
            trace_id: "33333333-3333-4333-8333-333333333333",
            thread_id: "codex_57"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-completed-detail", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "GET",
        "/api/role/agent-dispatcher-completed-detail"
      )).resolves.toMatchObject({
        dispatch_details: [
          expect.objectContaining({
            worker_id: "N-57",
            status: "completed",
            reply: expect.objectContaining({
              content: expect.stringContaining("BLOCKED")
            })
          })
        ],
        dispatch_plan: {
          rows: [
            expect.objectContaining({
              worker: "N-57",
              status: "✅",
              lifecycle_status: "completed"
            })
          ]
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns PM resolver status and reply as dispatcher details", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-pm-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⛔ BLOCKED | 1 | BATCH-1-GATE | Gate Batch 2 | CODEX-XHIGH | — | TaskSpec | blocked |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-03T00:00:00.000Z",
        status: "running"
      },
      workers: {},
      pm_resolvers: [
        {
          thread_id: "codex_42",
          status: "completed",
          started_at: "2026-05-03T00:01:00.000Z",
          last_seen_at: "2026-05-03T00:05:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "BATCH-1-GATE",
            source: "watchdog",
            message: "Gate worker blocked"
          },
          result: {
            status: "success",
            run_state: "completed",
            content: "PM merged PR #204 and continued the dispatcher.",
            summary_text: "PM resolved BATCH-1-GATE.",
            details_text: [
              "Your message:",
              "Resolve BATCH-1-GATE",
              "",
              "Agent reply:",
              "PM merged PR #204 and continued the dispatcher."
            ].join("\n"),
            trace_id: "44444444-4444-4444-8444-444444444444",
            timestamp: "2026-05-03T00:05:00.000Z"
          },
          error: null
        }
      ],
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-pm-detail", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "GET",
        "/api/role/agent-dispatcher-pm-detail"
      )).resolves.toMatchObject({
        dispatch_details: expect.arrayContaining([
          expect.objectContaining({
            detail_kind: "pm_resolver",
            worker_id: "PM:BATCH-1-GATE",
            status: "completed",
            task: "Resolve BATCH-1-GATE: manual_intervention_required",
            model: "PM",
            applied_model: "gpt-5.5",
            worker_thread_id: "codex_42",
            trace_id: "44444444-4444-4444-8444-444444444444",
            reply: expect.objectContaining({
              sender_name: "codex_42",
              sender_agent_type: "codex",
              sender_model: "gpt-5.5",
              content: "PM merged PR #204 and continued the dispatcher."
            })
          })
        ])
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("renders a stale-running PM resolver with a terminal live marker as completed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-pm-live-marker-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 7G | BATCH-7-GATE | Dashboard privacy gate | CODEX-HIGH | N-14, N-15 | Baseline | PM resolved |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-05T13:44:00.000Z",
        status: "running"
      },
      workers: {
        "BATCH-7-GATE": buildLifecycleWorker({
          thread_id: "codex_167",
          started_at: "2026-05-05T13:44:19.465Z",
          last_seen_at: "2026-05-05T13:50:24.783Z",
          status: "completed"
        })
      },
      pm_resolvers: [
        {
          thread_id: "codex_169",
          status: "running",
          started_at: "2026-05-05T13:46:19.384Z",
          last_seen_at: "2026-05-05T13:46:19.384Z",
          agent_type: "codex",
          model_id: null,
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "BATCH-7-GATE",
            source: "watchdog",
            message: "BATCH-7-GATE requested PM resolution"
          },
          result: null,
          error: null
        }
      ],
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(
        undefined,
        undefined,
        [],
        [
          "Your message:",
          "Resolve BATCH-7-GATE",
          "",
          "Agent reply:",
          "Resolved the PM blocker for BATCH-7-GATE.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: BATCH-7-GATE",
          "role: pm-resolver",
          "outcome: resolved",
          "pm_action: force_complete",
          "notes: Marked BATCH-7-GATE completed after PM-scoped privacy fix.",
          "<<<END>>>"
        ].join("\n")
      );
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-pm-live-marker", dispatchPlanPath);

      await expect(invokeJson(
        harness.roleHandlers,
        "GET",
        "/api/role/agent-dispatcher-pm-live-marker"
      )).resolves.toMatchObject({
        dispatch_plan: {
          rows: [
            expect.objectContaining({
              worker: "BATCH-7-GATE",
              lifecycle_status: "completed",
              active_owner_kind: null,
              active_owner_thread_id: null
            })
          ]
        },
        dispatch_details: expect.arrayContaining([
          expect.objectContaining({
            detail_kind: "pm_resolver",
            worker_id: "PM:BATCH-7-GATE",
            status: "completed",
            worker_thread_id: "codex_169",
            reply: expect.objectContaining({
              content: expect.stringContaining("outcome: resolved")
            })
          })
        ])
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits a separate validator dispatch detail per validation cycle in worker.validation.history", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-validator-cycles-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 2 | N-12 | Findings A | CODEX-HIGH | — | TaskSpec | validator approved |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-03T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-12": buildLifecycleWorker({
          thread_id: "codex_40",
          status: "completed",
          retry_count: 1,
          validation: {
            current_cycle: 2,
            max_fix_cycles: 3,
            validator_thread_id: "validator-thread-cycle-2",
            last_score: 1,
            last_feedback: "Pass on cycle 2",
            history: [
              {
                cycle: 1,
                score: 0.5,
                feedback: "Add the missing flag handler.",
                validator_thread_id: "validator-thread-cycle-1",
                timestamp: "2026-05-03T00:30:00.000Z"
              },
              {
                cycle: 2,
                score: 1,
                feedback: "Pass on cycle 2",
                validator_thread_id: "validator-thread-cycle-2",
                timestamp: "2026-05-03T00:45:00.000Z"
              }
            ]
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-validator-cycles", dispatchPlanPath);

      const response = await invokeJson<{
        dispatch_details: Array<Record<string, unknown>>;
      }>(
        harness.roleHandlers,
        "GET",
        "/api/role/agent-dispatcher-validator-cycles"
      );

      // Worker bar is still present and surfaces retry_count for the badge.
      expect(response.dispatch_details).toContainEqual(expect.objectContaining({
        detail_kind: "worker",
        worker_id: "N-12",
        task_id: "N-12",
        retry_count: 1
      }));

      // Cycle 1 — fix_requested score (partial).
      expect(response.dispatch_details).toContainEqual(expect.objectContaining({
        detail_kind: "validator",
        worker_id: "VALIDATOR:N-12:cycle-1",
        task_id: "N-12",
        validator_cycle: 1,
        validator_score: 0.5,
        validator_outcome: "fix_requested",
        worker_thread_id: "validator-thread-cycle-1",
        reply: expect.objectContaining({
          content: expect.stringContaining("Add the missing flag handler.")
        })
      }));

      // Cycle 2 — pass.
      expect(response.dispatch_details).toContainEqual(expect.objectContaining({
        detail_kind: "validator",
        worker_id: "VALIDATOR:N-12:cycle-2",
        task_id: "N-12",
        validator_cycle: 2,
        validator_score: 1,
        validator_outcome: "pass",
        worker_thread_id: "validator-thread-cycle-2",
        reply: expect.objectContaining({
          content: expect.stringContaining("Pass on cycle 2")
        })
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers PM resolver details from worker results written before PM history existed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-pm-legacy-detail-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | BATCH-1-GATE | Gate Batch 2 | CODEX-HIGH | N-01 | BATCH-1-GATE.md | PM resolved |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-05-03T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "BATCH-1-GATE": buildLifecycleWorker({
          thread_id: "codex_40",
          trace_id: "55555555-5555-4555-8555-555555555555",
          started_at: "2026-05-03T00:01:00.000Z",
          last_seen_at: "2026-05-03T00:05:00.000Z",
          status: "completed",
          hub_result: {
            trace_id: "55555555-5555-4555-8555-555555555555",
            thread_id: "codex_40",
            source: "pm-resolver",
            status: "success",
            run_state: "completed",
            content: "PM resolution complete for BATCH-1-GATE. PR #204 merged and Batch 2 unblocked.",
            attachments: [],
            timestamp: "2026-05-03T00:05:00.000Z"
          }
        })
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness();
      await createAgentDispatcherRole(harness.roleHandlers, "agent-dispatcher-pm-legacy-detail", dispatchPlanPath);

      const response = await invokeJson<{
        dispatch_details: Array<{
          worker_id: string;
          detail_kind?: string;
          reply: { content: string } | null;
        }>;
      }>(
        harness.roleHandlers,
        "GET",
        "/api/role/agent-dispatcher-pm-legacy-detail"
      );

      expect(response).toMatchObject({
        dispatch_details: expect.arrayContaining([
          expect.objectContaining({
            detail_kind: "pm_resolver",
            worker_id: "PM:BATCH-1-GATE",
            status: "completed",
            task: "Resolve BATCH-1-GATE: recovered_pm_resolution",
            model: "PM",
            applied_model: "pm-resolver",
            worker_thread_id: "codex_40",
            reply: expect.objectContaining({
              sender_name: "codex_40",
              sender_agent_type: "pm-resolver",
              content: expect.stringContaining("PM resolution complete for BATCH-1-GATE")
            })
          })
        ])
      });

      expect(response.dispatch_details).toContainEqual(expect.objectContaining({
        worker_id: "BATCH-1-GATE",
        reply: null
      }));
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

  it("does not attach a dispatcher thread when persisted role already needs reactivation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-role-reactivation-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-role-reactivation",
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
        status: "running"
      },
      workers: {},
      last_reconciled_at: "2026-04-07T14:15:00.000Z"
    }, null, 2)}\n`, "utf8");

    try {
      const attachToThread = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness(persistedState, undefined, [], "unused", attachToThread);

      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-role-reactivation")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-role-reactivation",
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

  it("keeps a human-gated agent-dispatcher idle when its controller thread is abandoned", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-human-gate-idle-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-human-gate-idle",
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
      "| ✅ | 8 | V-01-A | Automated validation | CODEX | - | TaskSpec | done |",
      "| ⬜ | 8 | V-01-B | Human launch review | HUMAN | V-01-A | TaskSpec | waiting on operator |",
      "| ⬜ | 9 | N-16 | Lock launch contract | CODEX | V-01-B | TaskSpec | blocked by human gate |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: "2026-05-06T00:39:06.702Z",
        status: "abandoned"
      },
      workers: {
        "V-01-A": buildLifecycleWorker({
          thread_id: "worker-thread-v01a",
          status: "completed",
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: 1,
            last_feedback: "pass",
            history: []
          }
        }),
        "DISPATCHER": buildLifecycleWorker({
          thread_id: "dispatcher-thread-stale",
          status: "completed"
        })
      },
      last_reconciled_at: "2026-05-06T00:39:19.261Z"
    }, null, 2)}\n`, "utf8");

    try {
      const launchDispatcher = vi.fn(async () => ({
        ok: true as const,
        threadId: "dispatcher-thread-new"
      }));
      const harness = createHarness(persistedState, undefined, [], "unused", null, null, launchDispatcher);

      await expect(invokeJson<Array<{ thread_id: string; status: string }>>(harness.roleHandlers, "GET", "/api/roles")).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thread_id: "agent-dispatcher-human-gate-idle",
            status: "active"
          })
        ])
      );
      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-human-gate-idle")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-human-gate-idle",
        status: "active",
        dispatcher_thread_id: null,
        continue_worker: null
      });
      await expect(invokeJson(harness.roleHandlers, "POST", "/api/agent-dispatcher/agent-dispatcher-human-gate-idle/continue")).resolves.toMatchObject({
        ok: true,
        status: "still_blocked",
        message: expect.stringContaining("waiting on human")
      });
      await expect(invokeJson(harness.roleHandlers, "POST", "/api/agent-dispatcher/agent-dispatcher-human-gate-idle/start-hub")).resolves.toMatchObject({
        ok: true,
        status: "still_blocked",
        message: expect.stringContaining("waiting on human")
      });
      expect(launchDispatcher).not.toHaveBeenCalled();
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

  it("projects completed when a force-complete worker is in status=completed without a validator score (regression: agent-dispatcher-8eb13a31 V-01-A 2026-05-14)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-agent-dispatcher-list-validation-pending-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");
    const persistedState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-validation-pending",
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
            use_agent_dispatcher: true,
            validator: {
              enabled: true,
              agent_type: "codex",
              mode: "bridge",
              pass_threshold: 0.85,
              max_fix_cycles: 3,
              base_branch: "main"
            }
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
      "| ✅ | 2 | N-06 | Synthesize final report | CODEX-XHIGH | N-02, N-03 | TaskSpec | terminal gate |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-07T14:15:00.000Z",
        status: "running"
      },
      workers: {
        "N-06": buildLifecycleWorker({
          thread_id: "worker-thread-n06",
          status: "completed",
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
      last_reconciled_at: "2026-04-07T14:15:00.000Z"
    }, null, 2)}\n`, "utf8");

    try {
      const harness = createHarness(persistedState);

      // Force-complete is a legitimate operator override path (update-status
      // --status completed, resume-worker --action force-complete, PM
      // pm_action: force_complete). It produces `status: completed` without
      // populating validation.last_score. The settle predicate must trust
      // the authoritative `completed` lifecycle state — without this carve-
      // out the dispatcher role pinned at `active` indefinitely on
      // agent-dispatcher-8eb13a31 V-01-A 2026-05-14 after all plan rows
      // were ✅ and every worker was status: completed.
      await expect(invokeJson<Array<{ thread_id: string; status: string }>>(harness.roleHandlers, "GET", "/api/roles")).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thread_id: "agent-dispatcher-validation-pending",
            status: "completed",
            task_count: 1
          })
        ])
      );
      await expect(invokeJson(harness.roleHandlers, "GET", "/api/role/agent-dispatcher-validation-pending")).resolves.toMatchObject({
        thread_id: "agent-dispatcher-validation-pending",
        status: "completed"
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
  launchDispatchWorker: ((config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult>) | null = null,
  startPmResolver: ((request: PmResolverRequest) => Promise<PmResolverResult>) | null = null
) {
  if (!process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY) {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-bootstrap-seed";
  }
  resetCallerIdentityCache();
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
      setPaused: () => undefined,
      awaitPendingPauseWork: async () => undefined
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
  const testMeridianApi = createMeridianApiClient({ fetch: globalThis.fetch });

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
      ...(startPmResolver ? { startPmResolver } : {}),
      meridianApi: testMeridianApi,
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

async function waitForExpect(assertion: () => void, timeoutMs = 250): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assertion();
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
