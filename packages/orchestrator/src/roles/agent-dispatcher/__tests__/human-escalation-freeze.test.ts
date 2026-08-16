import { describe, expect, it } from "vitest";

import {
  describeHumanEscalationFreeze,
  effectivePmResolverAction,
  findUnreleasedHumanEscalation,
  isFrozenPendingHumanResolution,
  isHumanEscalationMoot,
  resolveHumanEscalationFrozenWorkers
} from "../human-escalation-freeze";
import { hasPmResolverHandledCurrentWorkerIssue } from "../../../index";
import type { DispatchThreadStateV2, DispatchWorkerState, PmResolverLifecycleState } from "../../../types";

const ESCALATED_AT = "2026-08-06T20:58:53.000Z";

describe("human escalation freeze predicate", () => {
  it("freezes a worker whose PM marker emitted escalate_human and no human has acknowledged", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker({ status: "pending" }) },
      pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })]
    });

    const freeze = findUnreleasedHumanEscalation(state, "BATCH-8-GATE");
    expect(freeze).toMatchObject({
      workerId: "BATCH-8-GATE",
      pmResolverThreadId: "pm-thread-escalated",
      escalatedAt: ESCALATED_AT,
      humanResolvedAt: null
    });
    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(true);
    expect(describeHumanEscalationFreeze(freeze!)).toContain("human-resolve");
  });

  it("holds the freeze even though recordPmResolverResult writes status=failed for escalation markers", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker() },
      pmResolvers: [buildResolver({ status: "failed", marker_outcome: "escalated", marker_pm_action: "escalate_human" })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(true);
  });

  it("re-parses result.content when marker_pm_action is null so the freeze survives a restart", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker() },
      pmResolvers: [buildResolver({
        marker_pm_action: null,
        result: buildResult(marker("pm-resolver", "BATCH-8-GATE", "escalate_human"))
      })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(true);
  });

  it("ignores re-parsed markers whose role is not pm-resolver", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker() },
      pmResolvers: [buildResolver({
        marker_pm_action: null,
        result: buildResult(marker("worker", "BATCH-8-GATE", "escalate_human"))
      })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
  });

  it("ignores re-parsed markers targeting a different worker (thread-id collision bleed)", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker() },
      pmResolvers: [buildResolver({
        marker_pm_action: null,
        result: buildResult(marker("pm-resolver", "SOME-OTHER-ROW", "escalate_human"))
      })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
  });

  it("does not freeze on a non-escalation PM outcome", () => {
    for (const action of ["retry", "skip", "force_complete", "wait"] as const) {
      const state = buildState({
        workers: { "BATCH-8-GATE": buildWorker() },
        pmResolvers: [buildResolver({ marker_pm_action: action, marker_outcome: "resolved" })]
      });

      expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
    }
  });

  it("does not freeze on an escalation targeting a different worker", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker(), "C-02": buildWorker() },
      pmResolvers: [buildResolver({
        marker_pm_action: "escalate_human",
        issue: { status: "manual_intervention_required", worker_id: "C-02", message: null, error: null, source: "watchdog" }
      })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
    expect(isFrozenPendingHumanResolution(state, "C-02")).toBe(true);
  });

  it("releases once human_resolution.resolved_at is at least as new as the escalation", () => {
    const state = buildState({
      workers: {
        "BATCH-8-GATE": buildWorker({
          human_resolution: { resolved_at: "2026-08-06T23:10:00.000Z", note: "spec defect; row descoped" }
        })
      },
      pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
  });

  it("releases on an exactly-equal timestamp (same-instant reconcile write)", () => {
    const state = buildState({
      workers: {
        "BATCH-8-GATE": buildWorker({ human_resolution: { resolved_at: ESCALATED_AT, note: null } })
      },
      pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
  });

  it("re-arms when a NEW escalation post-dates the human acknowledgement", () => {
    const state = buildState({
      workers: {
        "BATCH-8-GATE": buildWorker({
          human_resolution: { resolved_at: "2026-08-06T21:30:00.000Z", note: null }
        })
      },
      pmResolvers: [
        buildResolver({ thread_id: "pm-old", marker_pm_action: "escalate_human", last_seen_at: "2026-08-06T20:58:53.000Z" }),
        buildResolver({ thread_id: "pm-new", marker_pm_action: "escalate_human", last_seen_at: "2026-08-06T22:15:00.000Z" })
      ]
    });

    expect(findUnreleasedHumanEscalation(state, "BATCH-8-GATE")).toMatchObject({
      pmResolverThreadId: "pm-new",
      escalatedAt: "2026-08-06T22:15:00.000Z"
    });
  });

  it("reports the newest unreleased escalation when several are open", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker() },
      pmResolvers: [
        buildResolver({ thread_id: "pm-new", marker_pm_action: "escalate_human", last_seen_at: "2026-08-06T22:15:00.000Z" }),
        buildResolver({ thread_id: "pm-old", marker_pm_action: "escalate_human", last_seen_at: "2026-08-06T20:58:53.000Z" })
      ]
    });

    expect(findUnreleasedHumanEscalation(state, "BATCH-8-GATE")?.pmResolverThreadId).toBe("pm-new");
  });

  it("returns null for a blank or unknown worker id", () => {
    const state = buildState({ workers: {}, pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })] });

    expect(findUnreleasedHumanEscalation(state, "")).toBeNull();
    expect(findUnreleasedHumanEscalation(state, null)).toBeNull();
    expect(findUnreleasedHumanEscalation(state, undefined)).toBeNull();
    // Worker absent from `workers` but present on a PM entry still freezes:
    // absence means "no human_resolution", which is precisely unreleased.
    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(true);
  });

  it("collects every frozen worker, de-duplicated", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker(), "C-02": buildWorker(), "C-04": buildWorker() },
      pmResolvers: [
        buildResolver({ thread_id: "pm-a", marker_pm_action: "escalate_human" }),
        buildResolver({ thread_id: "pm-b", marker_pm_action: "escalate_human" }),
        buildResolver({
          thread_id: "pm-c",
          marker_pm_action: "escalate_human",
          issue: { status: "manual_intervention_required", worker_id: "C-02", message: null, error: null, source: "watchdog" }
        }),
        buildResolver({
          thread_id: "pm-d",
          marker_pm_action: "retry",
          issue: { status: "manual_intervention_required", worker_id: "C-04", message: null, error: null, source: "watchdog" }
        })
      ]
    });

    expect(resolveHumanEscalationFrozenWorkers(state).map((freeze) => freeze.workerId))
      .toEqual(["BATCH-8-GATE", "C-02"]);
  });

  it("does not freeze a row whose work concluded without a human verdict (completed)", () => {
    // W1-03 live shape: escalated to a human, then resolved by another route
    // (operator retry / PM force_complete) that never stamps `human_resolution`.
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker({ status: "completed" }) },
      pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })]
    });

    expect(findUnreleasedHumanEscalation(state, "BATCH-8-GATE")).toBeNull();
    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
    expect(isHumanEscalationMoot(state, "BATCH-8-GATE")).toBe(true);
    expect(resolveHumanEscalationFrozenWorkers(state)).toEqual([]);
  });

  it("does not freeze a row that was deliberately dropped (skipped)", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker({ status: "skipped" }) },
      pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })]
    });

    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(false);
    expect(resolveHumanEscalationFrozenWorkers(state)).toEqual([]);
  });

  it("KEEPS freezing a blocked row — that is the most parked state, not a concluded one", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker({ status: "blocked" }) },
      pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })]
    });

    expect(isHumanEscalationMoot(state, "BATCH-8-GATE")).toBe(false);
    expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(true);
    expect(resolveHumanEscalationFrozenWorkers(state).map((freeze) => freeze.workerId))
      .toEqual(["BATCH-8-GATE"]);
  });

  it("KEEPS freezing every other non-concluded status, including failed and abandoned", () => {
    for (const status of ["pending", "running", "failed", "abandoned", "awaiting_validation", "fix_requested"] as const) {
      const state = buildState({
        workers: { "BATCH-8-GATE": buildWorker({ status }) },
        pmResolvers: [buildResolver({ marker_pm_action: "escalate_human" })]
      });

      expect(isHumanEscalationMoot(state, "BATCH-8-GATE")).toBe(false);
      expect(isFrozenPendingHumanResolution(state, "BATCH-8-GATE")).toBe(true);
    }
  });

  it("filters on state, not on age: a 56-hour-old escalation on a live row still freezes", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker({ status: "blocked" }) },
      pmResolvers: [buildResolver({
        marker_pm_action: "escalate_human",
        last_seen_at: "2026-06-01T00:00:00.000Z"
      })]
    });

    expect(findUnreleasedHumanEscalation(state, "BATCH-8-GATE")).toMatchObject({
      escalatedAt: "2026-06-01T00:00:00.000Z"
    });
  });

  it("re-arms by itself when a concluded row is reset for a retry (read filter, not a stamp)", () => {
    const escalation = buildResolver({ marker_pm_action: "escalate_human" });

    expect(isFrozenPendingHumanResolution(
      buildState({ workers: { "BATCH-8-GATE": buildWorker({ status: "completed" }) }, pmResolvers: [escalation] }),
      "BATCH-8-GATE"
    )).toBe(false);

    // Same untouched PM entry — only the worker status moved back.
    expect(isFrozenPendingHumanResolution(
      buildState({ workers: { "BATCH-8-GATE": buildWorker({ status: "pending" }) }, pmResolvers: [escalation] }),
      "BATCH-8-GATE"
    )).toBe(true);
  });

  it("isHumanEscalationMoot treats an unknown or blank worker id as not concluded", () => {
    const state = buildState({
      workers: { "BATCH-8-GATE": buildWorker({ status: "completed" }) },
      pmResolvers: []
    });

    expect(isHumanEscalationMoot(state, "NOT-A-ROW")).toBe(false);
    expect(isHumanEscalationMoot(state, "")).toBe(false);
    expect(isHumanEscalationMoot(state, null)).toBe(false);
    expect(isHumanEscalationMoot(state, undefined)).toBe(false);
  });

  it("effectivePmResolverAction prefers the persisted field over re-parsed content", () => {
    const entry = buildResolver({
      marker_pm_action: "retry",
      result: buildResult(marker("pm-resolver", "BATCH-8-GATE", "escalate_human"))
    });

    expect(effectivePmResolverAction(entry, "BATCH-8-GATE")).toBe("retry");
  });
});

describe("hasPmResolverHandledCurrentWorkerIssue (PM-spawn gate) still shares the freeze", () => {
  it("reports handled while the escalation is unreleased, even for a fresher worker run", () => {
    const state = buildState({
      workers: {
        // started_at AFTER the escalation — the retry-advances-started_at shape
        // that used to reopen the PM-spawn gate.
        "BATCH-8-GATE": buildWorker({ started_at: "2026-08-06T21:02:11.000Z" })
      },
      pmResolvers: [buildResolver({ status: "failed", marker_pm_action: "escalate_human" })]
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "BATCH-8-GATE")).toBe(true);
  });

  it("stops reporting handled once the human releases it and the PM entry is failed", () => {
    const state = buildState({
      workers: {
        "BATCH-8-GATE": buildWorker({
          started_at: "2026-08-06T21:02:11.000Z",
          human_resolution: { resolved_at: "2026-08-06T23:10:00.000Z", note: null }
        })
      },
      pmResolvers: [buildResolver({ status: "failed", marker_pm_action: "escalate_human" })]
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "BATCH-8-GATE")).toBe(false);
  });
});

function marker(role: string, workerId: string, pmAction: string): string {
  return [
    "<<<MERIDIAN-STATUS>>>",
    `role: ${role}`,
    `worker_id: ${workerId}`,
    "outcome: escalated",
    `pm_action: ${pmAction}`,
    "<<<END>>>"
  ].join("\n");
}

function buildResult(content: string): PmResolverLifecycleState["result"] {
  return {
    status: "success",
    run_state: "completed",
    content,
    summary_text: null,
    details_text: null,
    trace_id: null,
    timestamp: ESCALATED_AT
  };
}

function buildResolver(overrides: Partial<PmResolverLifecycleState> = {}): PmResolverLifecycleState {
  return {
    thread_id: "pm-thread-escalated",
    status: "completed",
    started_at: "2026-08-06T20:50:00.000Z",
    last_seen_at: ESCALATED_AT,
    agent_type: "codex",
    model_id: null,
    mode: "bridge",
    auto_approve: true,
    issue: {
      status: "manual_intervention_required",
      worker_id: "BATCH-8-GATE",
      message: "manual intervention required",
      error: null,
      source: "watchdog"
    },
    result: null,
    error: null,
    transport_error: null,
    marker_outcome: null,
    marker_pm_action: null,
    ...overrides
  };
}

function buildWorker(overrides: Partial<DispatchWorkerState> = {}): DispatchWorkerState {
  return {
    thread_id: "worker-thread-batch8",
    trace_id: null,
    started_at: "2026-08-06T20:00:00.000Z",
    last_seen_at: "2026-08-06T20:58:00.000Z",
    status: "pending",
    expected_outputs: [],
    hub_result: null,
    command_preamble: null,
    retry_count: 0,
    ...overrides
  };
}

function buildState(input: {
  workers: Record<string, DispatchWorkerState>;
  pmResolvers: PmResolverLifecycleState[];
}): DispatchThreadStateV2 {
  return {
    version: 2,
    dispatcher: { thread_id: "dispatcher-thread", started_at: null, status: "running" },
    workers: input.workers,
    pm_resolvers: input.pmResolvers,
    last_reconciled_at: null
  };
}
