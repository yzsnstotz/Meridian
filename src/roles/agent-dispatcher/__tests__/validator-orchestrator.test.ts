import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../lifecycle-store";
import {
  executeValidationCycle,
  type ValidatorOrchestratorDeps
} from "../validator-orchestrator";
import type { MeridianApiClient } from "../meridian-api-client";
import type { DispatchContinuationPlanRow } from "../service-continuation";

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
});

async function createHarness(): Promise<{
  lifecycleStore: LifecycleStore;
  deps: ValidatorOrchestratorDeps;
  spawn: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
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
  const meridianApi: MeridianApiClient = {
    spawn,
    run,
    kill: vi.fn().mockResolvedValue({
      threadId: "validator-thread-fresh",
      status: "killed",
      raw: {}
    })
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
        base_branch: "main"
      },
      meridianApi,
      spawnDir: directory,
      dispatchPlanPath,
      taskspecPath: null,
      log: {
        info: vi.fn(),
        warn: vi.fn()
      }
    },
    spawn,
    run
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
