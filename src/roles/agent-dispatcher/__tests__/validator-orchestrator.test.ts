import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../lifecycle-store";
import {
  deliverValidatorFeedback,
  executeValidationCycle,
  parseValidatorOutput,
  type ValidatorOrchestratorDeps
} from "../validator-orchestrator";
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
    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("completed");
    expect(worker?.validation?.history[0]?.validator_thread_id).toBe("validator-thread-fresh");
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

    await expect(deliverValidatorFeedback(harness.deps, "N-02")).resolves.toBe(true);

    const worker = harness.lifecycleStore.load().workers["N-02"];
    expect(worker?.status).toBe("awaiting_validation");
    expect(harness.run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "worker-thread-n02",
      content: expect.stringContaining("Fix the missing symbol map.")
    }));
  });
});

describe("parseValidatorOutput", () => {
  it("parses binary positive verdicts from validator JSON", () => {
    expect(parseValidatorOutput('```json\n{"positive":true,"feedback":"accepted"}\n```')).toEqual({
      score: 1,
      feedback: "accepted",
      positive: true
    });
  });
});

async function createHarness(options: {
  killPolicy?: "always" | "on_success" | "never";
  validatorConfig?: Partial<ValidatorConfig>;
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
    kill
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
