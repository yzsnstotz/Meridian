import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../lifecycle-store";
import {
  applyValidatorVerdictFromContent,
  deliverValidatorFeedback,
  executeValidationCycle,
  parseValidatorOutputFromJson,
  type ValidatorOrchestratorDeps
} from "../validator-orchestrator";
import * as activeToolProcess from "../active-tool-process";
import { buildDefaultValidatorPrompt } from "../validator-prompt-builder";
import type { MeridianApiClient } from "../meridian-api-client";
import type { DispatchContinuationPlanRow } from "../service-continuation";
import type { ValidatorConfig } from "../../../types";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("executeValidationCycle", () => {
  it("passes binary validation when the validator reports a positive verdict", async () => {
    const harness = await createHarness({
      validatorConfig: {
        threshold_type: "binary",
        pass_threshold: 1
      }
    });
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-binary-pass" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-binary-pass",
      status: "success",
      runState: "completed",
      content: '{"positive":true,"feedback":"implementation is accepted"}',
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "passed",
      score: 1
    });
    expect(harness.lifecycleStore.load().workers["N-02"]?.validation?.history[0]).toMatchObject({
      score: 1,
      feedback: "implementation is accepted"
    });
  });

  it("uses the dispatch plan branch column instead of a synthetic task branch", async () => {
    const contexts: Array<{ taskBranch: string }> = [];
    const harness = await createHarness({
      buildPrompt: (context) => {
        contexts.push({ taskBranch: context.taskBranch });
        return buildDefaultValidatorPrompt(context);
      }
    });
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-plan-branch" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-plan-branch",
      status: "success",
      runState: "completed",
      content: '{"score":0.9,"feedback":"branch accepted"}',
      raw: {}
    });

    const outcome = await executeValidationCycle(
      harness.deps,
      "N-02",
      {
        ...buildPlanRow(),
        branch: "bug-fix-2026-06-r36/W-01-skill-scan-id"
      } as DispatchContinuationPlanRow
    );

    expect(outcome).toEqual({
      status: "passed",
      score: 0.9
    });
    expect(contexts[0]?.taskBranch).toBe("bug-fix-2026-06-r36/W-01-skill-scan-id");
  });

  it("requests fixes for binary validation when the validator is not positive", async () => {
    const harness = await createHarness({
      validatorConfig: {
        threshold_type: "binary"
      }
    });
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-binary-fail" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-binary-fail",
      status: "success",
      runState: "completed",
      content: '{"positive":false,"feedback":"tests are missing"}',
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "fix_requested",
      score: 0,
      cycle: 1,
      maxCycles: 3
    });
    expect(harness.lifecycleStore.load().workers["N-02"]?.validation?.history[0]).toMatchObject({
      score: 0,
      feedback: "tests are missing"
    });
  });

  it("retries validator spawn when Meridian returns a thread id already recorded in lifecycle state", async () => {
    const harness = await createHarness();
    harness.spawn
      .mockResolvedValueOnce({ threadId: "worker-thread-n02" })
      .mockResolvedValueOnce({ threadId: "validator-thread-fresh" });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "passed",
      score: 0.9
    });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "validator-thread-fresh"
    }));
    // The first spawn returned `worker-thread-n02`, which is the *live* worker
    // thread for N-02 (status=awaiting_validation). The orphan-kill must NOT
    // fire on that branch — killing it would terminate the worker we are
    // about to validate (observed: "worker had been killed before validator
    // approval"). The retry still happens; only the kill is suppressed.
    expect(harness.kill).not.toHaveBeenCalledWith("worker-thread-n02");
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("completed");
    expect(worker?.validation?.history[0]?.validator_thread_id).toBe("validator-thread-fresh");
  });

  it("retries (and skips orphan-kill) when Meridian returns a validator thread id reserved by ANOTHER dispatch plan", async () => {
    // Validator-level cross-plan analogue of the worker-launcher cross-plan
    // fix. After a Hub restart wraps the allocator, a fresh validator spawn
    // can be handed another plan's still-live worker/validator thread.
    const harness = await createHarness();
    const siblingDirectory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-validator-sibling-"));
    tempDirectories.add(siblingDirectory);
    const siblingDispatchPlanPath = path.join(siblingDirectory, "dispatch_plan.md");
    await fs.writeFile(siblingDispatchPlanPath, "# sibling plan\n", "utf8");
    new LifecycleStore(path.join(siblingDirectory, "dispatch_threads.json"), {
      dispatchPlanPath: siblingDispatchPlanPath
    }).save({
      version: 2,
      dispatcher: {
        thread_id: "sibling-dispatcher",
        started_at: "2026-05-12T13:21:55.521Z",
        status: "running"
      },
      workers: {
        "W-09": {
          thread_id: "codex_05",
          trace_id: null,
          started_at: "2026-05-12T13:30:00.000Z",
          last_seen_at: "2026-05-12T14:00:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    harness.deps.otherDispatchPlanPaths = [siblingDispatchPlanPath];
    harness.spawn
      .mockResolvedValueOnce({ threadId: "codex_05" })
      .mockResolvedValueOnce({ threadId: "validator-thread-fresh" });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "passed",
      score: 0.9
    });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    // codex_05 belongs to the SIBLING plan's live worker (status=awaiting_validation).
    // Killing it would take out that plan's worker mid-flight, so the
    // orphan-kill branch is suppressed.
    expect(harness.kill).not.toHaveBeenCalledWith("codex_05");
    expect(harness.run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "validator-thread-fresh"
    }));
  });

  it("spawns stateless codex validator calls in read-only mode", async () => {
    const harness = await createHarness({
      validatorConfig: {
        agent_type: "codex",
        mode: "stateless_call"
      }
    });
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-stateless" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-stateless",
      status: "success",
      runState: "completed",
      content: '{"score":0.91,"feedback":"accepted"}',
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "passed",
      score: 0.91
    });
    expect(harness.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "codex",
      mode: "stateless_call",
      sandboxMode: "read-only",
      autoApprove: false
    }));
  });

  it("forwards validatorConfig.credential_id onto the validator spawn", async () => {
    const harness = await createHarness({
      validatorConfig: {
        credential_id: "cred-validator"
      }
    });
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-cred" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-cred",
      status: "success",
      runState: "completed",
      content: '{"score":0.92,"feedback":"ok"}',
      raw: {}
    });

    await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(harness.spawn).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: "cred-validator"
    }));
  });

  it("retries validator spawn when Meridian recycles a terminal worker thread id", async () => {
    const harness = await createHarness({
      validatorConfig: {
        agent_type: "codex",
        mode: "stateless_call"
      }
    });
    const state = harness.lifecycleStore.load();
    state.workers["BATCH-1-GATE"] = {
      thread_id: "codex_40",
      trace_id: null,
      started_at: "2026-05-02T00:00:00.000Z",
      last_seen_at: "2026-05-02T00:10:00.000Z",
      status: "completed",
      expected_outputs: [],
      hub_result: null,
      command_preamble: null,
      retry_count: 0
    };
    harness.lifecycleStore.save(state);
    harness.spawn
      .mockResolvedValueOnce({ threadId: "codex_40" })
      .mockResolvedValueOnce({ threadId: "validator-thread-fresh" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-fresh",
      status: "success",
      runState: "completed",
      content: '{"score":0.91,"feedback":"accepted"}',
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "passed",
      score: 0.91
    });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "validator-thread-fresh"
    }));
    expect(harness.kill).toHaveBeenCalledWith("codex_40");
    expect(harness.lifecycleStore.load().workers["N-02"]?.validation?.history[0]?.validator_thread_id)
      .toBe("validator-thread-fresh");
  });

  it("kills the retained worker thread after validation passes when kill policy allows success cleanup", async () => {
    const harness = await createHarness({ killPolicy: "on_success" });
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-pass" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-pass",
      status: "success",
      runState: "completed",
      content: '{"score":0.91,"feedback":"accepted"}',
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "passed",
      score: 0.91
    });
    expect(harness.kill).toHaveBeenCalledWith("validator-thread-pass");
    expect(harness.kill).toHaveBeenCalledWith("worker-thread-n02");
  });

  it("fails when a below-threshold result reaches the max validation cycle", async () => {
    const harness = await createHarness({ killPolicy: "always" });
    const state = harness.lifecycleStore.load();
    state.workers["N-02"]!.validation = {
      current_cycle: 2,
      max_fix_cycles: 3,
      validator_thread_id: null,
      last_score: 0.62,
      last_feedback: "Previous cycle feedback",
      history: [
        {
          cycle: 1,
          score: 0.66,
          feedback: "Cycle 1 feedback",
          validator_thread_id: "validator-thread-1",
          timestamp: "2026-04-27T00:11:00.000Z"
        },
        {
          cycle: 2,
          score: 0.62,
          feedback: "Previous cycle feedback",
          validator_thread_id: "validator-thread-2",
          timestamp: "2026-04-27T00:12:00.000Z"
        }
      ]
    };
    harness.lifecycleStore.save(state);
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-3" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-3",
      status: "success",
      runState: "completed",
      content: '{"score":0.65,"feedback":"Still below threshold."}',
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "failed",
      score: 0.65,
      reason: "max validation cycles exhausted (3)"
    });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("failed");
    expect(worker?.validation?.current_cycle).toBe(3);
    expect(worker?.validation?.history[2]).toMatchObject({
      cycle: 3,
      score: 0.65,
      feedback: "Still below threshold.",
      validator_thread_id: "validator-thread-3"
    });
    expect(harness.kill).toHaveBeenCalledWith("validator-thread-3");
    expect(harness.kill).toHaveBeenCalledWith("worker-thread-n02");
  });

  describe("feedback delivery transport-class rejection", () => {
    async function buildFixRequestedHarness() {
      const harness = await createHarness();
      const state = harness.lifecycleStore.load();
      state.workers["N-02"]!.status = "fix_requested";
      state.workers["N-02"]!.validation = {
        current_cycle: 1,
        max_fix_cycles: 3,
        validator_thread_id: "validator-thread-cycle-1",
        last_score: 0.5,
        last_feedback: "Fix the missing symbol map.",
        history: [
          {
            cycle: 1,
            score: 0.5,
            feedback: "Fix the missing symbol map.",
            validator_thread_id: "validator-thread-cycle-1",
            timestamp: "2026-04-27T00:11:00.000Z"
          }
        ]
      };
      harness.lifecycleStore.save(state);
      return harness;
    }

    it("returns transport_stall (not delivery_error) when meridianApi.run rejects with hub-overload language", async () => {
      const harness = await buildFixRequestedHarness();
      harness.run.mockRejectedValueOnce(
        new Error("run failed: Request timed out — the hub may be overloaded.")
      );

      const outcome = await deliverValidatorFeedback(harness.deps, "N-02");

      expect(outcome).toEqual({
        delivered: false,
        reason: "transport_stall",
        error: "run failed: Request timed out — the hub may be overloaded."
      });
    });

    it("preserves worker thread id and validator cycle history on transport-class failure (so the next tick can retry delivery)", async () => {
      const harness = await buildFixRequestedHarness();
      harness.run.mockRejectedValueOnce(new Error("fetch failed"));

      await deliverValidatorFeedback(harness.deps, "N-02");

      const worker = harness.lifecycleStore.load().workers["N-02"];
      // Worker stays in fix_requested so the next continue-dispatcher tick
      // attempts delivery again instead of falling through to launch path.
      expect(worker?.status).toBe("fix_requested");
      // Worker thread id must NOT be cleared — the live codex thread is most
      // likely still alive (only the request-side promise rejected), and
      // clearing it would needlessly spawn a fresh worker.
      expect(worker?.thread_id).toBe("worker-thread-n02");
      // Validator cycle-1 evidence stays intact for the retry.
      expect(worker?.validation?.last_feedback).toBe("Fix the missing symbol map.");
      expect(worker?.validation?.current_cycle).toBe(1);
      expect(worker?.validation?.history).toHaveLength(1);
    });

    it("logs validator_feedback_transport_stall (not validator_feedback_error) for transport-class rejections", async () => {
      const harness = await buildFixRequestedHarness();
      harness.run.mockRejectedValueOnce(new Error("ETIMEDOUT"));

      await deliverValidatorFeedback(harness.deps, "N-02");

      const warn = harness.deps.log.warn as ReturnType<typeof vi.fn>;
      const transportStallCall = warn.mock.calls.find(
        ([, meta]) => meta && (meta as { event?: string }).event === "validator_feedback_transport_stall"
      );
      expect(transportStallCall).toBeDefined();
      const errorCall = warn.mock.calls.find(
        ([, meta]) => meta && (meta as { event?: string }).event === "validator_feedback_error"
      );
      expect(errorCall).toBeUndefined();
    });

    it("still returns delivery_error for non-transport feedback delivery failures (preserves relaunch path for genuinely dead threads)", async () => {
      const harness = await buildFixRequestedHarness();
      harness.run.mockRejectedValueOnce(new Error("worker thread not found: codex_zz"));

      const outcome = await deliverValidatorFeedback(harness.deps, "N-02");

      expect(outcome).toEqual({
        delivered: false,
        reason: "delivery_error",
        error: "worker thread not found: codex_zz"
      });
      const warn = harness.deps.log.warn as ReturnType<typeof vi.fn>;
      const errorCall = warn.mock.calls.find(
        ([, meta]) => meta && (meta as { event?: string }).event === "validator_feedback_error"
      );
      expect(errorCall).toBeDefined();
    });
  });

  it("returns completed rework to awaiting validation after feedback delivery", async () => {
    const harness = await createHarness();
    const state = harness.lifecycleStore.load();
    state.workers["N-02"]!.status = "fix_requested";
    state.workers["N-02"]!.validation = {
      current_cycle: 1,
      max_fix_cycles: 3,
      validator_thread_id: null,
      last_score: 0.62,
      last_feedback: "Fix the missing symbol map.",
      history: [
        {
          cycle: 1,
          score: 0.62,
          feedback: "Fix the missing symbol map.",
          validator_thread_id: "validator-thread-1",
          timestamp: "2026-04-27T00:11:00.000Z"
        }
      ]
    };
    harness.lifecycleStore.save(state);
    harness.run.mockResolvedValueOnce({
      threadId: "worker-thread-n02",
      status: "success",
      runState: "completed",
      content: "Rework complete.",
      raw: {}
    });

    await expect(deliverValidatorFeedback(harness.deps, "N-02")).resolves.toEqual({ delivered: true });

    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("awaiting_validation");
    expect(harness.run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "worker-thread-n02",
      content: expect.stringContaining("Fix the missing symbol map.")
    }));
  });

  it("transitions to validated when the validator marker outcome is pass", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-marker-pass" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-marker-pass",
      status: "success",
      runState: "completed",
      content: [
        "Looks good overall.",
        "",
        "<<<MERIDIAN-STATUS>>>",
        "role: validator",
        "worker_id: N-02",
        "outcome: pass",
        "cycle: 1",
        "score: 0.95",
        "feedback: |",
        "  All requirements met.",
        "<<<END>>>"
      ].join("\n"),
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({ status: "passed", score: 0.95 });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("completed");
    expect(worker?.validation?.history[0]).toMatchObject({
      score: 0.95,
      feedback: "All requirements met."
    });
  });

  it("transitions to fix_requested when the validator marker outcome is fix_requested below max cycles", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-marker-fix" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-marker-fix",
      status: "success",
      runState: "completed",
      content: [
        "<<<MERIDIAN-STATUS>>>",
        "role: validator",
        "worker_id: N-02",
        "outcome: fix_requested",
        "score: 0.6",
        "feedback: |",
        "  Add tests for the error path.",
        "<<<END>>>"
      ].join("\n"),
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "fix_requested",
      score: 0.6,
      cycle: 1,
      maxCycles: 3
    });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("fix_requested");
    expect(worker?.validation?.history[0]).toMatchObject({
      score: 0.6,
      feedback: "Add tests for the error path."
    });
  });

  it("fails when the validator marker outcome is fix_requested at the max validation cycle", async () => {
    const harness = await createHarness({ killPolicy: "always" });
    const state = harness.lifecycleStore.load();
    state.workers["N-02"]!.validation = {
      current_cycle: 2,
      max_fix_cycles: 3,
      validator_thread_id: null,
      last_score: 0.62,
      last_feedback: "Previous cycle feedback",
      history: [
        {
          cycle: 1,
          score: 0.66,
          feedback: "Cycle 1 feedback",
          validator_thread_id: "validator-thread-1",
          timestamp: "2026-04-27T00:11:00.000Z"
        },
        {
          cycle: 2,
          score: 0.62,
          feedback: "Cycle 2 feedback",
          validator_thread_id: "validator-thread-2",
          timestamp: "2026-04-27T00:12:00.000Z"
        }
      ]
    };
    harness.lifecycleStore.save(state);
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-marker-max" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-marker-max",
      status: "success",
      runState: "completed",
      content: [
        "<<<MERIDIAN-STATUS>>>",
        "role: validator",
        "worker_id: N-02",
        "outcome: fix_requested",
        "score: 0.65",
        "feedback: |",
        "  Still incomplete.",
        "<<<END>>>"
      ].join("\n"),
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "failed",
      score: 0.65,
      reason: "max validation cycles exhausted (3)"
    });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("failed");
    expect(harness.kill).toHaveBeenCalledWith("worker-thread-n02");
  });

  it("fails immediately when the validator marker outcome is fail, even at cycle 1 of N", async () => {
    const harness = await createHarness({ killPolicy: "always" });
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-marker-fail" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-marker-fail",
      status: "success",
      runState: "completed",
      content: [
        "<<<MERIDIAN-STATUS>>>",
        "role: validator",
        "worker_id: N-02",
        "outcome: fail",
        "score: 0.0",
        "feedback: |",
        "  Fundamentally wrong approach.",
        "<<<END>>>"
      ].join("\n"),
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({
      status: "failed",
      score: 0.0,
      reason: "validator returned fail outcome"
    });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("failed");
    expect(worker?.validation?.history[0]).toMatchObject({
      score: 0,
      feedback: "Fundamentally wrong approach."
    });
    expect(harness.kill).toHaveBeenCalledWith("worker-thread-n02");
  });

  it("falls through to the legacy JSON parser when no marker is emitted", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-legacy" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-legacy",
      status: "success",
      runState: "completed",
      content: '{"score":0.92,"feedback":"legacy ok"}',
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({ status: "passed", score: 0.92 });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.validation?.history[0]).toMatchObject({
      score: 0.92,
      feedback: "legacy ok"
    });
  });

  it("falls through to the legacy JSON parser and logs mismatch when marker worker_id mismatches", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-mismatch" });
    const mismatchContent = [
      '{"score":0.91,"feedback":"legacy still parses"}',
      "",
      "<<<MERIDIAN-STATUS>>>",
      "role: validator",
      "worker_id: N-99",
      "outcome: pass",
      "score: 1.0",
      "feedback: not for us",
      "<<<END>>>"
    ].join("\n");
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-mismatch",
      status: "success",
      runState: "completed",
      content: mismatchContent,
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({ status: "passed", score: 0.91 });
    expect(harness.deps.log.warn).toHaveBeenCalledWith(
      "Validator marker mismatch",
      expect.objectContaining({
        event: "validator_marker_mismatch",
        worker_id: "N-02",
        marker_worker_id: "N-99",
        content_length: mismatchContent.length
      })
    );
  });

  it("falls through to the legacy JSON parser and logs wrong-role when marker role is worker", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-wrong-role" });
    const wrongRoleContent = [
      '{"score":0.88,"feedback":"legacy fallback"}',
      "",
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-02",
      "outcome: complete",
      "<<<END>>>"
    ].join("\n");
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-wrong-role",
      status: "success",
      runState: "completed",
      content: wrongRoleContent,
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({ status: "passed", score: 0.88 });
    expect(harness.deps.log.warn).toHaveBeenCalledWith(
      "Validator marker wrong role",
      expect.objectContaining({
        event: "validator_marker_wrong_role",
        worker_id: "N-02",
        marker_role: "worker",
        content_length: wrongRoleContent.length
      })
    );
  });

  it("defaults the score to 1.0 when the marker outcome is pass without a score field", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-no-score" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-no-score",
      status: "success",
      runState: "completed",
      content: [
        "<<<MERIDIAN-STATUS>>>",
        "role: validator",
        "worker_id: N-02",
        "outcome: pass",
        "feedback: |",
        "  Looks great.",
        "<<<END>>>"
      ].join("\n"),
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({ status: "passed", score: 1.0 });
  });

  it("logs a score-defaulted info event when the pass marker omits score", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-defaulted-log" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-defaulted-log",
      status: "success",
      runState: "completed",
      content: [
        "<<<MERIDIAN-STATUS>>>",
        "role: validator",
        "worker_id: N-02",
        "outcome: pass",
        "feedback: |",
        "  No score supplied.",
        "<<<END>>>"
      ].join("\n"),
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({ status: "passed", score: 1.0 });
    expect(harness.deps.log.info).toHaveBeenCalledWith(
      "Validator marker score defaulted",
      expect.objectContaining({
        event: "validator_marker_score_defaulted",
        worker_id: "N-02",
        outcome: "pass",
        default_score: 1.0
      })
    );
  });

  it("ignores marker.cycle and records the orchestrator-computed cycle in lifecycle history", async () => {
    const harness = await createHarness();
    harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-cycle-ignored" });
    harness.run.mockResolvedValueOnce({
      threadId: "validator-thread-cycle-ignored",
      status: "success",
      runState: "completed",
      content: [
        "<<<MERIDIAN-STATUS>>>",
        "role: validator",
        "worker_id: N-02",
        "outcome: pass",
        "cycle: 99",
        "score: 0.95",
        "feedback: |",
        "  Marker cycle is informational only.",
        "<<<END>>>"
      ].join("\n"),
      raw: {}
    });

    const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

    expect(outcome).toEqual({ status: "passed", score: 0.95 });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.validation?.current_cycle).toBe(1);
    expect(worker?.validation?.history).toHaveLength(1);
    expect(worker?.validation?.history[0]?.cycle).toBe(1);
    expect(worker?.validation?.history[0]?.cycle).not.toBe(99);
  });

  describe("Phase A6: heuristic fallback gate", () => {
    it("runs the legacy JSON parser when no marker is present and the gate is ON (backwards-compat)", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: true });
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-a6-on" });
      harness.run.mockResolvedValueOnce({
        threadId: "validator-thread-a6-on",
        status: "success",
        runState: "completed",
        content: '{"score":0.85,"feedback":"looks fine"}',
        raw: {}
      });

      const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(outcome).toEqual({ status: "passed", score: 0.85 });
      const worker = harness.lifecycleStore.load().workers["N-02"];
      expect(worker?.status).toBe("completed");
    });

    it("returns error status without invoking the JSON parser when no marker is present and the gate is OFF", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: false });
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-a6-off" });
      harness.run.mockResolvedValueOnce({
        threadId: "validator-thread-a6-off",
        status: "success",
        runState: "completed",
        content: '{"score":0.85,"feedback":"would have parsed"}',
        raw: {}
      });

      const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(outcome).toEqual({
        status: "error",
        reason: "no marker; fallback disabled"
      });
      // Lifecycle cleanup must still run — validator slot must be cleared so
      // the worker is not stuck holding an orphaned validator thread.
      const worker = harness.lifecycleStore.load().workers["N-02"];
      expect(worker?.validation?.validator_thread_id).toBeNull();
    });

    it("trusts the validator marker even when the gate is OFF — marker still wins", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: false });
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-a6-marker" });
      harness.run.mockResolvedValueOnce({
        threadId: "validator-thread-a6-marker",
        status: "success",
        runState: "completed",
        content: [
          "All good.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: validator",
          "worker_id: N-02",
          "outcome: pass",
          "score: 0.95",
          "<<<END>>>"
        ].join("\n"),
        raw: {}
      });

      const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(outcome).toEqual({ status: "passed", score: 0.95 });
    });

    it("emits a validator_signal_source log indicating which path produced the decision", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: true });
      const info = harness.deps.log.info as ReturnType<typeof vi.fn>;
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-a6-log-marker" });
      harness.run.mockResolvedValueOnce({
        threadId: "validator-thread-a6-log-marker",
        status: "success",
        runState: "completed",
        content: [
          "Reviewed.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: validator",
          "worker_id: N-02",
          "outcome: pass",
          "score: 0.91",
          "<<<END>>>"
        ].join("\n"),
        raw: {}
      });

      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(info).toHaveBeenCalledWith("Validator signal source", {
        event: "validator_signal_source",
        worker_id: "N-02",
        signal_source: "marker",
        result: "pass"
      });
    });

    it("emits a validator_signal_source=heuristic log when the JSON fallback parser produces the decision", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: true });
      const info = harness.deps.log.info as ReturnType<typeof vi.fn>;
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-a6-log-heuristic" });
      harness.run.mockResolvedValueOnce({
        threadId: "validator-thread-a6-log-heuristic",
        status: "success",
        runState: "completed",
        content: '{"score":0.88,"feedback":"OK"}',
        raw: {}
      });

      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(info).toHaveBeenCalledWith("Validator signal source", {
        event: "validator_signal_source",
        worker_id: "N-02",
        signal_source: "heuristic",
        result: "scored"
      });
    });

    it("emits a validator_signal_source=none log when the gate is OFF and no marker is present", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: false });
      const info = harness.deps.log.info as ReturnType<typeof vi.fn>;
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-a6-log-none" });
      harness.run.mockResolvedValueOnce({
        threadId: "validator-thread-a6-log-none",
        status: "success",
        runState: "completed",
        content: '{"score":0.5,"feedback":"unused"}',
        raw: {}
      });

      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(info).toHaveBeenCalledWith("Validator signal source", {
        event: "validator_signal_source",
        worker_id: "N-02",
        signal_source: "none",
        result: "error"
      });
    });
  });

  describe("transport-class run rejection", () => {
    it("does NOT bump spawn_failure_count when meridianApi.run rejects with hub-overload language", async () => {
      const harness = await createHarness();
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-transport" });
      harness.run.mockRejectedValueOnce(
        new Error("run failed: Request timed out — the hub may be overloaded.")
      );

      const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(outcome.status).toBe("error");
      const worker = harness.lifecycleStore.load().workers["N-02"];
      // Validator thread id is cleared so the next tick can re-spawn cleanly...
      expect(worker?.validation?.validator_thread_id).toBeNull();
      // ...but the spawn-failure backoff counter is NOT bumped — a hub-overload
      // run rejection is a transient transport error, not a real spawn failure.
      expect(worker?.validation?.spawn_failure_count ?? 0).toBe(0);
      expect(worker?.validation?.last_spawn_failure_at ?? null).toBeNull();
      // The validator thread is still killed (validator is ephemeral) but
      // counts as a successful kill, not a failed spawn.
      expect(harness.kill).toHaveBeenCalledWith("validator-thread-transport");
    });

    it("logs validator_run_transport_stall (not validator_run_error) for transport-class rejections", async () => {
      const harness = await createHarness();
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-stall" });
      harness.run.mockRejectedValueOnce(new Error("fetch failed"));

      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      const warn = harness.deps.log.warn as ReturnType<typeof vi.fn>;
      const transportStallCall = warn.mock.calls.find(
        ([, meta]) => meta && (meta as { event?: string }).event === "validator_run_transport_stall"
      );
      expect(transportStallCall).toBeDefined();
      const runErrorCall = warn.mock.calls.find(
        ([, meta]) => meta && (meta as { event?: string }).event === "validator_run_error"
      );
      expect(runErrorCall).toBeUndefined();
    });

    it("still bumps spawn_failure_count for non-transport run failures (preserves backoff for genuinely wedged transports)", async () => {
      const harness = await createHarness();
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-real-fail" });
      harness.run.mockRejectedValueOnce(new Error("validator agent crashed: protocol violation"));

      const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(outcome.status).toBe("error");
      const worker = harness.lifecycleStore.load().workers["N-02"];
      expect(worker?.validation?.validator_thread_id).toBeNull();
      expect(worker?.validation?.spawn_failure_count ?? 0).toBe(1);
      expect(worker?.validation?.last_spawn_failure_at ?? null).not.toBeNull();
    });

    it("three consecutive hub-overload rejections do NOT trip the validator backoff threshold", async () => {
      const harness = await createHarness();
      harness.spawn
        .mockResolvedValueOnce({ threadId: "validator-thread-t1" })
        .mockResolvedValueOnce({ threadId: "validator-thread-t2" })
        .mockResolvedValueOnce({ threadId: "validator-thread-t3" });
      harness.run
        .mockRejectedValueOnce(new Error("run failed: Request timed out — the hub may be overloaded."))
        .mockRejectedValueOnce(new Error("run failed: Request timed out — the hub may be overloaded."))
        .mockRejectedValueOnce(new Error("run failed: Request timed out — the hub may be overloaded."));

      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());
      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());
      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      const worker = harness.lifecycleStore.load().workers["N-02"];
      expect(worker?.validation?.spawn_failure_count ?? 0).toBe(0);
    });
  });

  describe("transport-class run rejection with live agentapi process", () => {
    // Closes the codex_06 → codex_09 / codex_03 → codex_07 spawn-storm gap:
    // when meridianApi.run rejects with hub-overload language but ps still
    // shows the agentapi process for the validator thread, the orchestrator
    // must preserve validator_thread_id (don't safeKill, don't clear) so the
    // next continue tick can re-probe liveness and recover the late verdict
    // from hub history once the live codex exits.
    it("preserves validator_thread_id and skips safeKill when ps shows the agentapi process is still alive", async () => {
      const harness = await createHarness();
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-live" });
      harness.run.mockRejectedValueOnce(
        new Error("run failed: Request timed out — the hub may be overloaded.")
      );
      const probe = vi
        .spyOn(activeToolProcess, "isAgentapiProcessAliveForThread")
        .mockReturnValueOnce(true);

      const outcome = await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      expect(outcome.status).toBe("error");
      expect(probe).toHaveBeenCalledWith("validator-thread-live");
      const worker = harness.lifecycleStore.load().workers["N-02"];
      // validator_thread_id MUST stay set so Phase 2's next-tick liveness
      // probe sees the same thread id and routes through the recovery path.
      expect(worker?.validation?.validator_thread_id).toBe("validator-thread-live");
      // safeKill must NOT fire — killing a live codex would defeat the
      // recovery (and create an orphan kill failure log).
      expect(harness.kill).not.toHaveBeenCalled();
      // Backoff counters must remain at zero: this is neither a spawn
      // failure nor a transport-stall that needs throttling, because the
      // live codex will deliver a verdict on its own timeline.
      expect(worker?.validation?.spawn_failure_count ?? 0).toBe(0);
      expect(worker?.validation?.last_spawn_failure_at ?? null).toBeNull();
    });

    it("logs validator_run_transport_stall_codex_alive (not validator_run_transport_stall) when ps shows the agentapi process alive", async () => {
      const harness = await createHarness();
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-live-2" });
      harness.run.mockRejectedValueOnce(new Error("fetch failed"));
      vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread").mockReturnValueOnce(true);

      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      const warn = harness.deps.log.warn as ReturnType<typeof vi.fn>;
      expect(
        warn.mock.calls.find(([, meta]) => meta && (meta as { event?: string }).event === "validator_run_transport_stall_codex_alive")
      ).toBeDefined();
      expect(
        warn.mock.calls.find(([, meta]) => meta && (meta as { event?: string }).event === "validator_run_transport_stall")
      ).toBeUndefined();
    });

    it("falls through to existing clear+safeKill path when ps shows no live agentapi process", async () => {
      const harness = await createHarness();
      harness.spawn.mockResolvedValueOnce({ threadId: "validator-thread-dead" });
      harness.run.mockRejectedValueOnce(
        new Error("run failed: Request timed out — the hub may be overloaded.")
      );
      vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread").mockReturnValueOnce(false);

      await executeValidationCycle(harness.deps, "N-02", buildPlanRow());

      const worker = harness.lifecycleStore.load().workers["N-02"];
      expect(worker?.validation?.validator_thread_id).toBeNull();
      expect(harness.kill).toHaveBeenCalledWith("validator-thread-dead");
    });
  });
});

describe("applyValidatorVerdictFromContent", () => {
  // Hole-2 recovery: when the dispatcher fetches the validator's reply from
  // hub conversation history (after the orchestrator's meridianApi.run
  // rejected mid-flight but the codex CLI subsequently exited cleanly), the
  // verdict-application path must produce the same lifecycle outcome it
  // would have produced inline.
  it("applies a marker pass verdict and records cycle history (recovery path)", async () => {
    const harness = await createHarness();
    const markerContent = [
      "<<<MERIDIAN-STATUS>>>",
      "role: validator",
      `worker_id: N-02`,
      "outcome: pass",
      "score: 0.95",
      "feedback: looks great",
      "<<<END>>>"
    ].join("\n");

    const outcome = await applyValidatorVerdictFromContent(
      harness.deps,
      "N-02",
      "validator-thread-recovered",
      markerContent,
      buildPlanRow()
    );

    expect(outcome).toEqual({ status: "passed", score: 0.95 });
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("completed");
    expect(worker?.validation?.history[0]).toMatchObject({
      validator_thread_id: "validator-thread-recovered",
      score: 0.95
    });
  });

  it("returns null when the worker is no longer in awaiting_validation (idempotent against a concurrent transition)", async () => {
    const harness = await createHarness();
    harness.lifecycleStore.setWorkerStatus("N-02", "completed", "validation_passed");

    const outcome = await applyValidatorVerdictFromContent(
      harness.deps,
      "N-02",
      "validator-thread-late",
      '{"score":0.9,"feedback":"x"}',
      buildPlanRow()
    );

    expect(outcome).toBeNull();
  });
});

describe("buildDefaultValidatorPrompt", () => {
  it("renders the marker reply protocol with role and outcome enum", () => {
    const prompt = buildDefaultValidatorPrompt({
      workerId: "N-02",
      taskBranch: "task/n-02",
      baseBranch: "main",
      taskspecPath: null,
      dispatchPlanPath: "/tmp/plan.md",
      cycle: 1,
      maxFixCycles: 3,
      previousFeedback: null
    });

    expect(prompt).toContain("<<<MERIDIAN-STATUS>>>");
    expect(prompt).toContain("role: validator");
    expect(prompt).toContain("outcome: pass | fix_requested | fail");
  });

  it("does not embed a JSON output-format code-block instruction", () => {
    const scorePrompt = buildDefaultValidatorPrompt({
      workerId: "N-02",
      taskBranch: "task/n-02",
      baseBranch: "main",
      taskspecPath: null,
      dispatchPlanPath: "/tmp/plan.md",
      cycle: 1,
      maxFixCycles: 3,
      previousFeedback: null,
      thresholdType: "score"
    });
    const binaryPrompt = buildDefaultValidatorPrompt({
      workerId: "N-02",
      taskBranch: "task/n-02",
      baseBranch: "main",
      taskspecPath: null,
      dispatchPlanPath: "/tmp/plan.md",
      cycle: 1,
      maxFixCycles: 3,
      previousFeedback: null,
      thresholdType: "binary"
    });

    for (const prompt of [scorePrompt, binaryPrompt]) {
      expect(prompt).not.toContain("```json");
      expect(prompt).not.toMatch(/end your response with exactly one JSON block/i);
    }
  });
});

describe("parseValidatorOutputFromJson", () => {
  it("parses binary positive verdicts from validator JSON (legacy fallback)", () => {
    expect(parseValidatorOutputFromJson('```json\n{"positive":true,"feedback":"accepted"}\n```')).toEqual({
      score: 1,
      feedback: "accepted",
      positive: true
    });
  });
});

async function createHarness(options: {
  killPolicy?: "always" | "on_success" | "never";
  validatorConfig?: Partial<ValidatorConfig>;
  fallbackHeuristicsEnabled?: boolean;
  buildPrompt?: ValidatorOrchestratorDeps["buildPrompt"];
} = {}): Promise<{
  lifecycleStore: LifecycleStore;
  deps: ValidatorOrchestratorDeps;
  spawn: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-validator-"));
  tempDirectories.add(directory);
  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  const sidecarPath = path.join(directory, "dispatch_threads.json");
  await fs.writeFile(dispatchPlanPath, [
    "# Dispatch Plan",
    "",
    "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
    "|--------|-------|--------|------|-------|------------|----------------|-------|",
    "| ✅ | 1 | N-02 | Build Complete | CODEX | — | TaskSpec | awaiting validation |"
  ].join("\n"), "utf8");

  const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath });
  lifecycleStore.save({
    version: 2,
    dispatcher: {
      thread_id: "dispatcher-thread-123",
      started_at: "2026-04-27T00:00:00.000Z",
      status: "running"
    },
    workers: {
      "N-02": {
        thread_id: "worker-thread-n02",
        trace_id: null,
        started_at: "2026-04-27T00:00:00.000Z",
        last_seen_at: "2026-04-27T00:10:00.000Z",
        status: "awaiting_validation",
        expected_outputs: [],
        hub_result: null,
        command_preamble: null,
        retry_count: 0,
        validation: {
          current_cycle: 0,
          max_fix_cycles: 3,
          validator_thread_id: null,
          last_score: null,
          last_feedback: null,
          history: []
        }
      }
    },
    last_reconciled_at: null
  });

  const spawn = vi.fn();
  const run = vi.fn().mockResolvedValue({
    threadId: "validator-thread-fresh",
    status: "success",
    runState: "completed",
    content: '{"score":0.9,"feedback":"looks good"}',
    raw: {}
  });
  const kill = vi.fn().mockResolvedValue({
    threadId: "validator-thread-fresh",
    status: "killed",
    raw: {}
  });
  const meridianApi: MeridianApiClient = {
    spawn,
    run,
    kill,
    listCredentials: vi.fn().mockResolvedValue([])
  };

  return {
    lifecycleStore,
    deps: {
      lifecycleStore,
      validatorConfig: {
        enabled: true,
        agent_type: "codex",
        mode: "bridge",
        auto_approve: false,
        pass_threshold: 0.7,
        max_fix_cycles: 3,
        base_branch: "main",
        ...options.validatorConfig,
        threshold_type: options.validatorConfig?.threshold_type ?? "score"
      },
      meridianApi,
      killPolicy: options.killPolicy ?? "never",
      spawnDir: directory,
      dispatchPlanPath,
      taskspecPath: null,
      ...(options.buildPrompt ? { buildPrompt: options.buildPrompt } : {}),
      ...(options.fallbackHeuristicsEnabled === undefined
        ? {}
        : { fallbackHeuristicsEnabled: options.fallbackHeuristicsEnabled }),
      log: {
        info: vi.fn(),
        warn: vi.fn()
      }
    },
    spawn,
    run,
    kill
  };
}

function buildPlanRow(): DispatchContinuationPlanRow {
  return {
    status: "✅",
    batch: "1",
    worker: "N-02",
    model: "CODEX",
    depends_on: "—",
    notes: "awaiting validation"
  };
}
