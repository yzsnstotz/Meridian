import { describe, expect, it } from "vitest";

import {
  resolveManualInterventionWorker,
  resolveServiceContinueWorker
} from "../service-continuation";
import type { DispatchThreadStateV2 } from "../../../types";

describe("service continuation", () => {
  it("resolves prefix wildcard dependencies such as all E-XX", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "1", worker: "E-01", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "✅", batch: "1", worker: "E-02", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "⬜", batch: "Ω", worker: "SUMMARY-GATE", model: "OPUS", depends_on: "all E-XX" }
    ], createLifecycleState())).toBe("SUMMARY-GATE");
  });

  it("resolves implementation-worker dependency groups", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX", depends_on: "—" },
      { status: "✅", batch: "1", worker: "N-01", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "✅", batch: "1", worker: "R-01", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "✅", batch: "2", worker: "V-01", model: "HUMAN", depends_on: "R-01" },
      { status: "⬜", batch: "Ω", worker: "DELTA-CHECK", model: "CODEX", depends_on: "all impl workers" }
    ], createLifecycleState())).toBe("DELTA-CHECK");
  });

  it("resolves decorated worker ids plus batch and PM decision group dependencies", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "Ω", worker: "🟠 DELTA-CHECK", model: "CODEX", depends_on: "N-01–N-03" },
      { status: "✅", batch: "Ω+1=7", worker: "C-01", model: "CODEX", depends_on: "🟠 DELTA-CHECK" },
      { status: "✅", batch: "Ω+2=9", worker: "C-02", model: "CODEX", depends_on: "🟠 DELTA-CHECK" },
      { status: "✅", batch: "8", worker: "PM-DECIDE-1", model: "PM", depends_on: "🟠 DELTA-CHECK" },
      { status: "✅", batch: "6", worker: "V-01", model: "HUMAN", depends_on: "R-01" },
      { status: "✅", batch: "6", worker: "V-02", model: "HUMAN", depends_on: "R-02" },
      {
        status: "⬜",
        batch: "Ω=10",
        worker: "PR-REVIEW",
        model: "CODEX",
        depends_on: "DELTA-CHECK, all Ω+1/Ω+2 workers, all PM-DECIDE-N, V-01, V-02"
      }
    ], createLifecycleState())).toBe("PR-REVIEW");
  });

  it("resolves numeric batch dependency groups such as All Batch 1-3", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX-HIGH", depends_on: "—" },
      { status: "✅", batch: "1", worker: "R-01", model: "CODEX-HIGH", depends_on: "PRE-FLIGHT" },
      { status: "✅", batch: "1", worker: "R-02", model: "CODEX-HIGH", depends_on: "PRE-FLIGHT" },
      { status: "✅", batch: "2", worker: "N-06", model: "CODEX-XHIGH", depends_on: "R-01" },
      { status: "✅", batch: "3", worker: "N-10", model: "CODEX-HIGH", depends_on: "R-01, R-02" },
      { status: "⬜", batch: "4", worker: "BATCH-4-GATE", model: "CODEX-HIGH", depends_on: "All Batch 1–3" }
    ], createLifecycleState())).toBe("BATCH-4-GATE");
  });

  it("resolves all above dependencies against rows before the current worker", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX-HIGH", depends_on: "—" },
      { status: "✅", batch: "4", worker: "V-12-B", model: "HUMAN", depends_on: "PRE-FLIGHT" },
      { status: "✅", batch: "4", worker: "R-13", model: "CODEX-HIGH", depends_on: "V-12-B" },
      { status: "⬜", batch: "Ω", worker: "SUMMARY-GATE", model: "CODEX-XHIGH", depends_on: "All above" }
    ], createLifecycleState())).toBe("SUMMARY-GATE");
  });

  it("does not resolve all above when any earlier row is non-terminal", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX-HIGH", depends_on: "—" },
      { status: "⬜", batch: "4", worker: "V-12-B", model: "HUMAN", depends_on: "PRE-FLIGHT" },
      { status: "⬜", batch: "Ω", worker: "SUMMARY-GATE", model: "CODEX-XHIGH", depends_on: "All above" }
    ], createLifecycleState())).toBeNull();
  });

  it("does not auto-continue rows whose notes explicitly mark them blocked", () => {
    expect(resolveServiceContinueWorker([
      {
        status: "⬜",
        batch: "1",
        worker: "R-02",
        model: "CODEX",
        depends_on: "PRE-FLIGHT",
        notes: "**⏳ BLOCKED: PM Blocker Resolution #1 must be confirmed first**"
      }
    ], createLifecycleState())).toBeNull();
  });

  it("does not re-dispatch a worker whose plan shows 🔄 but lifecycle is completed", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX", depends_on: "—" },
      { status: "🔄", batch: "1", worker: "R-01", model: "CODEX", depends_on: "PRE-FLIGHT" }
    ], createLifecycleState({
      "R-01": {
        status: "completed",
        thread_id: "worker-thread-r01"
      }
    }))).toBeNull();
  });

  it("does not re-dispatch a worker whose plan shows 🔄 but lifecycle is skipped", () => {
    expect(resolveServiceContinueWorker([
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX", depends_on: "—" },
      { status: "🔄", batch: "1", worker: "R-01", model: "CODEX", depends_on: "PRE-FLIGHT" }
    ], createLifecycleState({
      "R-01": {
        status: "skipped",
        thread_id: "worker-thread-r01"
      }
    }))).toBeNull();
  });

  it("ignores blocked running rows when selecting the next automatic continuation target", () => {
    expect(resolveServiceContinueWorker([
      {
        status: "✅",
        batch: "1",
        worker: "R-01",
        model: "CODEX",
        depends_on: "PRE-FLIGHT",
        notes: "Completed."
      },
      {
        status: "🔄",
        batch: "1",
        worker: "R-03",
        model: "CODEX",
        depends_on: "PRE-FLIGHT",
        notes: "**⏳ BLOCKED: PM Blocker Resolution #2 must be confirmed first**"
      },
      {
        status: "⬜",
        batch: "2",
        worker: "E-01R",
        model: "CODEX",
        depends_on: "R-01",
        notes: "Ready to rerun."
      }
    ], createLifecycleState({
      "R-01": {
        status: "completed"
      }
    }))).toBe("E-01R");
  });

  it("does not auto-continue abandoned rows once the retry threshold is reached", () => {
    expect(resolveServiceContinueWorker([
      { status: "⚠️ ABANDONED", batch: "1", worker: "R-03", model: "CODEX", depends_on: "PRE-FLIGHT" }
    ], createLifecycleState({
      "R-03": {
        status: "abandoned",
        retry_count: 2
      }
    }))).toBeNull();
  });

  it("pauses instead of auto-retrying failed rows with blocking hub results", () => {
    const rows = [
      { status: "❌", batch: "0", worker: "N-01", model: "CODEX-HIGH", depends_on: "—" }
    ];
    const lifecycleState = createLifecycleState({
      "N-01": {
        status: "failed",
        retry_count: 0,
        hub_result: createHubResult("Status: BLOCKED - required @phoenix namespace is absent from the extracted asar tree.")
      }
    });

    expect(resolveServiceContinueWorker(rows, lifecycleState)).toBeNull();
    expect(resolveManualInterventionWorker(rows, lifecycleState)).toBe("N-01");
  });

  it("does not retry or route around a blocked PRE-FLIGHT worker", () => {
    const rows = [
      { status: "❌", batch: "0", worker: "PRE-FLIGHT", model: "CODEX-HIGH", depends_on: "—" },
      { status: "⬜", batch: "1", worker: "N-01", model: "CODEX-XHIGH", depends_on: "—" }
    ];
    const lifecycleState = createLifecycleState({
      "PRE-FLIGHT": {
        status: "blocked",
        retry_count: 0,
        hub_result: createHubResult("PRE-FLIGHT is still **BLOCKED**.")
      }
    });

    expect(resolveServiceContinueWorker(rows, lifecycleState)).toBeNull();
    expect(resolveManualInterventionWorker(rows, lifecycleState)).toBe("PRE-FLIGHT");
  });

  it("does not resume a stale downstream running row while PRE-FLIGHT is blocked", () => {
    const rows = [
      { status: "⛔ BLOCKED", batch: "0", worker: "PRE-FLIGHT", model: "CODEX-HIGH", depends_on: "—" },
      { status: "🔄", batch: "1", worker: "N-01", model: "CODEX-XHIGH", depends_on: "—" }
    ];

    expect(resolveServiceContinueWorker(rows, createLifecycleState())).toBeNull();
    expect(resolveManualInterventionWorker(rows, createLifecycleState())).toBe("PRE-FLIGHT");
  });

  it("can resume PRE-FLIGHT itself when its plan row is stale running", () => {
    const rows = [
      { status: "🔄", batch: "0", worker: "PRE-FLIGHT", model: "CODEX-HIGH", depends_on: "—" },
      { status: "⬜", batch: "1", worker: "N-01", model: "CODEX-XHIGH", depends_on: "—" }
    ];

    expect(resolveServiceContinueWorker(rows, createLifecycleState())).toBe("PRE-FLIGHT");
  });

  // Regression: a worker whose original reply emitted outcome:blocked but
  // whose validator subsequently approved it (lifecycle status=completed)
  // must NOT trigger manual intervention even though the plan markdown row
  // still shows ⛔ BLOCKED. The plan can lag behind the lifecycle; the
  // lifecycle is authoritative for terminal-success and validator-owned
  // states. See PR #128/#129 marker protocol — BATCH-2-GATE incident.
  it("does not flag manual intervention when lifecycle is completed despite a stale ⛔ BLOCKED plan row", () => {
    const rows = [
      {
        status: "⛔ BLOCKED",
        batch: "2",
        worker: "BATCH-2-GATE",
        model: "CODEX-HIGH",
        depends_on: "—"
      }
    ];
    const lifecycleState = createLifecycleState({
      "BATCH-2-GATE": {
        status: "completed",
        retry_count: 0,
        hub_result: createHubResult(
          "Working on the gate.\n<<<MERIDIAN-STATUS>>>\nworker_id: BATCH-2-GATE\nrole: worker\noutcome: blocked\nreport_path: /tmp/report.md\nnotes: original blocker since resolved by validator\n<<<END>>>"
        )
      }
    });

    expect(resolveManualInterventionWorker(rows, lifecycleState)).toBeNull();
  });

  it("does not flag manual intervention when lifecycle is awaiting_validation despite a stale ⛔ BLOCKED plan row", () => {
    const rows = [
      { status: "⛔ BLOCKED", batch: "1", worker: "N-12", model: "CODEX", depends_on: "—" }
    ];
    const lifecycleState = createLifecycleState({
      "N-12": { status: "awaiting_validation" }
    });

    expect(resolveManualInterventionWorker(rows, lifecycleState)).toBeNull();
  });

  it("does not flag manual intervention when lifecycle is fix_requested despite a stale ⛔ BLOCKED plan row", () => {
    const rows = [
      { status: "⛔ BLOCKED", batch: "1", worker: "N-12", model: "CODEX", depends_on: "—" }
    ];
    const lifecycleState = createLifecycleState({
      "N-12": { status: "fix_requested" }
    });

    expect(resolveManualInterventionWorker(rows, lifecycleState)).toBeNull();
  });

  it("does not flag manual intervention when lifecycle is skipped despite a stale ⛔ BLOCKED plan row", () => {
    const rows = [
      { status: "⛔ BLOCKED", batch: "1", worker: "N-12", model: "CODEX", depends_on: "—" }
    ];
    const lifecycleState = createLifecycleState({
      "N-12": { status: "skipped" }
    });

    expect(resolveManualInterventionWorker(rows, lifecycleState)).toBeNull();
  });

  it("still flags manual intervention when lifecycle status is blocked even if plan row says ⛔ BLOCKED", () => {
    const rows = [
      { status: "⛔ BLOCKED", batch: "1", worker: "N-12", model: "CODEX", depends_on: "—" }
    ];
    const lifecycleState = createLifecycleState({
      "N-12": {
        status: "blocked",
        hub_result: createHubResult("Status: BLOCKED — needs PM input.")
      }
    });

    expect(resolveManualInterventionWorker(rows, lifecycleState)).toBe("N-12");
  });

  it("still flags manual intervention when no lifecycle entry exists and plan says ⛔ BLOCKED", () => {
    const rows = [
      { status: "⛔ BLOCKED", batch: "1", worker: "N-12", model: "CODEX", depends_on: "—" }
    ];

    expect(resolveManualInterventionWorker(rows, createLifecycleState())).toBe("N-12");
  });
});

function createHubResult(content: string): NonNullable<DispatchThreadStateV2["workers"][string]["hub_result"]> {
  return {
    trace_id: "trace-n-01",
    thread_id: "n-01-thread",
    source: "codex",
    status: "success",
    run_state: "completed",
    content,
    attachments: [],
    timestamp: "2026-04-03T12:01:00.000Z"
  };
}

function createLifecycleState(
  workerOverrides: Record<string, Partial<DispatchThreadStateV2["workers"][string]>> = {}
): DispatchThreadStateV2 {
  return {
    version: 2,
    dispatcher: {
      thread_id: null,
      started_at: null,
      status: "pending"
    },
    workers: Object.fromEntries(
      Object.entries(workerOverrides).map(([workerId, overrides]) => ([
        workerId,
        {
          thread_id: `${workerId.toLowerCase()}-thread`,
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          ...overrides
        }
      ]))
    ),
    last_reconciled_at: null
  };
}
