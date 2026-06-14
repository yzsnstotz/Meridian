import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../lifecycle-store";
import {
  PM_RESOLVER_ACTIONS,
  PM_RESOLVER_MARKER_OUTCOMES
} from "../meridian-status-marker";
import { buildPmResolverPrompt, startPmResolver } from "../pm-resolver";
import { MERIDIAN_TOOL_DISPLAY_COMMAND } from "../tool-entrypoint";
import { AgentDispatcherConfigSchema } from "../../../types";
import type { MeridianApiClient } from "../meridian-api-client";
import * as activeToolProcess from "../active-tool-process";

describe("buildPmResolverPrompt", () => {
  const config = AgentDispatcherConfigSchema.parse({
    dispatch_plan_path: "/tmp/taskspec/dispatch_plan.md",
    command_file_path: "/tmp/taskspec/dispatch_command.md",
    user_reply_channels: [{ channel: "telegram", chat_id: "telegram:dispatcher" }],
    agent_type: "codex",
    mode: "bridge",
    kill_policy: "always",
    auto_approve: true,
    pm_resolver: {
      enabled: true,
      agent_type: "codex",
      mode: "bridge",
      auto_approve: true,
      user_reply_channels: [{ channel: "telegram", chat_id: "telegram:pm" }]
    }
  });

  it("gives PM resolvers a close-the-loop dispatcher control contract", () => {
    const prompt = buildPmResolverPrompt({
      dispatcherId: "agent-dispatcher-pm",
      config,
      issue: {
        status: "manual_intervention_required",
        workerId: "BATCH-1-GATE",
        source: "watchdog",
        message: "BATCH-1-GATE reported a blocking failure"
      }
    });

    expect(prompt).toContain(MERIDIAN_TOOL_DISPLAY_COMMAND);
    expect(prompt).toContain("update-status --plan /tmp/taskspec/dispatch_plan.md --worker BATCH-1-GATE --status completed");
    expect(prompt).toContain("resume-worker --plan /tmp/taskspec/dispatch_plan.md --worker BATCH-1-GATE --action retry --force true");
    expect(prompt).toContain("continue-dispatcher --dispatcher agent-dispatcher-pm [--worker <worker_id>]");
    expect(prompt).toContain("notify --message \"<text>\" --urgency <low|normal|high>");
    expect(prompt).toContain("Do not stop with only advice");
    expect(prompt).toContain("Close the loop");
  });

  it("teaches the PM resolver the MeridianStatusMarker reply contract using the canonical role enums", () => {
    const prompt = buildPmResolverPrompt({
      dispatcherId: "agent-dispatcher-pm",
      config,
      issue: {
        status: "manual_intervention_required",
        workerId: "BATCH-1-GATE",
        source: "watchdog"
      }
    });

    expect(prompt).toContain("# Reply Protocol");
    expect(prompt).toContain("<<<MERIDIAN-STATUS>>>");
    expect(prompt).toContain("role: pm-resolver");
    expect(prompt).toContain("worker_id: BATCH-1-GATE");
    expect(prompt).toContain(`outcome: ${PM_RESOLVER_MARKER_OUTCOMES.join(" | ")}`);
    expect(prompt).toContain(`pm_action: ${PM_RESOLVER_ACTIONS.join(" | ")}`);
    expect(prompt).toContain("<<<END>>>");

    // Each enum value should also be documented in the surrounding prose so
    // the agent has a description, not just a wire-format hint.
    for (const outcome of PM_RESOLVER_MARKER_OUTCOMES) {
      expect(prompt).toContain(`\`${outcome}\``);
    }
    for (const action of PM_RESOLVER_ACTIONS) {
      expect(prompt).toContain(`\`${action}\``);
    }
  });

  it("substitutes a placeholder worker_id when the issue has no associated worker", () => {
    const prompt = buildPmResolverPrompt({
      dispatcherId: "agent-dispatcher-pm",
      config,
      issue: {
        status: "manual_intervention_required",
        source: "watchdog"
      }
    });

    expect(prompt).toContain("worker_id: <worker_id>");
  });

  it("forwards pm_resolver.credential_id onto the PM resolver spawn", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-cred-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, [
      "| Status | Batch | Worker | Task | Model | Depends On |",
      "|--------|-------|--------|------|-------|------------|",
      "| ⛔ BLOCKED | 1 | BATCH-1-GATE | Verify gates | CODEX | — |"
    ].join("\n"), "utf8");

    const spawn = vi.fn(async () => ({ threadId: "pm-thread-cred" }));
    const run = vi.fn(async () => ({
      threadId: "pm-thread-cred",
      status: "success" as const,
      runState: "completed" as const,
      content: "ok",
      raw: {}
    }));
    const kill = vi.fn(async () => ({ threadId: "pm-thread-cred", status: "killed", raw: {} }));
    const meridianApi: MeridianApiClient = { spawn, run, kill, listCredentials: vi.fn().mockResolvedValue([]) };

    try {
      await startPmResolver({
        dispatcherId: "agent-dispatcher-pm",
        config: {
          ...config,
          dispatch_plan_path: dispatchPlanPath,
          pm_resolver: {
            ...config.pm_resolver,
            credential_id: "cred-pm"
          }
        },
        issue: {
          status: "manual_intervention_required",
          workerId: "BATCH-1-GATE",
          source: "watchdog",
          message: "needs PM"
        }
      }, { meridianApi });

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
        credentialId: "cred-pm"
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retains the PM thread on a transport-class run rejection when the agentapi process is still alive", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-stall-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "| Status | Batch | Worker | Task | Model | Depends On |",
      "|--------|-------|--------|------|-------|------------|",
      "| ⛔ BLOCKED | 1 | BATCH-1-GATE | Verify gates | CODEX | — |"
    ].join("\n"), "utf8");

    const kill = vi.fn(async () => ({ threadId: "pm-thread-stall", status: "killed", raw: {} }));
    const meridianApi: MeridianApiClient = {
      spawn: async () => ({ threadId: "pm-thread-stall" }),
      run: async () => {
        throw new Error("run failed: Request timed out — the hub may be overloaded");
      },
      kill,
      listCredentials: vi.fn().mockResolvedValue([])
    };
    const liveProcessSpy = vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread").mockReturnValue(true);

    try {
      await startPmResolver({
        dispatcherId: "agent-dispatcher-pm",
        config: {
          ...config,
          dispatch_plan_path: dispatchPlanPath
        },
        issue: {
          status: "manual_intervention_required",
          workerId: "BATCH-1-GATE",
          source: "watchdog",
          message: "Blocked gate needs PM"
        }
      }, { meridianApi });

      await waitForExpect(async () => {
        const state = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
          pm_resolvers?: Array<{
            thread_id: string;
            status: string;
            transport_error?: string | null;
            error?: string | null;
          }>;
        };
        expect(state.pm_resolvers).toEqual([
          expect.objectContaining({
            thread_id: "pm-thread-stall",
            status: "running",
            transport_error: "run failed: Request timed out — the hub may be overloaded",
            marker_outcome: null,
            marker_pm_action: null,
            error: null
          })
        ]);
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      liveProcessSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records PM resolver failure when the run handoff rejects with missing-thread evidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-missing-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "| Status | Batch | Worker | Task | Model | Depends On |",
      "|--------|-------|--------|------|-------|------------|",
      "| ⛔ BLOCKED | 1 | BATCH-1-GATE | Verify gates | CODEX | — |"
    ].join("\n"), "utf8");

    const kill = vi.fn(async () => ({ threadId: "pm-thread-missing", status: "killed", raw: {} }));
    const meridianApi: MeridianApiClient = {
      spawn: async () => ({ threadId: "pm-thread-missing" }),
      run: async () => {
        throw new Error("run failed: Routing failed: No registered agent instance found for thread_id=pm-thread-missing");
      },
      kill,
      listCredentials: vi.fn().mockResolvedValue([])
    };

    try {
      await startPmResolver({
        dispatcherId: "agent-dispatcher-pm",
        config: {
          ...config,
          dispatch_plan_path: dispatchPlanPath
        },
        issue: {
          status: "manual_intervention_required",
          workerId: "BATCH-1-GATE",
          source: "watchdog",
          message: "Blocked gate needs PM"
        }
      }, { meridianApi });

      await waitForExpect(async () => {
        const state = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
          pm_resolvers?: Array<{
            thread_id: string;
            status: string;
            transport_error?: string | null;
            error?: string | null;
          }>;
        };
        expect(state.pm_resolvers).toEqual([
          expect.objectContaining({
            thread_id: "pm-thread-missing",
            status: "failed",
            transport_error: null,
            error: expect.stringContaining("No registered agent instance found for thread_id=pm-thread-missing")
          })
        ]);
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retries the PM resolver spawn when Meridian returns a thread id reserved by another plan (regression: BATCH-3-GATE codex_19 N-02 bleed)", async () => {
    // Models the agent-dispatcher-8eb13a31 BATCH-3-GATE incident on
    // 2026-05-14. Without this protection, a Hub allocator wrap can re-hand a
    // `codex_NN` whose underlying agent session is still running another role
    // (here a stale `running` PM resolver in another plan); the new PM prompt
    // then lands on the live session and the codex agent emits content for
    // the stale task instead of resolving the new one.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-collision-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");

    // Other plan that pins the colliding thread id as a `running` PM resolver.
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-collision-other-"));
    const otherDispatchPlanPath = path.join(otherDir, "dispatch_plan.md");
    await fs.writeFile(otherDispatchPlanPath, "# other plan\n", "utf8");
    const otherStore = new LifecycleStore(
      path.join(otherDir, "dispatch_threads.json"),
      { dispatchPlanPath: otherDispatchPlanPath }
    );
    otherStore.save({
      version: 2,
      dispatcher: { thread_id: null, started_at: null, status: "pending" },
      workers: {},
      pm_resolvers: [
        {
          thread_id: "pm-thread-collision",
          status: "running",
          started_at: "2026-05-06T00:00:00.000Z",
          last_seen_at: "2026-05-06T00:00:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5",
          mode: "bridge",
          auto_approve: true,
          issue: { status: "manual_intervention_required", worker_id: null, message: null, error: null, source: "watchdog" },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: null
    });

    const spawn = vi.fn()
      .mockResolvedValueOnce({ threadId: "pm-thread-collision" })
      .mockResolvedValueOnce({ threadId: "pm-thread-collision" })
      .mockResolvedValueOnce({ threadId: "pm-thread-fresh" });
    const run = vi.fn(async () => ({
      threadId: "pm-thread-fresh",
      status: "success" as const,
      runState: "completed" as const,
      content: "PM resolved.",
      raw: {
        trace_id: "55555555-5555-4555-8555-555555555555",
        timestamp: "2026-05-14T06:00:00.000Z"
      }
    }));
    const kill = vi.fn(async () => ({ threadId: "pm-thread-fresh", status: "killed", raw: {} }));
    const meridianApi: MeridianApiClient = { spawn, run, kill, listCredentials: vi.fn().mockResolvedValue([]) };

    try {
      const result = await startPmResolver({
        dispatcherId: "agent-dispatcher-pm",
        config: {
          ...config,
          dispatch_plan_path: dispatchPlanPath
        },
        issue: {
          status: "manual_intervention_required",
          workerId: "BATCH-3-GATE",
          source: "watchdog",
          message: "BATCH-3-GATE reported a blocking failure"
        },
        otherDispatchPlanPaths: [otherDispatchPlanPath]
      }, { meridianApi });

      expect(result).toEqual({
        ok: true,
        status: "pm_resolver_started",
        thread_id: "pm-thread-fresh",
        message: "PM resolver started for BATCH-3-GATE"
      });
      expect(spawn).toHaveBeenCalledTimes(3);
      // Cross-plan collision must NOT kill the colliding thread (it's the
      // other plan's live agent). Only the post-run kill of the fresh thread
      // is expected.
      await waitForExpect(() => {
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledWith("pm-thread-fresh");
      });
      expect(run).toHaveBeenCalledWith({
        threadId: "pm-thread-fresh",
        content: expect.stringContaining("BATCH-3-GATE")
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it("records PM resolver start and completion in the dispatch lifecycle sidecar", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "| Status | Batch | Worker | Task | Model | Depends On |",
      "|--------|-------|--------|------|-------|------------|",
      "| ⛔ BLOCKED | 1 | BATCH-1-GATE | Verify gates | CODEX | — |"
    ].join("\n"), "utf8");

    const kill = vi.fn(async () => ({ threadId: "pm-thread-123", status: "killed", raw: {} }));
    const meridianApi: MeridianApiClient = {
      spawn: async () => ({ threadId: "pm-thread-123" }),
      run: async () => ({
        threadId: "pm-thread-123",
        status: "success",
        runState: "completed",
        content: "PM closed the loop and continued the dispatcher.",
        raw: {
          trace_id: "44444444-4444-4444-8444-444444444444",
          summary_text: "PM closed the loop.",
          details_text: [
            "Your message:",
            "Resolve BATCH-1-GATE",
            "",
            "Agent reply:",
            "PM closed the loop and continued the dispatcher."
          ].join("\n"),
          timestamp: "2026-05-03T00:00:00.000Z"
        }
      }),
      kill,
      listCredentials: async () => []
    };

    try {
      await startPmResolver({
        dispatcherId: "agent-dispatcher-pm",
        config: {
          ...config,
          dispatch_plan_path: dispatchPlanPath
        },
        issue: {
          status: "manual_intervention_required",
          workerId: "BATCH-1-GATE",
          source: "watchdog",
          message: "Blocked gate needs PM"
        }
      }, { meridianApi });

      await waitForExpect(async () => {
        const state = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
          pm_resolvers?: Array<{
            thread_id: string;
            status: string;
            issue: { worker_id?: string };
            result?: { content?: string };
          }>;
        };
        expect(state.pm_resolvers).toEqual([
          expect.objectContaining({
            thread_id: "pm-thread-123",
            status: "completed",
            issue: expect.objectContaining({
              worker_id: "BATCH-1-GATE"
            }),
            result: expect.objectContaining({
              content: "PM closed the loop and continued the dispatcher."
            })
          })
        ]);
        expect(kill).toHaveBeenCalledWith("pm-thread-123");
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("LifecycleStore.recordPmResolverResult — marker primary signal", () => {
  const PM_THREAD_ID = "pm-thread-marker-123";
  const TARGET_WORKER_ID = "BATCH-1-GATE";

  it("marks the PM run completed when the marker reports outcome: resolved", async () => {
    const harness = await createPmResolverLifecycleHarness();
    try {
      seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

      harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
        content: [
          "Closed the loop and resumed the dispatcher.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          `worker_id: ${TARGET_WORKER_ID}`,
          "role: pm-resolver",
          "outcome: resolved",
          "pm_action: retry",
          "notes: rebuilt manifest and retried worker",
          "<<<END>>>"
        ].join("\n")
      }));

      const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
      expect(entry?.status).toBe("completed");
      expect(harness.info).toHaveBeenCalledWith("PM resolver decided via marker", {
        event: "pm_resolver_marker_decision",
        thread_id: PM_THREAD_ID,
        worker_id: TARGET_WORKER_ID,
        outcome: "resolved",
        pm_action: "retry"
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("marks the PM run failed when the marker reports outcome: escalated and the target worker is not in a healthy state", async () => {
    const harness = await createPmResolverLifecycleHarness();
    try {
      // Seed the worker in "blocked" so reconcile cannot promote failed → completed.
      seedBlockedWorker(harness.store, TARGET_WORKER_ID);
      seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

      harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
        content: [
          "Cannot proceed without product approval.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          `worker_id: ${TARGET_WORKER_ID}`,
          "role: pm-resolver",
          "outcome: escalated",
          "pm_action: escalate_human",
          "notes: needs human decision on credentials",
          "<<<END>>>"
        ].join("\n")
      }));

      const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
      expect(entry?.status).toBe("failed");
    } finally {
      await harness.cleanup();
    }
  });

  it("promotes an escalated marker outcome to completed when the target worker has reached a healthy lifecycle state in parallel", async () => {
    const harness = await createPmResolverLifecycleHarness();
    try {
      seedCompletedWorker(harness.store, TARGET_WORKER_ID);
      seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

      harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
        content: [
          "Recommended human escalation, but worker already finished.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          `worker_id: ${TARGET_WORKER_ID}`,
          "role: pm-resolver",
          "outcome: escalated",
          "pm_action: escalate_human",
          "<<<END>>>"
        ].join("\n")
      }));

      const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
      // reconcilePmStatusAgainstWorkerState promotes "failed" → "completed"
      // when the target worker has landed in a healthy state.
      expect(entry?.status).toBe("completed");
    } finally {
      await harness.cleanup();
    }
  });

  it("force-fails the PM entry with a thread-id collision bleed error when marker.worker_id does not match the issue's target worker", async () => {
    const harness = await createPmResolverLifecycleHarness();
    try {
      seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

      const content = [
        "PM acted on the wrong worker.",
        "",
        "<<<MERIDIAN-STATUS>>>",
        "worker_id: BATCH-9-WRONG",
        "role: pm-resolver",
        "outcome: resolved",
        "<<<END>>>"
      ].join("\n");

      harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
        status: "success",
        runState: "completed",
        content
      }));

      const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
      // Worker-id mismatch is treated as a thread-id collision bleed: force
      // `failed` (regardless of envelope status) so the dispatcher's gate
      // reopens and a fresh PM can spawn on a different id.
      expect(entry?.status).toBe("failed");
      expect(entry?.error).toBe("thread_id_collision_pm_resolver_worker_mismatch");
      expect(entry?.marker_outcome).toBeNull();
      expect(entry?.marker_pm_action).toBeNull();

      expect(harness.warn).toHaveBeenCalledWith(
        "PM resolver marker worker mismatch — treating as thread-id collision bleed",
        {
          event: "pm_resolver_marker_worker_mismatch_bleed",
          thread_id: PM_THREAD_ID,
          target_worker_id: TARGET_WORKER_ID,
          marker_worker_id: "BATCH-9-WRONG",
          marker_role: "pm-resolver",
          content_length: content.length
        }
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("force-fails the PM entry with a thread-id collision bleed error when a non-pm-resolver marker lands in the PM channel", async () => {
    const harness = await createPmResolverLifecycleHarness();
    try {
      seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

      const content = [
        "Worker marker accidentally surfaced in PM reply.",
        "",
        "<<<MERIDIAN-STATUS>>>",
        `worker_id: ${TARGET_WORKER_ID}`,
        "role: worker",
        "outcome: complete",
        "<<<END>>>"
      ].join("\n");

      harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
        status: "success",
        runState: "completed",
        content
      }));

      const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
      // Wrong-role marker = Hub thread-id collision bleed (the canonical
      // agent-dispatcher-67f6a3fc W-15 codex_58 R-01-validator-bleed shape).
      // Force `failed` with a specific error so the gate reopens and the
      // tainted entry cannot be silently reconciled to `completed` later.
      expect(entry?.status).toBe("failed");
      expect(entry?.error).toBe("thread_id_collision_worker_bleed");
      expect(entry?.marker_outcome).toBeNull();
      expect(entry?.marker_pm_action).toBeNull();

      expect(harness.warn).toHaveBeenCalledWith(
        "PM resolver marker wrong role — treating as thread-id collision bleed",
        {
          event: "pm_resolver_marker_wrong_role_bleed",
          thread_id: PM_THREAD_ID,
          target_worker_id: TARGET_WORKER_ID,
          marker_role: "worker",
          marker_worker_id: TARGET_WORKER_ID,
          content_length: content.length
        }
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("uses envelope mapping unchanged when no marker is present in the reply", async () => {
    const harness = await createPmResolverLifecycleHarness();
    try {
      seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

      harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
        status: "success",
        runState: "completed",
        content: "PM finished without emitting a marker."
      }));

      const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
      expect(entry?.status).toBe("completed");
      expect(harness.info).not.toHaveBeenCalledWith(
        "PM resolver decided via marker",
        expect.anything()
      );
      expect(harness.info).not.toHaveBeenCalledWith(
        "PM resolver marker mismatch",
        expect.anything()
      );
      expect(harness.info).not.toHaveBeenCalledWith(
        "PM resolver marker wrong role",
        expect.anything()
      );
    } finally {
      await harness.cleanup();
    }
  });

  describe("Phase A6: signal_source observability (no gate on PM channel)", () => {
    it("uses envelope mapping unchanged even when fallback heuristics are disabled — PM has no narrative heuristic to gate", async () => {
      const harness = await createPmResolverLifecycleHarness({ fallbackHeuristicsEnabled: false });
      try {
        seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

        harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
          status: "success",
          runState: "completed",
          content: "PM finished without emitting a marker."
        }));

        const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
        // PM is structured envelope mapping, NOT heuristic — gate must not
        // affect this path; envelope success → "completed".
        expect(entry?.status).toBe("completed");
      } finally {
        await harness.cleanup();
      }
    });

    it("emits pm_resolver_signal_source=marker when the PM marker is honoured", async () => {
      const harness = await createPmResolverLifecycleHarness();
      try {
        seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

        harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
          content: [
            "Closed the loop.",
            "",
            "<<<MERIDIAN-STATUS>>>",
            `worker_id: ${TARGET_WORKER_ID}`,
            "role: pm-resolver",
            "outcome: resolved",
            "pm_action: retry",
            "<<<END>>>"
          ].join("\n")
        }));

        expect(harness.info).toHaveBeenCalledWith("PM resolver signal source", {
          event: "pm_resolver_signal_source",
          thread_id: PM_THREAD_ID,
          signal_source: "marker",
          result: "completed"
        });
      } finally {
        await harness.cleanup();
      }
    });

    it("emits pm_resolver_signal_source=envelope when no marker is present", async () => {
      const harness = await createPmResolverLifecycleHarness();
      try {
        seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

        harness.store.recordPmResolverResult(PM_THREAD_ID, buildPmRunResult({
          status: "success",
          runState: "completed",
          content: "PM finished without emitting a marker."
        }));

        expect(harness.info).toHaveBeenCalledWith("PM resolver signal source", {
          event: "pm_resolver_signal_source",
          thread_id: PM_THREAD_ID,
          signal_source: "envelope",
          result: "completed"
        });
      } finally {
        await harness.cleanup();
      }
    });

    it("emits pm_resolver_signal_source=envelope on the thrown-run failure path so the A7 soak metric covers PM failures", async () => {
      const harness = await createPmResolverLifecycleHarness();
      try {
        seedPmResolverEntry(harness.store, PM_THREAD_ID, TARGET_WORKER_ID);

        harness.store.recordPmResolverFailure(PM_THREAD_ID, "boom: spawn failed");

        const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
        // No target worker is seeded as a real worker, so the reconciler has
        // nothing to promote — the failure stays "failed".
        expect(entry?.status).toBe("failed");

        expect(harness.info).toHaveBeenCalledWith("PM resolver signal source", {
          event: "pm_resolver_signal_source",
          thread_id: PM_THREAD_ID,
          worker_id: TARGET_WORKER_ID,
          signal_source: "envelope",
          result: "failed",
          error: "boom: spawn failed"
        });
      } finally {
        await harness.cleanup();
      }
    });
  });
});

interface PmResolverLifecycleHarness {
  directory: string;
  store: LifecycleStore;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function createPmResolverLifecycleHarness(
  options: { fallbackHeuristicsEnabled?: boolean } = {}
): Promise<PmResolverLifecycleHarness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-marker-"));
  const filePath = path.join(directory, "dispatch_threads.json");
  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  const info = vi.fn();
  const warn = vi.fn();
  const store = new LifecycleStore(filePath, {
    dispatchPlanPath,
    log: { info, warn },
    fallbackHeuristicsEnabled: options.fallbackHeuristicsEnabled
  });

  return {
    directory,
    store,
    info,
    warn,
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}

function seedPmResolverEntry(store: LifecycleStore, threadId: string, workerId: string): void {
  store.recordPmResolverStart(threadId, {
    status: "manual_intervention_required",
    workerId,
    source: "watchdog",
    message: "Test seed"
  }, {
    agentType: "codex",
    modelId: "claude-opus-4",
    mode: "bridge",
    autoApprove: true
  });
}

function seedBlockedWorker(store: LifecycleStore, workerId: string): void {
  store.recordWorkerStart(workerId, `${workerId}-thread`, "11111111-1111-4111-8111-111111111111", []);
  store.setWorkerStatus(workerId, "blocked", "test_seed_blocked");
}

function seedCompletedWorker(store: LifecycleStore, workerId: string): void {
  store.recordWorkerStart(workerId, `${workerId}-thread`, "11111111-1111-4111-8111-111111111111", []);
  store.setWorkerStatus(workerId, "completed", "test_seed_completed");
}

function loadPmResolverEntry(
  store: LifecycleStore,
  threadId: string
): {
  status: string;
  error: string | null;
  marker_outcome: string | null;
  marker_pm_action: string | null;
} | null {
  const state = store.load();
  const entry = state.pm_resolvers?.find((candidate) => candidate.thread_id === threadId);
  if (!entry) {
    return null;
  }
  return {
    status: entry.status,
    error: entry.error ?? null,
    marker_outcome: entry.marker_outcome ?? null,
    marker_pm_action: entry.marker_pm_action ?? null
  };
}

function buildPmRunResult(overrides: {
  status?: string;
  runState?: string;
  content?: string;
  raw?: Record<string, unknown>;
} = {}): {
  status: string;
  runState?: string;
  content?: string;
  raw?: Record<string, unknown>;
} {
  return {
    status: overrides.status ?? "success",
    runState: overrides.runState ?? "completed",
    content: overrides.content ?? "",
    raw: overrides.raw
  };
}

async function waitForExpect(assertion: () => void | Promise<void>, timeoutMs = 250): Promise<void> {
  const started = Date.now();
  let lastError: unknown = null;

  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (lastError) {
    throw lastError;
  }
}
