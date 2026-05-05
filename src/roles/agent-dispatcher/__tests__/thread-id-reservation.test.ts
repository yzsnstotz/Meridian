import { describe, expect, it } from "vitest";

import type { DispatchThreadStateV2, DispatchWorkerState, LifecycleStatus } from "../../../types";
import {
  isActiveThreadReservationStatus,
  isThreadIdKnownInLifecycleState,
  isThreadIdReservedInLifecycleState
} from "../thread-id-reservation";

describe("isActiveThreadReservationStatus", () => {
  it.each<[LifecycleStatus, boolean]>([
    ["running", true],
    ["blocked", true],
    ["awaiting_validation", true],
    ["fix_requested", true],
    ["pending", false],
    ["completed", false],
    ["failed", false],
    ["abandoned", false],
    ["skipped", false]
  ])("status %s reserves: %s", (status, expected) => {
    expect(isActiveThreadReservationStatus(status)).toBe(expected);
  });
});

describe("isThreadIdReservedInLifecycleState", () => {
  it("does not reserve thread_ids of completed workers", () => {
    const state = buildState({
      dispatcher: { thread_id: "codex_dispatcher", status: "running" },
      workers: {
        "N-01": worker({ thread_id: "codex_03", status: "completed" }),
        "N-02": worker({ thread_id: "codex_05", status: "failed" }),
        "N-03": worker({ thread_id: "codex_07", status: "abandoned" }),
        "N-04": worker({ thread_id: "codex_09", status: "skipped" })
      }
    });

    expect(isThreadIdReservedInLifecycleState(state, "codex_03")).toBe(false);
    expect(isThreadIdReservedInLifecycleState(state, "codex_05")).toBe(false);
    expect(isThreadIdReservedInLifecycleState(state, "codex_07")).toBe(false);
    expect(isThreadIdReservedInLifecycleState(state, "codex_09")).toBe(false);
  });

  it("reserves thread_ids of running, blocked, awaiting_validation, and fix_requested workers", () => {
    const state = buildState({
      workers: {
        "W-RUN": worker({ thread_id: "codex_10", status: "running" }),
        "W-BLOCK": worker({ thread_id: "codex_11", status: "blocked" }),
        "W-AV": worker({ thread_id: "codex_12", status: "awaiting_validation" }),
        "W-FIX": worker({ thread_id: "codex_13", status: "fix_requested" })
      }
    });

    expect(isThreadIdReservedInLifecycleState(state, "codex_10")).toBe(true);
    expect(isThreadIdReservedInLifecycleState(state, "codex_11")).toBe(true);
    expect(isThreadIdReservedInLifecycleState(state, "codex_12")).toBe(true);
    expect(isThreadIdReservedInLifecycleState(state, "codex_13")).toBe(true);
  });

  it("only reserves the dispatcher thread_id when its status is active", () => {
    const completedDispatcher = buildState({
      dispatcher: { thread_id: "codex_disp", status: "completed" }
    });
    const runningDispatcher = buildState({
      dispatcher: { thread_id: "codex_disp", status: "running" }
    });

    expect(isThreadIdReservedInLifecycleState(completedDispatcher, "codex_disp")).toBe(false);
    expect(isThreadIdReservedInLifecycleState(runningDispatcher, "codex_disp")).toBe(true);
  });

  it("only reserves validator_thread_id when its parent worker is active", () => {
    const completedWorkerWithValidator = buildState({
      workers: {
        "W-DONE": worker({
          thread_id: "codex_w",
          status: "completed",
          validation: validatorState({ validator_thread_id: "codex_v" })
        })
      }
    });
    const activeWorkerWithValidator = buildState({
      workers: {
        "W-AV": worker({
          thread_id: "codex_w",
          status: "awaiting_validation",
          validation: validatorState({ validator_thread_id: "codex_v" })
        })
      }
    });

    expect(isThreadIdReservedInLifecycleState(completedWorkerWithValidator, "codex_v")).toBe(false);
    expect(isThreadIdReservedInLifecycleState(activeWorkerWithValidator, "codex_v")).toBe(true);
  });

  it("ignores empty candidate thread ids", () => {
    const state = buildState({
      workers: {
        "W-RUN": worker({ thread_id: "codex_10", status: "running" })
      }
    });

    expect(isThreadIdReservedInLifecycleState(state, "")).toBe(false);
    expect(isThreadIdReservedInLifecycleState(state, "   ")).toBe(false);
  });
});

describe("isThreadIdKnownInLifecycleState", () => {
  it("treats terminal worker and validator history thread ids as known", () => {
    const state = buildState({
      dispatcher: { thread_id: "codex_dispatcher", status: "completed" },
      workers: {
        "W-DONE": worker({
          thread_id: "codex_worker_done",
          status: "completed",
          validation: {
            ...validatorState({ validator_thread_id: "codex_validator_current" }),
            history: [
              {
                cycle: 1,
                score: 1,
                feedback: "accepted",
                validator_thread_id: "codex_validator_history",
                timestamp: "2026-05-05T00:00:00.000Z"
              }
            ]
          }
        })
      }
    });

    expect(isThreadIdKnownInLifecycleState(state, "codex_dispatcher")).toBe(true);
    expect(isThreadIdKnownInLifecycleState(state, "codex_worker_done")).toBe(true);
    expect(isThreadIdKnownInLifecycleState(state, "codex_validator_current")).toBe(true);
    expect(isThreadIdKnownInLifecycleState(state, "codex_validator_history")).toBe(true);
    expect(isThreadIdKnownInLifecycleState(state, "codex_new")).toBe(false);
  });
});

function buildState(overrides: {
  dispatcher?: Partial<DispatchThreadStateV2["dispatcher"]>;
  workers?: DispatchThreadStateV2["workers"];
}): DispatchThreadStateV2 {
  return {
    version: 2,
    dispatcher: {
      thread_id: null,
      started_at: null,
      status: "pending",
      ...overrides.dispatcher
    },
    workers: overrides.workers ?? {},
    last_reconciled_at: null
  };
}

function worker(overrides: Partial<DispatchWorkerState> & {
  thread_id: string;
  status: LifecycleStatus;
}): DispatchWorkerState {
  return {
    thread_id: overrides.thread_id,
    trace_id: null,
    started_at: "2026-05-04T00:00:00.000Z",
    last_seen_at: "2026-05-04T00:00:00.000Z",
    status: overrides.status,
    expected_outputs: [],
    hub_result: null,
    command_preamble: null,
    retry_count: 0,
    validation: overrides.validation
  };
}

function validatorState(overrides: { validator_thread_id: string }) {
  return {
    current_cycle: 1,
    max_fix_cycles: 3,
    validator_thread_id: overrides.validator_thread_id,
    last_score: null,
    last_feedback: null,
    history: []
  };
}
