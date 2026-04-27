import * as fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import dispatchStatusTool, { buildDispatchStatusReport, parseDispatchPlanRows } from "../dispatch-status";

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

  it("keeps completed workers completed when details_text only contains prompt failure instructions", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        "| ✅ | 1 | R-01 | Frontend nav restructure | CODEX-HIGH | PRE-FLIGHT | Hermes brief | merged |",
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
          "R-01": {
            thread_id: "worker-thread-456",
            trace_id: null,
            started_at: "2026-04-05T00:00:00.000Z",
            last_seen_at: "2026-04-05T00:10:00.000Z",
            status: "completed",
            expected_outputs: [],
            hub_result: {
              trace_id: "11111111-1111-4111-8111-111111111111",
              thread_id: "worker-thread-456",
              source: "codex",
              status: "success",
              run_state: "completed",
              content: "R-01 is already merged on `main`; verification passed.",
              summary_text: "R-01 is already merged on `main`; verification passed.",
              details_text: [
                "Your message:",
                "If any test fails OR any assertion is not satisfied, stop with `⛔ BLOCKED`.",
                "",
                "Agent reply:",
                "R-01 is already merged on `main`; verification passed."
              ].join("\n"),
              attachments: [],
              timestamp: "2026-04-05T00:10:00.000Z"
            }
          }
        },
        last_reconciled_at: null
      }, null, 2)}\n`,
      "utf8"
    );

    await expect(buildDispatchStatusReport(planPath)).resolves.toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        completed: 1,
        failed: 0,
        stale: 0
      }),
      workers: [
        expect.objectContaining({
          worker_id: "R-01",
          status: "✅",
          lifecycle_status: "completed",
          failure_reason: null,
          stale: false
        })
      ]
    }));
  });

  it("does not report an old thread id as the current assignment after manual retry resets a worker to pending", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        "| ⬜ | 2.5 | BATCH-2-GATE | Integration gate | CODEX-HIGH | N-03, R-04 | TaskSpec | redone |",
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
          started_at: "2026-04-27T00:00:00.000Z",
          status: "running"
        },
        workers: {
          "BATCH-2-GATE": {
            thread_id: "worker-thread-old",
            trace_id: "11111111-1111-4111-8111-111111111111",
            started_at: "2026-04-27T00:00:00.000Z",
            last_seen_at: "2026-04-27T00:10:00.000Z",
            status: "pending",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        },
        last_reconciled_at: null
      }, null, 2)}\n`,
      "utf8"
    );

    await expect(buildDispatchStatusReport(planPath)).resolves.toEqual(expect.objectContaining({
      workers: [
        expect.objectContaining({
          worker_id: "BATCH-2-GATE",
          lifecycle_status: "pending",
          thread_id: null,
          last_seen_at: null
        })
      ]
    }));
  });

  it("includes ClawHub tool progress from an explicit progress file", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const manifestPath = `${directory}/W-DETAIL.remaining-managed.json`;
    const progressPath = `${directory}/detail-fetch.progress.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        `| 🔄 | 2 | W-DETAIL | clawhub-fetch detail-fetch --manifest ${manifestPath} --progress ${progressPath} | CODEX-HIGH | W-CATALOG | — | managed detail fetch |`,
        ""
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      progressPath,
      JSON.stringify({
        schema_version: 1,
        command: "detail-fetch",
        scan_run_id: "daily-2026-04-27",
        status: "running",
        manifest_path: manifestPath,
        total: 35324,
        processed: 7326,
        success: 7326,
        failed: 0,
        skipped: 0,
        skipped_existing: 0,
        remaining: 27998,
        started_at: "2026-04-27T00:00:00.000Z",
        updated_at: "2026-04-27T06:00:00.000Z",
        pid: 71436
      }, null, 2),
      "utf8"
    );

    const report = await buildDispatchStatusReport(planPath);

    expect(report.workers[0]).toEqual(expect.objectContaining({
      worker_id: "W-DETAIL",
      progress: expect.objectContaining({
        command: "detail-fetch",
        status: "running",
        total: 35324,
        processed: 7326,
        remaining: 27998,
        progress_path: progressPath
      })
    }));
  });
});
