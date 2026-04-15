import * as fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import dispatchStatusTool, { parseDispatchPlanRows } from "../dispatch-status";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("dispatch-status tool", () => {
  it("parses dispatch tables that use Function Group instead of Task", () => {
    expect(parseDispatchPlanRows([
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Function Group | Cases | Model | Depends On | Report File |",
      "|--------|-------|--------|----------------|-------|-------|------------|-------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment health check | — | CODEX | — | `reports/PRE-FLIGHT.md` |",
      "| ⬜ | Ω | SUMMARY-GATE | Sector validation report | — | OPUS | all E-XX | `reports/sector_validation_report.md` |",
      ""
    ].join("\n"))).toEqual([
      {
        status: "✅",
        batch: "0",
        worker_id: "PRE-FLIGHT",
        task: "Environment health check",
        model: "CODEX",
        depends_on: [],
        prds_to_attach: null,
        notes: null
      },
      {
        status: "⬜",
        batch: "Ω",
        worker_id: "SUMMARY-GATE",
        task: "Sector validation report",
        model: "OPUS",
        depends_on: ["all E-XX"],
        prds_to_attach: null,
        notes: null
      }
    ]);
  });

  it("parses dispatch tables that use PRDs and extra workflow columns", () => {
    expect(parseDispatchPlanRows([
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | TaskSpec File | PRDs | PR | Notes |",
      "|--------|-------|--------|------|-------|------------|---------------|------|----|-------|",
      "| ⬜ | 1 | R-01 | Fix CLI contract | CODEX | PRE-FLIGHT | `cli-fix-v1/R-01.md` | Investigation Report | — | dispatch after PRE-FLIGHT ✅ |",
      ""
    ].join("\n"))).toEqual([
      {
        status: "⬜",
        batch: "1",
        worker_id: "R-01",
        task: "Fix CLI contract",
        model: "CODEX",
        depends_on: ["PRE-FLIGHT"],
        prds_to_attach: "Investigation Report",
        notes: "dispatch after PRE-FLIGHT ✅"
      }
    ]);
  });

  it("marks running workers as stale from dispatch_threads.json last_seen_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T01:00:00.000Z"));

    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        "| 🔄 | 2 | N-05 | Dispatch status | CODEX-HIGH | R-03 | CLI Integration PRD | read-only |",
        "| ✅ | 1 | R-03 | Bin registration | CODEX | — | CLI Integration PRD | complete |",
        ""
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      sidecarPath,
      `${JSON.stringify({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-04-05T00:00:00.000Z",
          status: "running"
        },
        workers: {
          "N-05": {
            thread_id: "worker-thread-456",
            trace_id: null,
            started_at: "2026-04-05T00:00:00.000Z",
            last_seen_at: "2026-04-05T00:10:00.000Z",
            status: "running",
            expected_outputs: [],
            hub_result: null
          }
        },
        last_reconciled_at: null
      }, null, 2)}\n`,
      "utf8"
    );

    const result = await dispatchStatusTool.execute({
      plan: planPath
    });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        plan: planPath,
        dispatch_threads: sidecarPath,
        stale_threshold_minutes: 30,
        summary: {
          total: 2,
          pending: 0,
          running: 1,
          completed: 1,
          failed: 0,
          skipped: 0,
          stale: 1
        },
        workers: [
          expect.objectContaining({
            worker_id: "N-05",
            status: "🔄",
            stale: true,
            stale_label: "⚠️ STALE",
            stale_duration_minutes: 50,
            stale_duration_human: "50m",
            thread_id: "worker-thread-456",
            last_seen_at: "2026-04-05T00:10:00.000Z"
          }),
          expect.objectContaining({
            worker_id: "R-03",
            status: "✅",
            stale: false
          })
        ]
      })
    });
  });
});
