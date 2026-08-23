import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  DispatchThreadStateV2,
  DispatchWorkerState,
  LifecycleStatus,
  PmResolverLifecycleState,
  PmResolverLifecycleStatus
} from "../../../types";
import { LifecycleStore } from "../lifecycle-store";
import {
  isActivePmResolverReservationStatus,
  isActiveThreadReservationStatus,
  isThreadIdKnownInLifecycleState,
  isThreadIdReservedAcrossOtherDispatchPlans,
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

describe("isActivePmResolverReservationStatus", () => {
  it.each<[PmResolverLifecycleStatus, boolean]>([
    ["running", true],
    ["completed", false],
    ["failed", false]
  ])("status %s reserves: %s", (status, expected) => {
    expect(isActivePmResolverReservationStatus(status)).toBe(expected);
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

  it("reserves a running PM resolver thread id but not terminal ones", () => {
    const state = buildState({
      pm_resolvers: [
        pmResolver({ thread_id: "codex_pm_running", status: "running" }),
        pmResolver({ thread_id: "codex_pm_done", status: "completed" }),
        pmResolver({ thread_id: "codex_pm_failed", status: "failed" })
      ]
    });

    expect(isThreadIdReservedInLifecycleState(state, "codex_pm_running")).toBe(true);
    expect(isThreadIdReservedInLifecycleState(state, "codex_pm_done")).toBe(false);
    expect(isThreadIdReservedInLifecycleState(state, "codex_pm_failed")).toBe(false);
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
  pm_resolvers?: PmResolverLifecycleState[];
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
    pm_resolvers: overrides.pm_resolvers,
    last_reconciled_at: null
  };
}

function pmResolver(overrides: {
  thread_id: string;
  status: PmResolverLifecycleStatus;
}): PmResolverLifecycleState {
  return {
    thread_id: overrides.thread_id,
    status: overrides.status,
    started_at: "2026-05-04T00:00:00.000Z",
    last_seen_at: "2026-05-04T00:00:00.000Z",
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

describe("isThreadIdReservedAcrossOtherDispatchPlans", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((dir) => fsPromises.rm(dir, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("returns true when another plan reserves the candidate id with status=running", async () => {
    const otherPlan = await writePlanState({
      dispatcher: { thread_id: "codex_01", status: "running" }
    });

    expect(isThreadIdReservedAcrossOtherDispatchPlans([otherPlan], "codex_01")).toBe(true);
  });

  it("returns false when the other plan's dispatcher is in a terminal status", async () => {
    const otherPlan = await writePlanState({
      dispatcher: { thread_id: "codex_01", status: "completed" }
    });

    expect(isThreadIdReservedAcrossOtherDispatchPlans([otherPlan], "codex_01")).toBe(false);
  });

  it("returns true when another plan's active worker pins the id", async () => {
    const otherPlan = await writePlanState({
      workers: {
        "W-01": worker({ thread_id: "codex_42", status: "running" })
      }
    });

    expect(isThreadIdReservedAcrossOtherDispatchPlans([otherPlan], "codex_42")).toBe(true);
  });

  it("returns true when another plan's running PM resolver pins the id (regression: BATCH-3-GATE codex_19 N-02 bleed)", async () => {
    // Models the agent-dispatcher-8eb13a31 incident: codex_19 was reserved as
    // a `running` PM resolver in `promotion-job/branch/hgd-growth-v1` since
    // 2026-05-06; the Hub allocator wrapped and a fresh PM spawn for
    // BATCH-3-GATE landed on it.
    const otherPlan = await writePlanState({
      pm_resolvers: [pmResolver({ thread_id: "codex_19", status: "running" })]
    });

    expect(isThreadIdReservedAcrossOtherDispatchPlans([otherPlan], "codex_19")).toBe(true);
  });

  it("returns false for an empty candidate or empty plan list", async () => {
    expect(isThreadIdReservedAcrossOtherDispatchPlans([], "codex_01")).toBe(false);
    expect(isThreadIdReservedAcrossOtherDispatchPlans(["/nonexistent/plan.md"], "")).toBe(false);
    expect(isThreadIdReservedAcrossOtherDispatchPlans(["/nonexistent/plan.md"], "   ")).toBe(false);
  });

  it("skips unreadable plans without throwing", async () => {
    const okPlan = await writePlanState({
      dispatcher: { thread_id: "codex_03", status: "running" }
    });

    expect(
      isThreadIdReservedAcrossOtherDispatchPlans(["/nonexistent/plan.md", okPlan], "codex_03")
    ).toBe(true);
    expect(
      isThreadIdReservedAcrossOtherDispatchPlans(["", "  ", okPlan], "codex_03")
    ).toBe(true);
  });

  async function writePlanState(overrides: Parameters<typeof buildState>[0]): Promise<string> {
    const directory = await fsPromises.mkdtemp(path.join(fs.realpathSync("/tmp"), "meridian-roles-xplan-"));
    tempRoots.push(directory);
    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fsPromises.writeFile(dispatchPlanPath, "# plan\n", "utf8");
    new LifecycleStore(path.join(directory, "dispatch_threads.json"), { dispatchPlanPath })
      .save(buildState(overrides));
    return dispatchPlanPath;
  }
});
