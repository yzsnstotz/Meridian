import { describe, expect, it } from "vitest";

import type {
  DispatchThreadStateV2,
  DispatchWorkerState,
  LifecycleStatus,
  PmResolverLifecycleState,
  PmResolverLifecycleStatus
} from "../../../types";
import {
  buildEmptyDispatchThreadStateV2,
  PM_RESOLVER_NO_PROGRESS_STALE_MS
} from "../lifecycle-store";
import { isSlotOccupyingWorkerStatus, resolveOccupiedParallelSlots } from "../slot-occupancy";

const NOW = "2026-04-03T14:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function buildWorker(status: LifecycleStatus, overrides: Partial<DispatchWorkerState> = {}): DispatchWorkerState {
  return {
    thread_id: "w-thread",
    trace_id: null,
    started_at: "2026-04-03T13:00:00.000Z",
    last_seen_at: "2026-04-03T13:30:00.000Z",
    status,
    expected_outputs: [],
    hub_result: null,
    command_preamble: null,
    retry_count: 0,
    ...overrides
  };
}

function buildPmResolver(
  threadId: string,
  status: PmResolverLifecycleStatus,
  overrides: Partial<PmResolverLifecycleState> = {}
): PmResolverLifecycleState {
  return {
    thread_id: threadId,
    status,
    started_at: "2026-04-03T13:55:00.000Z",
    last_seen_at: "2026-04-03T13:59:00.000Z",
    agent_type: "codex",
    model_id: "gpt-5.5 xhigh",
    mode: "bridge",
    auto_approve: true,
    issue: {
      status: "manual_intervention_required",
      worker_id: "W-BLOCKED",
      message: "manual intervention required",
      error: null,
      source: "dispatcher"
    },
    result: null,
    error: null,
    transport_error: null,
    marker_outcome: null,
    marker_pm_action: null,
    ...overrides
  };
}

function buildState(
  workers: Record<string, DispatchWorkerState>,
  pmResolvers: PmResolverLifecycleState[] = []
): DispatchThreadStateV2 {
  return {
    ...buildEmptyDispatchThreadStateV2(),
    dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
    workers,
    pm_resolvers: pmResolvers
  };
}

describe("isSlotOccupyingWorkerStatus", () => {
  it("counts running, awaiting_validation and fix_requested", () => {
    expect(isSlotOccupyingWorkerStatus("running")).toBe(true);
    // A validator agent is scoring this row on its own Hub thread.
    expect(isSlotOccupyingWorkerStatus("awaiting_validation")).toBe(true);
    // Reserved: flips straight back to `running` on validator_feedback_delivered.
    expect(isSlotOccupyingWorkerStatus("fix_requested")).toBe(true);
  });

  it("does not count pending, terminal, or blocked rows", () => {
    for (const status of ["pending", "completed", "failed", "abandoned", "skipped"] as LifecycleStatus[]) {
      expect(isSlotOccupyingWorkerStatus(status)).toBe(false);
    }
    // `blocked` is excluded ON PURPOSE — a wedged row must not burn a slot for
    // hours; its PM resolver is what gets counted instead.
    expect(isSlotOccupyingWorkerStatus("blocked")).toBe(false);
  });
});

describe("resolveOccupiedParallelSlots", () => {
  it("counts a validator-held row that the narrow running count reports as zero", () => {
    const occupancy = resolveOccupiedParallelSlots(
      buildState({
        "BATCH-7-GATE": buildWorker("awaiting_validation", {
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: "validator-thread-gate",
            last_score: null,
            last_feedback: null,
            history: []
          }
        }),
        "C-02": buildWorker("pending")
      }),
      NOW_MS
    );

    expect(occupancy.workerIds).toEqual(["BATCH-7-GATE"]);
    expect(occupancy.count).toBe(1);
  });

  it("counts a fix_requested row whose thread was cleared for relaunch", () => {
    // The row is one continueDispatcher tick away from `running` again, so the
    // slot is spoken for even though no thread is recorded right now.
    const occupancy = resolveOccupiedParallelSlots(
      buildState({
        "C-04a": buildWorker("fix_requested", { thread_id: "" })
      }),
      NOW_MS
    );

    expect(occupancy.workerIds).toEqual(["C-04a"]);
    expect(occupancy.count).toBe(1);
  });

  it("counts an active PM resolver thread and skips the blocked worker it owns", () => {
    const occupancy = resolveOccupiedParallelSlots(
      buildState(
        { "W-BLOCKED": buildWorker("blocked") },
        [buildPmResolver("pm-thread-01", "running")]
      ),
      NOW_MS
    );

    // One slot, not two: the PM resolver thread is the live Hub lane here.
    expect(occupancy.workerIds).toEqual([]);
    expect(occupancy.pmResolverThreadIds).toEqual(["pm-thread-01"]);
    expect(occupancy.count).toBe(1);
  });

  it("ignores terminal PM resolvers and ones the watchdog is about to write off", () => {
    const occupancy = resolveOccupiedParallelSlots(
      buildState({}, [
        buildPmResolver("pm-done", "completed"),
        buildPmResolver("pm-failed", "failed"),
        buildPmResolver("pm-stale", "running", {
          started_at: new Date(NOW_MS - PM_RESOLVER_NO_PROGRESS_STALE_MS - 60_000).toISOString(),
          last_seen_at: new Date(NOW_MS - PM_RESOLVER_NO_PROGRESS_STALE_MS - 60_000).toISOString()
        })
      ]),
      NOW_MS
    );

    expect(occupancy.count).toBe(0);
  });

  it("never counts the synthetic DISPATCHER row", () => {
    // It is `running` for most of a healthy round; counting it would silently
    // cost every plan one slot.
    const occupancy = resolveOccupiedParallelSlots(
      buildState({
        DISPATCHER: buildWorker("running", { thread_id: "d-01" }),
        "W-01": buildWorker("running")
      }),
      NOW_MS
    );

    expect(occupancy.workerIds).toEqual(["W-01"]);
    expect(occupancy.count).toBe(1);
  });

  it("sums workers and PM resolvers into the number compared against max_concurrency", () => {
    const occupancy = resolveOccupiedParallelSlots(
      buildState(
        {
          "W-01": buildWorker("running"),
          "BATCH-7-GATE": buildWorker("awaiting_validation"),
          "C-04a": buildWorker("fix_requested"),
          "W-BLOCKED": buildWorker("blocked"),
          "C-02": buildWorker("pending"),
          "W-00": buildWorker("completed")
        },
        [buildPmResolver("pm-thread-01", "running")]
      ),
      NOW_MS
    );

    expect(new Set(occupancy.workerIds)).toEqual(new Set(["W-01", "BATCH-7-GATE", "C-04a"]));
    expect(occupancy.pmResolverThreadIds).toEqual(["pm-thread-01"]);
    expect(occupancy.count).toBe(4);
  });
});
