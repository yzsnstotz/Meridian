import { describe, expect, it } from "vitest";

import { resolveServiceContinueWorker } from "../service-continuation";
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
});

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
