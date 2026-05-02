import * as fs from "node:fs/promises";
import path from "node:path";

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

  it("keeps blocked lifecycle status when blocked report text also contains failure evidence", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-blocked-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        "| ⛔ BLOCKED | 2 | N-07 | Migration 035 | CODEX-HIGH | BATCH-1-GATE | N-07.md | blocked |",
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
          "N-07": {
            thread_id: "worker-thread-n07",
            trace_id: null,
            started_at: "2026-04-05T00:00:00.000Z",
            last_seen_at: "2026-04-05T00:10:00.000Z",
            status: "blocked",
            expected_outputs: [],
            hub_result: {
              trace_id: "11111111-1111-4111-8111-111111111111",
              thread_id: "worker-thread-n07",
              source: "output_artifact",
              status: "success",
              run_state: "completed",
              content: [
                "Status: BLOCKED",
                "",
                "Remote apply failed with exit code 1 because credentials are missing."
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
        failed: 1
      }),
      workers: [
        expect.objectContaining({
          worker_id: "N-07",
          status: "⛔ BLOCKED",
          lifecycle_status: "blocked",
          failure_reason: expect.stringContaining("Status: BLOCKED")
        })
      ]
    }));
  });

  it("reports recovered PM resolver replies separately from worker status", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-pm-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        "| ✅ | 1 | BATCH-1-GATE | Gate Batch 2 | CODEX-HIGH | N-01 | BATCH-1-GATE.md | PM resolved |",
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
          started_at: "2026-05-03T00:00:00.000Z",
          status: "running"
        },
        workers: {
          "BATCH-1-GATE": {
            thread_id: "codex_40",
            trace_id: "55555555-5555-4555-8555-555555555555",
            started_at: "2026-05-03T00:01:00.000Z",
            last_seen_at: "2026-05-03T00:05:00.000Z",
            status: "completed",
            expected_outputs: [],
            hub_result: {
              trace_id: "55555555-5555-4555-8555-555555555555",
              thread_id: "codex_40",
              source: "pm-resolver",
              status: "success",
              run_state: "completed",
              content: "PM resolution complete for BATCH-1-GATE. Dispatcher continued to N-07.",
              attachments: [],
              timestamp: "2026-05-03T00:05:00.000Z"
            },
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
          worker_id: "BATCH-1-GATE",
          status: "✅",
          lifecycle_status: "completed",
          failure_reason: null
        })
      ],
      pm_resolvers: [
        expect.objectContaining({
          worker_id: "BATCH-1-GATE",
          thread_id: "codex_40",
          status: "completed",
          issue_status: "recovered_pm_resolution",
          issue_source: "worker_result",
          reply: "PM resolution complete for BATCH-1-GATE. Dispatcher continued to N-07."
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
        status: "completed",
        manifest_path: manifestPath,
        total: 35324,
        processed: 35324,
        success: 35324,
        failed: 0,
        skipped: 0,
        skipped_existing: 0,
        remaining: 0,
        started_at: "2026-04-27T00:00:00.000Z",
        updated_at: "2026-04-27T06:00:00.000Z",
        completed_at: "2026-04-27T06:00:00.000Z",
        pid: 71436
      }, null, 2),
      "utf8"
    );

    const report = await buildDispatchStatusReport(planPath);

    expect(report.workers[0]).toEqual(expect.objectContaining({
      worker_id: "W-DETAIL",
      progress: expect.objectContaining({
        command: "detail-fetch",
        status: "completed",
        total: 35324,
        processed: 35324,
        remaining: 0,
        progress_path: progressPath
      })
    }));
  });

  it("uses nonterminal tool progress instead of completed lifecycle status", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;
    const manifestPath = `${directory}/W-DETAIL.remaining-managed.json`;
    const progressPath = `${directory}/detail-fetch.progress.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        `| ✅ | 2 | W-DETAIL | clawhub-fetch detail-fetch --manifest ${manifestPath} --progress ${progressPath} | CODEX-HIGH | W-CATALOG | — | managed detail fetch |`,
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
          "W-DETAIL": {
            thread_id: "worker-thread-456",
            trace_id: null,
            started_at: "2026-04-27T00:00:00.000Z",
            last_seen_at: "2026-04-27T00:10:00.000Z",
            status: "completed",
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

    await fs.writeFile(
      progressPath,
      JSON.stringify({
        command: "detail-fetch",
        scan_run_id: "daily-2026-04-27",
        status: "failed",
        total: 35324,
        processed: 35294,
        success: 35294,
        failed: 30,
        skipped: 0,
        remaining: 30,
        updated_at: "2026-04-27T13:35:12.774Z"
      }, null, 2),
      "utf8"
    );

    await expect(buildDispatchStatusReport(planPath)).resolves.toEqual(expect.objectContaining({
      workers: [
        expect.objectContaining({
          worker_id: "W-DETAIL",
          status: "❌",
          lifecycle_status: "failed",
          failure_reason: "tool progress failed: 30 remaining, 30 failed"
        })
      ],
      summary: expect.objectContaining({
        completed: 0,
        failed: 1
      })
    }));
  });

  it("marks running progress files failed when no matching tool process exists", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;
    const manifestPath = `${directory}/changed_skill_manifest.json`;
    const progressPath = `${directory}/ssr-enrich.progress.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        `| 🔄 | 3 | W-SSR | clawhub-fetch ssr-enrich --scan-run-id daily-dead-progress-test --manifest ${manifestPath} --progress ${progressPath} | CODEX-HIGH | W-DETAIL | — | managed ssr enrich |`,
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
          started_at: "2026-05-02T00:00:00.000Z",
          status: "running"
        },
        workers: {
          "W-SSR": {
            thread_id: "worker-thread-dead-progress",
            trace_id: null,
            started_at: "2026-05-02T00:00:00.000Z",
            last_seen_at: "2026-05-02T00:10:00.000Z",
            status: "abandoned",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 2
          }
        },
        last_reconciled_at: null
      }, null, 2)}\n`,
      "utf8"
    );

    await fs.writeFile(
      progressPath,
      JSON.stringify({
        command: "ssr-enrich",
        scan_run_id: "daily-dead-progress-test",
        status: "running",
        manifest_path: manifestPath,
        total: 13075,
        processed: 4699,
        success: 0,
        failed: 15,
        skipped: 4684,
        remaining: 8376,
        updated_at: "2026-05-02T07:18:16.453Z",
        pid: 999999
      }, null, 2),
      "utf8"
    );

    await expect(buildDispatchStatusReport(planPath)).resolves.toEqual(expect.objectContaining({
      workers: [
        expect.objectContaining({
          worker_id: "W-SSR",
          status: "❌",
          lifecycle_status: "failed",
          failure_reason: "tool progress failed: process not running, 8376 remaining, 15 failed",
          progress: expect.objectContaining({
            status: "failed",
            extra: expect.objectContaining({
              inactive_process: true
            })
          })
        })
      ],
      summary: expect.objectContaining({
        running: 0,
        failed: 1
      })
    }));
  });

  it("loads worker progress from a routine-job registry file source", async () => {
    const root = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-registry-");
    tempDirectories.add(root);

    const jobRoot = path.join(root, "github-opc-solution-scan");
    const planDir = path.join(jobRoot, "v1");
    await fs.mkdir(planDir, { recursive: true });

    const planPath = path.join(planDir, "dispatch_plan.md");
    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On |",
        "|--------|-------|--------|------|-------|------------|",
        "| 🔄 | 3 | T-REPO-FETCH | repo-fetch metadata + cache | CODEX-XHIGH | — |",
        ""
      ].join("\n"),
      "utf8"
    );

    const progressPath = path.join(planDir, "T-REPO-FETCH.progress.json");
    await fs.writeFile(progressPath, JSON.stringify({
      command: "repo-fetch",
      status: "running",
      total: 200,
      processed: 47,
      success: 40,
      failed: 2,
      skipped: 5,
      remaining: 153,
      started_at: "2026-04-28T00:00:00.000Z",
      updated_at: "2026-04-28T00:01:00.000Z",
      extra: { current_repo: "octocat/Hello-World" }
    }), "utf8");

    await fs.writeFile(
      path.join(root, "progress_registry.json"),
      JSON.stringify({
        version: 1,
        routine_jobs: [
          {
            name: "github-opc-solution-scan",
            plan_path_prefix: jobRoot,
            workers: {
              "T-REPO-FETCH": {
                kind: "file",
                path: progressPath
              }
            }
          }
        ]
      }),
      "utf8"
    );

    const report = await buildDispatchStatusReport(planPath);
    expect(report.workers[0]).toMatchObject({
      worker_id: "T-REPO-FETCH",
      status: "🔄",
      progress: {
        command: "repo-fetch",
        status: "running",
        processed: 47,
        remaining: 153,
        extra: { current_repo: "octocat/Hello-World" }
      }
    });
  });
});
