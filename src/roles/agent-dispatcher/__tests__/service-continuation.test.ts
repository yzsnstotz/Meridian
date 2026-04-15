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
});

function createLifecycleState(): DispatchThreadStateV2 {
  return {
    version: 2,
    dispatcher: {
      thread_id: null,
      started_at: null,
      status: "pending"
    },
    workers: {},
    last_reconciled_at: null
  };
}
