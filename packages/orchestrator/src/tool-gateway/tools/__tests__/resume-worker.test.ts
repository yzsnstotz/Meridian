import * as fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../../../roles/agent-dispatcher/lifecycle-store";
import killTool from "../kill";
import resumeWorkerTool, { executeResumeWorkerAction } from "../resume-worker";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("resume-worker tool", () => {
  it("resets a running worker to pending on retry and kills the recorded thread", async () => {
    const harness = await createHarness();

    const result = await executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "retry"
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            thread_id: "worker-thread-456"
          }
        })
      }
    );

    expect(result).toEqual({
      worker: "N-04",
      action: "retry",
      status: "pending",
      thread_id: "worker-thread-456",
      thread_killed: true,
      retry_count: 0
    });
    expect(harness.lifecycleStore.load().workers["N-04"]).toMatchObject({
      status: "pending",
      thread_id: "worker-thread-456",
      hub_result: null,
      retry_count: 0
    });
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ⬜ | 2 | N-04 | Resume Worker Tool |");
  });

  it("does not reset a running worker when killing the recorded thread fails", async () => {
    const harness = await createHarness();
    const killThread = vi.fn().mockResolvedValue({
      ok: false,
      error: "bootstrap_key_missing"
    });

    await expect(executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "retry"
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread
      }
    )).rejects.toThrow(
      'Cannot retry worker "N-04": failed to stop recorded thread worker-thread-456: bootstrap_key_missing. Worker status was not changed.'
    );

    expect(killThread).toHaveBeenCalledWith("worker-thread-456");
    expect(harness.lifecycleStore.load().workers["N-04"]).toMatchObject({
      status: "running",
      thread_id: "worker-thread-456",
      hub_result: null,
      retry_count: 0
    });
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| 🔄 | 2 | N-04 | Resume Worker Tool |");
  });

  it("allows forced retry to recover a blocked worker whose recorded thread has lost its bootstrap key", async () => {
    const harness = await createHarness();
    const state = harness.lifecycleStore.load();
    state.workers["N-04"] = {
      ...state.workers["N-04"]!,
      status: "blocked",
      hub_result: {
        trace_id: "11111111-1111-4111-8111-111111111111",
        thread_id: "worker-thread-456",
        source: "codex",
        status: "success",
        run_state: "completed",
        content: "<<<MERIDIAN-STATUS>>>\nworker_id: N-04\noutcome: blocked\nnotes: environment repaired; retry needed\n<<<END>>>",
        attachments: [],
        timestamp: "2026-04-05T00:05:00.000Z"
      }
    };
    harness.lifecycleStore.save(state);
    const killThread = vi.fn().mockResolvedValue({
      ok: false,
      error: "bootstrap_key_missing"
    });

    const result = await executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "retry",
        force: true
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread
      }
    );

    expect(killThread).toHaveBeenCalledWith("worker-thread-456");
    expect(result).toMatchObject({
      worker: "N-04",
      action: "retry",
      status: "pending",
      thread_id: "worker-thread-456",
      thread_killed: false,
      retry_count: 0
    });
    expect(result.kill_error).toBe("bootstrap_key_missing");
    expect(result.prior_failure_reason).toContain("outcome: blocked");
    expect(harness.lifecycleStore.load().workers["N-04"]).toMatchObject({
      status: "pending",
      thread_id: "worker-thread-456",
      hub_result: null,
      retry_count: 0
    });
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ⬜ | 2 | N-04 | Resume Worker Tool |");
  });

  it("treats a missing recorded thread as already stopped before retry", async () => {
    const harness = await createHarness();

    const result = await executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "retry"
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: async () => ({
          ok: false,
          error: "kill failed: Routing failed: No registered agent instance found for thread_id=worker-thread-456"
        })
      }
    );

    expect(result).toEqual({
      worker: "N-04",
      action: "retry",
      status: "pending",
      thread_id: "worker-thread-456",
      thread_killed: true,
      retry_count: 0
    });
    expect(harness.lifecycleStore.load().workers["N-04"]?.status).toBe("pending");
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ⬜ | 2 | N-04 | Resume Worker Tool |");
  });

  it("resets retry_count on each manual retry so permanently-failed workers can be redone", async () => {
    const harness = await createHarness();

    // First retry — resets to 0
    await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "retry" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );
    expect(harness.lifecycleStore.load().workers["N-04"]?.retry_count).toBe(0);

    // Simulate the worker running and failing again
    harness.lifecycleStore.recordWorkerStart("N-04", "thread-2nd", "trace-2nd", []);
    harness.lifecycleStore.setWorkerStatus("N-04", "failed", "hub_result:provider_error");

    // Second retry — resets to 0 again
    const result = await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "retry" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );
    expect(result.retry_count).toBe(0);
    expect(harness.lifecycleStore.load().workers["N-04"]?.retry_count).toBe(0);
  });

  it("clears an exhausted validation cycle budget on retry so the next completion is judged", async () => {
    const harness = await createHarness();
    const state = harness.lifecycleStore.load();
    state.workers["N-04"] = {
      ...state.workers["N-04"]!,
      status: "failed",
      validation: {
        current_cycle: 5,
        max_fix_cycles: 5,
        validator_thread_id: null,
        last_score: 0,
        last_feedback: "judged against the superseded contract",
        history: [],
        spawn_failure_count: 0,
        last_spawn_failure_at: null
      }
    };
    harness.lifecycleStore.save(state);

    await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "retry" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );

    // A retry means the worker's INPUT changed. A budget accrued against the
    // old input must not survive it, or isValidationCycleBudgetExhausted fails
    // the row on completion and no validator ever spawns.
    const validation = harness.lifecycleStore.load().workers["N-04"]?.validation;
    expect(validation ?? null).toBeNull();
  });

  it("clears a prior failure hub result when retrying a failed worker", async () => {
    const harness = await createHarness();
    const state = harness.lifecycleStore.load();
    state.workers["N-04"] = {
      ...state.workers["N-04"]!,
      status: "failed",
      hub_result: {
        trace_id: "11111111-1111-4111-8111-111111111111",
        thread_id: "worker-thread-456",
        source: "codex",
        status: "error",
        run_state: "completed",
        content: "Status: BLOCKED",
        attachments: [],
        timestamp: "2026-04-05T00:05:00.000Z"
      }
    };
    harness.lifecycleStore.save(state);

    await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "retry" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );

    expect(harness.lifecycleStore.load().workers["N-04"]).toMatchObject({
      status: "pending",
      hub_result: null
    });
  });

  it("accepts lowercase dispatch-plan table headers", async () => {
    const harness = await createHarness();
    await fs.writeFile(
      harness.planPath,
      [
        "| status | batch | worker | task |",
        "|--------|-------|--------|------|",
        "| 🔄 | 2 | N-04 | Resume Worker Tool |",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "retry" },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: async () => ({ ok: true })
      }
    );

    expect(result).toMatchObject({
      worker: "N-04",
      action: "retry",
      status: "pending"
    });
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ⬜ | 2 | N-04 | Resume Worker Tool |");
  });

  it("preserves retry_count across recordWorkerStart after manual retry", async () => {
    const harness = await createHarness();

    // Manual retry resets retry_count to 0
    await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "retry" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );

    // Simulate worker re-start (recordWorkerStart from "pending" should preserve retry_count)
    harness.lifecycleStore.recordWorkerStart("N-04", "thread-new", "trace-new", ["output.txt"]);
    expect(harness.lifecycleStore.load().workers["N-04"]?.retry_count).toBe(0);
  });

  it("marks a worker skipped and preserves the skip symbol in the dispatch plan", async () => {
    const harness = await createHarness();

    const result = await executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "skip"
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: async () => ({ ok: true })
      }
    );

    expect(result).toMatchObject({
      worker: "N-04",
      action: "skip",
      status: "skipped"
    });
    expect(harness.lifecycleStore.load().workers["N-04"]?.status).toBe("skipped");
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ⛔ SKIPPED | 2 | N-04 | Resume Worker Tool |");
  });

  it("reopens a completed worker without discarding the prior hub result", async () => {
    const harness = await createHarness();
    harness.lifecycleStore.save({
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
          expected_outputs: ["/tmp/report.md"],
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-456",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Previous attempt finished cleanly.",
            summary_text: "Previous attempt finished cleanly.",
            details_text: "Agent reply:\nPrevious attempt finished cleanly.",
            attachments: [],
            timestamp: "2026-04-05T00:10:00.000Z"
          },
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "retry" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );

    expect(harness.lifecycleStore.load().workers["N-04"]).toMatchObject({
      status: "pending",
      hub_result: expect.objectContaining({
        status: "success",
        summary_text: "Previous attempt finished cleanly."
      }),
      retry_count: 0
    });

    // Plan markdown must also reflect the reset — not stay stuck at ✅
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ⬜ | 2 | N-04 | Resume Worker Tool |");
  });

  it("falls back to markdown-only retry when a plan row has no lifecycle entry yet", async () => {
    const harness = await createHarness();

    const result = await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "R-04", action: "retry" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );

    expect(result).toEqual({
      worker: "R-04",
      action: "retry",
      status: "pending",
      thread_id: null,
      thread_killed: false,
      retry_count: 0
    });
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ⬜ | 3 | R-04 | GUI Resume Buttons |");
  });

  it("rejects force-complete without confirmation", async () => {
    const harness = await createHarness();

    await expect(executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "force-complete"
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: async () => ({ ok: true })
      }
    )).rejects.toThrow("force-complete requires force=true");
  });

  it("rejects force-complete when worker output contains a BLOCKED marker", async () => {
    const harness = await createHarness();
    harness.lifecycleStore.save({
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
          status: "running",
          expected_outputs: [],
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-456",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Status: ⛔ BLOCKED\n\nBaseline test suite is failing.",
            attachments: [],
            timestamp: "2026-04-05T00:10:00.000Z"
          },
          validation: {
            current_cycle: 0,
            max_fix_cycles: 5,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: [],
            spawn_failure_count: 3,
            last_spawn_failure_at: "2026-04-05T00:11:00.000Z"
          },
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    await expect(executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "force-complete",
        force: true
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: async () => ({ ok: true })
      }
    )).rejects.toThrow("BLOCKED or PAUSE marker");
  });

  it("force-complete clears stale hub_result so syncPlanView does not revert plan to ⛔ BLOCKED", async () => {
    const harness = await createHarness();
    harness.lifecycleStore.save({
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
          status: "blocked",
          expected_outputs: [],
          // Benign mention of "blocked by" — does not contain a structured
          // ⛔ BLOCKED marker (so isNonCompletionContent is false and the
          // force-complete rejection does not fire), but does trigger
          // hubResultContainsBlockSignal in resolveDisplayStatus.
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-456",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Smoke test is blocked by the wrapper allowlist; switched to count(*).",
            attachments: [],
            timestamp: "2026-04-05T00:10:00.000Z"
          },
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    await executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "force-complete",
        force: true
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: async () => ({ ok: true })
      }
    );

    // Lifecycle: completed, hub_result cleared so subsequent saves do not
    // re-derive the plan status from the stale block signal.
    const recoveredWorker = harness.lifecycleStore.load().workers["N-04"];
    expect(recoveredWorker).toMatchObject({
      status: "completed",
      hub_result: null
    });
    expect(recoveredWorker).not.toHaveProperty("validation");
    // Plan markdown stays ✅ even after a follow-up no-op save triggers syncPlanView.
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ✅ | 2 | N-04 | Resume Worker Tool |");

    harness.lifecycleStore.save(harness.lifecycleStore.load());
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ✅ | 2 | N-04 | Resume Worker Tool |");
  });

  it("force-complete can clear stale hub_result when the old thread cannot be killed because the bootstrap key is unavailable", async () => {
    const harness = await createHarness();
    harness.lifecycleStore.save({
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
          status: "blocked",
          expected_outputs: [],
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-456",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Smoke test is blocked by the wrapper allowlist; operator verified the replacement evidence.",
            attachments: [],
            timestamp: "2026-04-05T00:10:00.000Z"
          },
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    const result = await executeResumeWorkerAction(
      {
        planPath: harness.planPath,
        workerId: "N-04",
        action: "force-complete",
        force: true
      },
      {
        lifecycleStoreFactory: () => harness.lifecycleStore,
        killThread: async () => ({ ok: false, error: "bootstrap_key_missing" })
      }
    );

    expect(result).toMatchObject({
      worker: "N-04",
      action: "force-complete",
      status: "completed",
      thread_id: "worker-thread-456",
      thread_killed: false,
      retry_count: 0,
      kill_error: "bootstrap_key_missing"
    });
    const recoveredWorker = harness.lifecycleStore.load().workers["N-04"];
    expect(recoveredWorker).toMatchObject({
      status: "completed",
      hub_result: null
    });
    expect(recoveredWorker).not.toHaveProperty("validation");
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ✅ | 2 | N-04 | Resume Worker Tool |");

    harness.lifecycleStore.save(harness.lifecycleStore.load());
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| ✅ | 2 | N-04 | Resume Worker Tool |");
  });

  it("validate action moves a stuck worker to awaiting_validation, kills the thread, and clears stale hub_result", async () => {
    const harness = await createHarness();
    harness.lifecycleStore.save({
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
          status: "failed",
          expected_outputs: [],
          // Stale synthesized output_artifact hub_result that misread the
          // current attempt — the operator clicks Validate to let the
          // validator judge the report on disk instead of re-trusting this
          // synthesized signal.
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-456",
            source: "output_artifact",
            status: "error",
            run_state: "completed",
            content: "Recovered from disk: ...validation failed... <stale narrative>",
            attachments: [],
            timestamp: "2026-04-05T00:10:00.000Z"
          },
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    const killSpy = vi.fn().mockResolvedValue({ ok: true });
    const result = await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "validate" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: killSpy }
    );

    expect(result).toMatchObject({
      worker: "N-04",
      action: "validate",
      status: "awaiting_validation",
      thread_id: "worker-thread-456",
      thread_killed: true
    });
    expect(killSpy).toHaveBeenCalledWith("worker-thread-456");

    const reloaded = harness.lifecycleStore.load().workers["N-04"];
    expect(reloaded?.status).toBe("awaiting_validation");
    expect(reloaded?.hub_result).toBeNull();
    // Validation skeleton seeded so processValidationQueue Phase 2 has somewhere
    // to write cycle bookkeeping.
    expect(reloaded?.validation).toMatchObject({
      current_cycle: 0,
      max_fix_cycles: 3,
      validator_thread_id: null,
      history: []
    });

    // Plan markdown reflects 🔍 (awaiting_validation) instead of 🔄 (running).
    await expect(fs.readFile(harness.planPath, "utf8")).resolves.toContain("| 🔍 | 2 | N-04 | Resume Worker Tool |");
  });

  it("validate action does not require force=true (unlike force-complete)", async () => {
    const harness = await createHarness();

    const result = await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "validate" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );

    expect(result.status).toBe("awaiting_validation");
  });

  it("supports the CLI wrapper contract for force-complete", async () => {
    const harness = await createHarness();
    vi.spyOn(killTool, "execute").mockResolvedValue({ ok: true, data: { thread_id: "worker-thread-456" } });

    const result = await resumeWorkerTool.execute({
      plan: harness.planPath,
      worker: "N-04",
      action: "force-complete",
      force: "true"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-04",
        action: "force-complete",
        status: "completed",
        thread_id: "worker-thread-456",
        thread_killed: true,
        retry_count: 0
      }
    });
  });
});

async function createHarness(): Promise<{
  planPath: string;
  lifecycleStore: LifecycleStore;
}> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-resume-worker-");
  tempDirectories.add(directory);
  const planPath = `${directory}/dispatch_plan.md`;
  const sidecarPath = `${directory}/dispatch_threads.json`;
  const lifecycleStore = new LifecycleStore(sidecarPath, {
    dispatchPlanPath: planPath
  });

  await fs.writeFile(
    planPath,
    [
      "| Status | Batch | Worker | Task |",
      "|--------|-------|--------|------|",
      "| 🔄 | 2 | N-04 | Resume Worker Tool |",
      "| ⬜ | 3 | R-04 | GUI Resume Buttons |",
      ""
    ].join("\n"),
    "utf8"
  );
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

  return {
    planPath,
    lifecycleStore
  };
}

describe("validate after budget exhaustion (regression: instant re-fail, no validator)", () => {
  it("resets current_cycle so the pre-spawn budget check cannot fire immediately", async () => {
    // `--action validate` used to seed a new max_fix_cycles while carrying the
    // old current_cycle forward: a row at 5/5 became 5/3 and was failed for
    // "max_cycles_exhausted" before any validator spawned. Observed on C-02,
    // whose code work the validator had already accepted.
    const harness = await createHarness();
    const state = harness.lifecycleStore.load();
    state.workers["N-04"]!.status = "failed";
    state.workers["N-04"]!.validation = {
      current_cycle: 5,
      max_fix_cycles: 5,
      validator_thread_id: null,
      last_score: 0.5,
      last_feedback: "phantom finding",
      history: []
    };
    harness.lifecycleStore.save(state);

    await executeResumeWorkerAction(
      { planPath: harness.planPath, workerId: "N-04", action: "validate" },
      { lifecycleStoreFactory: () => harness.lifecycleStore, killThread: async () => ({ ok: true }) }
    );

    const validation = harness.lifecycleStore.load().workers["N-04"]?.validation;
    expect(validation?.current_cycle).toBe(0);
    expect(validation?.max_fix_cycles).toBeGreaterThan(0);
  });
});
