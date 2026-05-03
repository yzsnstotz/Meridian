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

  it("records PM resolver start and completion in the dispatch lifecycle sidecar", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "| Status | Batch | Worker | Task | Model | Depends On |",
      "|--------|-------|--------|------|-------|------------|",
      "| ⛔ BLOCKED | 1 | BATCH-1-GATE | Verify gates | CODEX | — |"
    ].join("\n"), "utf8");

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
      kill: async () => ({ threadId: "pm-thread-123", status: "killed", raw: {} })
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

  it("falls back to envelope mapping and logs pm_resolver_marker_mismatch when marker.worker_id does not match the issue's target worker", async () => {
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
        status: "error",
        runState: "error",
        content
      }));

      const entry = loadPmResolverEntry(harness.store, PM_THREAD_ID);
      // Envelope said error → mapPmResolverRunStatus → "failed"; target worker
      // not seeded so reconcile leaves it failed.
      expect(entry?.status).toBe("failed");

      expect(harness.info).toHaveBeenCalledWith("PM resolver marker mismatch", {
        event: "pm_resolver_marker_mismatch",
        thread_id: PM_THREAD_ID,
        target_worker_id: TARGET_WORKER_ID,
        marker_worker_id: "BATCH-9-WRONG",
        marker_role: "pm-resolver",
        content_length: content.length
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to envelope mapping and logs pm_resolver_marker_wrong_role when a non-pm-resolver marker lands in the PM channel", async () => {
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
      // Envelope success → "completed" via fallback.
      expect(entry?.status).toBe("completed");

      expect(harness.info).toHaveBeenCalledWith("PM resolver marker wrong role", {
        event: "pm_resolver_marker_wrong_role",
        thread_id: PM_THREAD_ID,
        marker_role: "worker",
        marker_worker_id: TARGET_WORKER_ID,
        content_length: content.length
      });
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
});

interface PmResolverLifecycleHarness {
  directory: string;
  store: LifecycleStore;
  info: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function createPmResolverLifecycleHarness(): Promise<PmResolverLifecycleHarness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-marker-"));
  const filePath = path.join(directory, "dispatch_threads.json");
  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  const info = vi.fn();
  const store = new LifecycleStore(filePath, {
    dispatchPlanPath,
    log: { info }
  });

  return {
    directory,
    store,
    info,
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
): { status: string } | null {
  const state = store.load();
  return state.pm_resolvers?.find((entry) => entry.thread_id === threadId) ?? null;
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
