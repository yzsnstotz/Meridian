import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DispatchThreadStateV2, HubResult } from "../../../types";
import { LifecycleStore, buildEmptyDispatchThreadStateV2 } from "../lifecycle-store";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fsp.rm(directory, { recursive: true, force: true });
    })
  );

  tempDirectories.clear();
});

describe("LifecycleStore", () => {
  it("loads an empty file as an empty v2 lifecycle state", async () => {
    const harness = await createHarness();
    await fsp.writeFile(harness.filePath, "", "utf8");

    const state = harness.store.load();

    expect(state).toEqual(buildEmptyDispatchThreadStateV2());
    await expect(fsp.readFile(harness.filePath, "utf8")).resolves.toContain("\"version\": 2");
  });

  it("auto-migrates a v1 sidecar file to v2 defaults", async () => {
    const harness = await createHarness();
    await fsp.writeFile(harness.filePath, `${JSON.stringify({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {
        "N-01": "worker-thread-111",
        "N-02": {
          thread_id: "worker-thread-222",
          started_at: "2026-04-02T17:21:55.063Z"
        }
      }
    }, null, 2)}\n`, "utf8");

    const state = harness.store.load();

    expect(state).toEqual({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "1970-01-01T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: null,
          started_at: "1970-01-01T00:00:00.000Z",
          last_seen_at: "1970-01-01T00:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: null,
          started_at: "2026-04-02T17:21:55.063Z",
          last_seen_at: "2026-04-02T17:21:55.063Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [],
      last_reconciled_at: null
    });

    const saved = JSON.parse(await fsp.readFile(harness.filePath, "utf8")) as DispatchThreadStateV2;
    expect(saved.version).toBe(2);
    expect(saved.workers["N-01"]?.trace_id).toBeNull();
    expect(saved.workers["N-02"]?.expected_outputs).toEqual([]);
  });

  it("records worker start state as running", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "test/gui-demo/final.txt"
    ]);

    const state = harness.store.load();
    expect(state.workers["N-01"]).toMatchObject({
      thread_id: "worker-thread-111",
      trace_id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      expected_outputs: ["test/gui-demo/final.txt"],
      hub_result: null
    });
    expect(state.workers["N-01"]?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.workers["N-01"]?.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("maps a success HubResult to completed", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("keeps a success HubResult running when real output verification is required", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "test/gui-demo/final.txt"
    ]);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "running",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult blocked when a fresh expected output report is blocked", async () => {
    const harness = await createHarness();
    const outputPath = path.join(harness.directory, "reports", "V-01-A.md");
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    harness.store.recordWorkerStart(
      "V-01-A",
      "worker-thread-v01a",
      "11111111-1111-4111-8111-111111111111",
      [outputPath]
    );
    await fsp.writeFile(outputPath, [
      "# V-01-A Report",
      "",
      "**Result**: BLOCKED",
      "",
      "Verification failed."
    ].join("\n"), "utf8");

    harness.store.recordWorkerResult("V-01-A", buildHubResult({
      thread_id: "worker-thread-v01a",
      status: "success",
      run_state: "completed",
      content: "Report written.",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["V-01-A"]).toMatchObject({
      status: "blocked",
      hub_result: expect.objectContaining({
        content: "Report written."
      })
    });
  });

  it("does not complete a retry from a blocked output report written before the attempt started", async () => {
    const harness = await createHarness();
    const outputPath = path.join(harness.directory, "reports", "V-01-A.md");
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, [
      "# V-01-A Report",
      "",
      "**Result**: BLOCKED",
      "",
      "Previous attempt failed."
    ].join("\n"), "utf8");
    await fsp.utimes(
      outputPath,
      new Date("2026-04-03T12:00:00.000Z"),
      new Date("2026-04-03T12:00:00.000Z")
    );

    harness.store.recordWorkerStart(
      "V-01-A",
      "worker-thread-v01a-retry",
      "11111111-1111-4111-8111-111111111111",
      [outputPath]
    );
    harness.store.recordWorkerResult("V-01-A", buildHubResult({
      thread_id: "worker-thread-v01a-retry",
      status: "success",
      run_state: "completed",
      content: "No fresh report yet.",
      timestamp: "2026-04-03T12:30:00.000Z"
    }));

    expect(harness.store.load().workers["V-01-A"]).toMatchObject({
      status: "running"
    });
  });

  it("completes immediately when a deferred-success result returns an inline validation report", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "reports/PRE-FLIGHT.md"
    ]);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "Pre-flight passed. Returning the report inline because the docs path was not writable.",
        "",
        "```markdown",
        "# PRE-FLIGHT Validation Report",
        "",
        "- **Date**: 2026-04-03T12:00:00.000Z",
        "- **Worker**: CODEX",
        "- **Status**: ✅ PASS",
        "",
        "## Summary",
        "7 cases run. 7 passed. 0 failed. 0 skipped.",
        "",
        "## Case Results",
        "",
        "| # | Function | Case Type | Status | Notes |",
        "|---|----------|-----------|--------|-------|",
        "| 1 | `PRE-FLIGHT.1` | Test runner baseline | ✅ | `npx tsx --version` succeeded. |",
        "```"
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("completes when a deferred-success result has an explicit completion marker without inline report", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "reports/PRE-FLIGHT.md"
    ]);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: "**PRE-FLIGHT complete. ✅**",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult as failed when the worker reply hit a terminal limit", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: ":hit limit"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z",
      hub_result: expect.objectContaining({
        content: ":hit limit"
      })
    });
  });

  it("completes immediately when a deferred-success result returns an inline completion report for a report-only worker", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("R-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "reports/R-01.md"
    ]);

    harness.store.recordWorkerResult("R-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "Validation passed. Returning the completion report inline because the docs path was not writable.",
        "",
        "```md",
        "# R-01 Completion Report",
        "",
        "- Worker ID: `R-01`",
        "- Date: `2026-04-03`",
        "",
        "## Sub-tasks Completed",
        "",
        "1. Wrapped `JSON.parse` in `readStore()`.",
        "2. Preserved the invalid storage contract error.",
        "",
        "## Test Results",
        "",
        "- `npm run typecheck`",
        "  - Result: passed",
        "```"
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["R-01"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("does not complete a worker from another worker's reported output path", async () => {
    const harness = await createHarness();
    const preflightReportPath = path.join(harness.directory, "reports", "run", "run-001", "PRE-FLIGHT.md");
    const catalogReportPath = path.join(harness.directory, "reports", "run", "run-001", "W-CATALOG.md");
    await fsp.mkdir(path.dirname(preflightReportPath), { recursive: true });
    await fsp.writeFile(preflightReportPath, "# PRE-FLIGHT Completion Report\n\n- Status: ✅ Complete\n", "utf8");

    harness.store.recordWorkerStart("W-CATALOG", "worker-thread-222", "22222222-2222-4222-8222-222222222222", [
      catalogReportPath
    ]);

    harness.store.recordWorkerResult("W-CATALOG", buildHubResult({
      thread_id: "worker-thread-222",
      status: "success",
      run_state: "completed",
      content: [
        "PRE-FLIGHT completed with exit code `0`.",
        "",
        `Report written to [PRE-FLIGHT.md](${preflightReportPath}).`
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-CATALOG"]).toMatchObject({
      status: "running",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("maps an error HubResult to failed", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "error",
      content: "worker failed",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("maps a timeout HubResult to running so the reconciler can validate", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "partial",
      run_state: "timeout",
      content: "Task is running...",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "running",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("keeps a success HubResult running when content indicates PAUSE", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      content: "⏸ PAUSE — Next eligible task N-02 is assigned to CODEX-XHIGH",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "running",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("keeps a success HubResult running when content says the command has not completed", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-SSR", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-SSR", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "W-SSR is still running, not complete.",
        "",
        "Current CLI status from `clawhub-fetch ssr-enrich`:",
        "",
        "```text",
        "4700/61149 processed",
        "4684 success",
        "16 failed",
        "0 skipped",
        "56449 remaining",
        "```",
        "",
        "No completion report has been written yet because the CLI has not exited, so there is no final exit code or validation result."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-SSR"]).toMatchObject({
      status: "running",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult blocked when content reports BLOCKED", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      content: "⛔ BLOCKED — Cannot write to dispatch_plan.md, sandbox restriction",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "blocked",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult failed when a tool summary reports nonzero failed items", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-DETAIL", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-DETAIL", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "# W-DETAIL Completion Report",
        "",
        "## JSON Summary Output",
        "",
        "```json",
        "{",
        "  \"success\": 35292,",
        "  \"failed\": 32,",
        "  \"skipped\": 0",
        "}",
        "```"
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-DETAIL"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("keeps successful detail-fetch reports completed when failed count is item-level", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-DETAIL", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-DETAIL", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "# W-DETAIL Completion Report",
        "",
        "- Worker ID: W-DETAIL",
        "- Exit code: 0",
        "",
        "## JSON Summary Output",
        "",
        "```json",
        "{",
        "  \"success\": 865,",
        "  \"failed\": 21,",
        "  \"skipped\": 12650,",
        "  \"skipped_existing\": 12650",
        "}",
        "```",
        "",
        "## AI Auto-Test Results",
        "",
        "- Detail fetch command completed with exit code 0: PASS",
        "- Processed count validation: PASS (`865 + 21 + 12650 = 13536`)",
        "",
        "## Notes",
        "",
        "- `clawhub-fetch` reported 21 per-skill failures and continued to successful command completion."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-DETAIL"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("keeps successful detail-fetch reports completed when upstream item payloads are unavailable", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-DETAIL", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-DETAIL", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "# W-DETAIL Completion Report",
        "",
        "- Worker ID: W-DETAIL",
        "- Status: completed",
        "",
        "## Exit Code",
        "",
        "- AI Auto-Test/reconciliation exit code: 0",
        "",
        "## JSON Summary Output",
        "",
        "```json",
        "{",
        "  \"success\": 865,",
        "  \"failed\": 21,",
        "  \"skipped\": 476,",
        "  \"skipped_existing\": 476",
        "}",
        "```",
        "",
        "## AI Auto-Test Results",
        "",
        "```text",
        "PASS: manifest exists",
        "PASS: clawhub-fetch detail-fetch exited 0",
        "PASS: progress status is completed",
        "PASS: processed count equals total count: 1362 == 1362",
        "PASS: remaining count is 0",
        "INFO: 21 package/version/file payloads were unavailable from the upstream API and were recorded by the CLI during the run.",
        "```"
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-DETAIL"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("keeps successful detail-fetch reports completed when item failures are not worker-level failures", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-DETAIL", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-DETAIL", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "# W-DETAIL Completion Report",
        "",
        "- Worker ID: W-DETAIL",
        "- Exit code: 0",
        "",
        "## JSON Summary Output",
        "",
        "```json",
        "{",
        "  \"success\": 2013,",
        "  \"failed\": 24,",
        "  \"skipped\": 10925,",
        "  \"skipped_existing\": 10925",
        "}",
        "```",
        "",
        "## AI Auto-Test Results",
        "",
        "- Manifest check: PASS.",
        "- Detail fetch execution: PASS. Command exited with code 0.",
        "- Output validation: PASS. CLI emitted valid JSON summary with `success: 2013`, `failed: 24`, `skipped: 10925`, and `skipped_existing: 10925`.",
        "- Progress validation: PASS. `/tmp/clawhub-scan/daily-2026-04-30/detail-fetch.progress.json` reports `status: completed` and `processed: 12962/12962`.",
        "",
        "## Notes",
        "",
        "- CLI reported 24 per-skill failures internally, but the worker command exited 0 as the authoritative worker-level exit status."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-DETAIL"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult blocked when content starts with a plain BLOCKED marker", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "reports/PRE-FLIGHT.md"
    ]);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: "BLOCKED — PRE-FLIGHT: tool repo is on github-opc-scan-v1/R-01-TOOL instead of main.",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "blocked",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult blocked when final progress text is concatenated before a BLOCKED marker", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "reports/PRE-FLIGHT.md"
    ]);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "The report artifact is updated.",
        "I am doing the final existence check now.BLOCKED — PRE-FLIGHT: python3 is still Python 3.9.6."
      ].join(""),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "blocked",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult blocked when verification progress text precedes a concatenated BLOCKED marker", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "reports/PRE-FLIGHT.md"
    ]);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "The worker file still allows expected-missing criteria when an authoring worker exists.",
        "I am using verification-before-completion for the closeout check because I need evidence from the file existence check.",
        "BLOCKED — PRE-FLIGHT: python3 is still Python 3.9.6."
      ].join(""),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "blocked",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult blocked when a report-only worker finished as BLOCKED", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "reports", "run", "run-001", "PRE-FLIGHT.md");
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# PRE-FLIGHT Completion Report\n\n## Outcome\n\nBLOCKED\n", "utf8");
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      reportPath
    ]);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      run_state: "completed",
      content: [
        "PRE-FLIGHT finished as `BLOCKED`.",
        "",
        `Report written to [PRE-FLIGHT.md](${reportPath}).`,
        "",
        "Blocking issue: `/Volumes/Elements/github-ai-automation-solutions` does not exist."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "blocked",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult failed when the worker report contains failure signals", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-CATALOG", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-CATALOG", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      content: [
        "# W-CATALOG Completion Report",
        "",
        "- Result: `⛔ FAILED`",
        "- Exit Code: `1`",
        "",
        "FAIL: manifest missing"
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-CATALOG"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult failed when a report has failed status and non-zero exit code", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-CATALOG", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-CATALOG", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      content: [
        "# W-CATALOG Completion Report",
        "",
        "- Status: FAILED",
        "- Exit code: 1",
        "",
        "No JSON summary output was produced because startup failed."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-CATALOG"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult failed when a report outcome says fail with a stop marker", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      content: [
        "# PRE-FLIGHT Report",
        "",
        "## Outcome",
        "",
        "⛔ FAIL",
        "",
        "python3 is below the required version."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult failed when final text reports auto-test failure", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-CATALOG", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("W-CATALOG", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      content: [
        "W-CATALOG stopped on the same startup failure after re-checking current state.",
        "",
        "Exit code: `1`",
        "",
        "Auto-tests failed because no manifest was created:",
        "- manifest exists: fail",
        "- valid JSON array: fail"
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-CATALOG"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult failed when final text says the command failed with an exit code", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-DETAIL", "worker-thread-222", "22222222-2222-4222-8222-222222222222", []);

    harness.store.recordWorkerResult("W-DETAIL", buildHubResult({
      thread_id: "worker-thread-222",
      status: "success",
      content: [
        "`W-DETAIL` did not complete.",
        "The command failed with exit code `1` before any JSON summary was produced.",
        "Error: better_sqlite3.node was compiled against a different Node.js version."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-DETAIL"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("does not fail a success HubResult that documents expected exit code handling", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-02", "worker-thread-222", "22222222-2222-4222-8222-222222222222", []);

    harness.store.recordWorkerResult("N-02", buildHubResult({
      thread_id: "worker-thread-222",
      status: "success",
      run_state: "completed",
      content: [
        "# N-02 Report — Bundled script permission fix",
        "",
        "- Status: Verified already delivered on `main`",
        "- Exit code `126` emits the specific user-visible error:",
        "  `Script permission denied — attempted auto-fix, please retry`",
        "- `cargo check` passed."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-02"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("does not fail success reports that document negative cases", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-CATALOG", "worker-thread-333", "33333333-3333-4333-8333-333333333333", []);

    harness.store.recordWorkerResult("W-CATALOG", buildHubResult({
      thread_id: "worker-thread-333",
      status: "success",
      run_state: "completed",
      content: [
        "# W-CATALOG Completion Report",
        "",
        "- Status: ✅ Complete",
        "- Verified manifest missing error handling is surfaced to the user.",
        "- No AI auto-tests failed.",
        "- The prior cannot proceed path no longer occurs.",
        "- Regression coverage documents command failed with exit code `1` copy."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["W-CATALOG"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("does not fail a success HubResult because prompt instructions in details_text mention failures", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("R-01", "worker-thread-444", "44444444-4444-4444-8444-444444444444", []);

    harness.store.recordWorkerResult("R-01", buildHubResult({
      thread_id: "worker-thread-444",
      status: "success",
      run_state: "completed",
      content: [
        "R-01 is already merged on `main` via PR #155.",
        "",
        "Verification run:",
        "- `npm run client:typecheck` passed",
        "- `cargo check` passed",
        "- Git delivery self-test passed"
      ].join("\n"),
      summary_text: [
        "R-01 is already merged on `main` via PR #155.",
        "Verification passed."
      ].join("\n"),
      details_text: [
        "Your message:",
        "If you encounter an environment problem (missing tool, broken `cargo check`), **do not silently work around it**. Report `⛔ BLOCKED` with the exact error.",
        "If any test fails OR any assertion is not satisfied, do NOT proceed to commit — fix and re-run, or stop with `⛔ BLOCKED` if the issue is out of your scope.",
        "- **A dependency you thought was `✅` turns out broken**: stop. Mark `⛔ BLOCKED — <DEP_ID> regressed`.",
        "",
        "Agent reply:",
        "R-01 is already merged on `main` via PR #155.",
        "Verification passed."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["R-01"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks a success HubResult failed when content requests read permission", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("DISPATCHER", "dispatcher-thread", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("DISPATCHER", buildHubResult({
      thread_id: "dispatcher-thread",
      status: "success",
      content: "I need permission to read the dispatch command file. Could you grant read access?",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers.DISPATCHER).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("defers dev_history-only outputs until reconciled", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("R-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "dev_history/v1_round/R-01_report.md"
    ]);

    harness.store.recordWorkerResult("R-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["R-01"]).toMatchObject({
      status: "running",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("completes immediately when a deferred-success result reports a real completion artifact", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "dev_history", "v1_round", "R-02_report.md");
    harness.store.recordWorkerStart("R-02", "worker-thread-222", "22222222-2222-4222-8222-222222222222", [
      "dev_history/v1_round/R-02_report.md"
    ]);
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# R-02 Completion Report\n", "utf8");

    harness.store.recordWorkerResult("R-02", buildHubResult({
      thread_id: "worker-thread-222",
      status: "success",
      content: `Completed successfully. Report written to ${reportPath}`,
      timestamp: "2026-04-03T12:05:00.000Z"
    }));

    expect(harness.store.load().workers["R-02"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:05:00.000Z"
    });
  });

  it("completes immediately when a deferred-success result reports a real completion artifact with a URI fragment", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "dev_history", "v1_round", "R-03_report.md");
    harness.store.recordWorkerStart("R-03", "worker-thread-333", "33333333-3333-4333-8333-333333333333", [
      "dev_history/v1_round/R-03_report.md"
    ]);
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# R-03 Completion Report\n", "utf8");

    harness.store.recordWorkerResult("R-03", buildHubResult({
      thread_id: "worker-thread-333",
      status: "success",
      content: `Completed successfully. Report written to [R-03_report.md](${reportPath}#L1)`,
      timestamp: "2026-04-03T12:06:00.000Z"
    }));

    expect(harness.store.load().workers["R-03"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:06:00.000Z"
    });
  });

  it("marks workers as abandoned", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.markAbandoned("N-01", "thread missing after restart");

    expect(harness.store.load().workers["N-01"]?.status).toBe("abandoned");
  });

  it("renders skipped workers as ⛔ SKIPPED in the dispatch plan", async () => {
    const harness = await createHarness({
      dispatchPlanPath: path.join(tmpdir(), "meridian-roles-custom-plan", `dispatch-plan-skipped-${Date.now()}.md`),
      planTemplate: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| 🔄 | 5 | R-06 | Recovery row |",
        ""
      ].join("\n")
    });

    harness.store.recordWorkerStart("R-06", "worker-thread-666", "66666666-6666-4666-8666-666666666666", []);
    harness.store.setWorkerStatus("R-06", "skipped", "manual_skip");

    expect(harness.store.load().workers["R-06"]?.status).toBe("skipped");
    await expect(fsp.readFile(harness.dispatchPlanPath, "utf8")).resolves.toContain("| ⛔ SKIPPED | 5 | R-06 | Recovery row |");
  });

  it("writes the derived dispatch plan to the configured plan path on lifecycle transitions", async () => {
    const harness = await createHarness({
      dispatchPlanPath: path.join(tmpdir(), "meridian-roles-custom-plan", `dispatch_plan-${Date.now()}.md`),
      planTemplate: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ⬜ | 5 | R-05 | Plan row |",
        "| ⬜ | 5 | R-06 | Recovery row |",
        ""
      ].join("\n")
    });

    harness.store.recordWorkerStart("R-05", "worker-thread-555", "55555555-5555-4555-8555-555555555555", []);
    await expect(fsp.readFile(harness.dispatchPlanPath, "utf8")).resolves.toContain("| 🔄 | 5 | R-05 | Plan row |");

    harness.store.recordWorkerResult("R-05", buildHubResult({
      thread_id: "worker-thread-555",
      status: "success",
      timestamp: "2026-04-03T12:05:00.000Z"
    }));
    await expect(fsp.readFile(harness.dispatchPlanPath, "utf8")).resolves.toContain("| ✅ | 5 | R-05 | Plan row |");

    harness.store.recordWorkerStart("R-06", "worker-thread-666", "66666666-6666-4666-8666-666666666666", []);
    harness.store.markAbandoned("R-06", "restart cleanup");

    const markdown = await fsp.readFile(harness.dispatchPlanPath, "utf8");
    expect(markdown).toContain("| ⚠️ ABANDONED | 5 | R-06 | Recovery row |");
    await expect(fsp.access(path.join(harness.directory, "dispatch_plan.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns only workers in the requested lifecycle state", async () => {
    const harness = await createHarness();
    harness.store.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T11:59:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: null,
          started_at: "2026-04-03T12:01:00.000Z",
          last_seen_at: "2026-04-03T12:01:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: buildHubResult({
            thread_id: "worker-thread-222",
            status: "success",
            timestamp: "2026-04-03T12:01:10.000Z"
          }),
          command_preamble: null,
          retry_count: 0
        },
        "N-03": {
          thread_id: "worker-thread-333",
          trace_id: null,
          started_at: "2026-04-03T12:02:00.000Z",
          last_seen_at: "2026-04-03T12:02:00.000Z",
          status: "running",
          expected_outputs: ["test/gui-demo/final.txt"],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    const runningWorkers = harness.store.getWorkersInState("running");

    expect(runningWorkers.map((worker) => worker.worker_id)).toEqual(["N-01", "N-03"]);
    expect(runningWorkers[1]?.expected_outputs).toEqual(["test/gui-demo/final.txt"]);
  });

  it("never exposes partial JSON at the target file path during atomic writes", async () => {
    const harness = await createHarness();
    const priorState = buildEmptyDispatchThreadStateV2();
    harness.store.save(priorState);

    const nextState: DispatchThreadStateV2 = {
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T11:59:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: ["test/gui-demo/final.txt"],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    };

    const observedStates: unknown[] = [];
    const hookedStore = new LifecycleStore(harness.filePath, {
      beforeCommit: (tempFilePath, targetFilePath) => {
        expect(fs.existsSync(tempFilePath)).toBe(true);

        const duringWrite = fs.readFileSync(targetFilePath, "utf8");
        expect(() => JSON.parse(duringWrite)).not.toThrow();
        observedStates.push(JSON.parse(duringWrite));
      }
    });

    hookedStore.save(nextState);

    expect(harness.store.load()).toEqual(nextState);
    expect(observedStates).toEqual([priorState]);
  });

  it("renders plan markdown using lifecycle status symbols", async () => {
    const harness = await createHarness();
    harness.store.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T11:59:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: null,
          started_at: "2026-04-03T12:01:00.000Z",
          last_seen_at: "2026-04-03T12:01:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "N-03": {
          thread_id: "worker-thread-333",
          trace_id: null,
          started_at: "2026-04-03T12:02:00.000Z",
          last_seen_at: "2026-04-03T12:02:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: buildHubResult({
            thread_id: "worker-thread-333",
            status: "success",
            timestamp: "2026-04-03T12:02:10.000Z"
          }),
          command_preamble: null,
          retry_count: 0
        },
        "N-04": {
          thread_id: "worker-thread-444",
          trace_id: null,
          started_at: "2026-04-03T12:03:00.000Z",
          last_seen_at: "2026-04-03T12:03:00.000Z",
          status: "failed",
          expected_outputs: [],
          hub_result: buildHubResult({
            thread_id: "worker-thread-444",
            status: "error",
            content: "worker failed",
            timestamp: "2026-04-03T12:03:10.000Z"
          }),
          command_preamble: null,
          retry_count: 0
        },
        "N-05": {
          thread_id: "worker-thread-555",
          trace_id: null,
          started_at: "2026-04-03T12:04:00.000Z",
          last_seen_at: "2026-04-03T12:04:00.000Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    const markdown = harness.store.toPlanMarkdown([
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task |",
      "|--------|-------|--------|------|",
      "| ⬜ | 1 | N-01 | Pending row |",
      "| ⬜ | 1 | N-02 | Running row |",
      "| ⬜ | 1 | N-03 | Completed row |",
      "| ⬜ | 1 | N-04 | Failed row |",
      "| ⬜ | 1 | N-05 | Abandoned row |",
      ""
    ].join("\n"));

    expect(markdown).toContain("| ⬜ | 1 | N-01 | Pending row |");
    expect(markdown).toContain("| 🔄 | 1 | N-02 | Running row |");
    expect(markdown).toContain("| ✅ | 1 | N-03 | Completed row |");
    expect(markdown).toContain("| ❌ | 1 | N-04 | Failed row |");
    expect(markdown).toContain("| ⚠️ ABANDONED | 1 | N-05 | Abandoned row |");
  });

  it("keeps blocked plan display when the blocked report also contains failure evidence", async () => {
    const harness = await createHarness();
    harness.store.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "N-07": {
          thread_id: "worker-thread-n07",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:01:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: buildHubResult({
            thread_id: "worker-thread-n07",
            status: "success",
            content: [
              "Status: BLOCKED",
              "",
              "The apply command failed with exit code 1 because credentials are missing."
            ].join("\n"),
            timestamp: "2026-04-03T12:01:00.000Z"
          }),
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    const markdown = harness.store.toPlanMarkdown([
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task |",
      "|--------|-------|--------|------|",
      "| ⬜ | 2 | N-07 | Migration 035 |",
      ""
    ].join("\n"));

    expect(markdown).toContain("| ⛔ BLOCKED | 2 | N-07 | Migration 035 |");
    expect(markdown).not.toContain("| ❌ | 2 | N-07 | Migration 035 |");
  });

  it("does not downgrade plan ✅ status when lifecycle state regresses to abandoned", async () => {
    const harness = await createHarness({
      planTemplate: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ⬜ | 1 | N-01 | Test row |",
        ""
      ].join("\n")
    });

    // First, mark worker as completed so the plan shows ✅
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "trace-111", []);
    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:10.000Z"
    }));

    // Verify plan now shows ✅
    const planAfterComplete = fs.readFileSync(harness.dispatchPlanPath, "utf8");
    expect(planAfterComplete).toContain("| ✅ |");

    // Now simulate onRestart setting the worker to abandoned (no hub_result)
    const state = harness.store.load();
    state.workers["N-01"] = {
      ...state.workers["N-01"]!,
      status: "abandoned",
      hub_result: null,
      last_seen_at: "2026-04-03T12:05:00.000Z"
    };
    harness.store.save(state);

    // Plan must still show ✅ — syncPlanView must not downgrade it
    const planAfterAbandoned = fs.readFileSync(harness.dispatchPlanPath, "utf8");
    expect(planAfterAbandoned).toContain("| ✅ |");
    expect(planAfterAbandoned).not.toContain("ABANDONED");
  });

  it("downgrades plan ✅ status when a completed worker is explicitly restarted", async () => {
    const harness = await createHarness({
      planTemplate: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ⬜ | 1 | N-01 | Test row |",
        ""
      ].join("\n")
    });

    harness.store.recordWorkerStart("N-01", "worker-thread-111", "trace-111", []);
    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:10.000Z"
    }));

    const planAfterComplete = fs.readFileSync(harness.dispatchPlanPath, "utf8");
    expect(planAfterComplete).toContain("| ✅ |");

    harness.store.recordWorkerStart("N-01", "worker-thread-222", "trace-222", []);

    const planAfterRestart = fs.readFileSync(harness.dispatchPlanPath, "utf8");
    expect(planAfterRestart).toContain("| 🔄 | 1 | N-01 | Test row |");
  });

  it("syncs a sibling *_dispatch_plan.md file when dispatch_plan.md is not present", async () => {
    const directory = await fsp.mkdtemp(path.join(tmpdir(), "meridian-roles-lifecycle-store-custom-plan-"));
    tempDirectories.add(directory);

    const filePath = path.join(directory, "dispatch_threads.json");
    const dispatchPlanPath = path.join(directory, "cli_shared_core_dispatch_plan.md");
    await fsp.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | batch | worker | task |",
      "|--------|-------|--------|------|",
      "| ⬜ | 0 | PRE-FLIGHT | Environment Health Check |",
      ""
    ].join("\n"), "utf8");

    const store = new LifecycleStore(filePath);
    store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);
    store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check |"
    );
  });

  it("syncs a sibling project -plan.md file when dispatch_plan.md is not present", async () => {
    const directory = await fsp.mkdtemp(path.join(tmpdir(), "meridian-roles-lifecycle-store-hyphen-plan-"));
    tempDirectories.add(directory);

    const filePath = path.join(directory, "dispatch_threads.json");
    const dispatchPlanPath = path.join(directory, "clawhub-skill-scan-plan.md");
    await fsp.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task |",
      "|--------|-------|--------|------|",
      "| ⬜ | 0 | PRE-FLIGHT | Environment Health Check |",
      ""
    ].join("\n"), "utf8");

    const store = new LifecycleStore(filePath);
    store.recordWorkerStart("PRE-FLIGHT", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
      "| 🔄 | 0 | PRE-FLIGHT | Environment Health Check |"
    );
  });

  it("logs structured worker lifecycle transitions", async () => {
    const info = vi.fn();
    const harness = await createHarness({
      log: { info }
    });

    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);
    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));
    harness.store.recordWorkerStart("N-02", "worker-thread-222", "22222222-2222-4222-8222-222222222222", []);
    harness.store.markAbandoned("N-02", "session_manager_restart");

    expect(info).toHaveBeenNthCalledWith(
      1,
      "Lifecycle transition",
      expect.objectContaining({
        event: "worker_transition",
        worker_id: "N-01",
        from_status: "pending",
        to_status: "running",
        trigger: "run_tool_start"
      })
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      "Lifecycle transition",
      expect.objectContaining({
        event: "worker_transition",
        worker_id: "N-01",
        from_status: "running",
        to_status: "completed",
        trigger: "hub_result"
      })
    );
    expect(info).toHaveBeenNthCalledWith(
      4,
      "Lifecycle transition",
      expect.objectContaining({
        event: "worker_transition",
        worker_id: "N-02",
        from_status: "running",
        to_status: "abandoned",
        trigger: "session_manager_restart"
      })
    );
  });

  it("persists validator pass feedback before marking a worker completed", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);
    harness.store.transitionToAwaitingValidation("N-01", 3);

    harness.store.transitionToValidated("N-01", {
      score: 0.92,
      feedback: "Implementation matches the task and tests passed.",
      validatorThreadId: "validator-thread-999"
    });

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "completed",
      validation: {
        current_cycle: 1,
        max_fix_cycles: 3,
        validator_thread_id: null,
        last_score: 0.92,
        last_feedback: "Implementation matches the task and tests passed.",
        history: [
          expect.objectContaining({
            cycle: 1,
            score: 0.92,
            feedback: "Implementation matches the task and tests passed.",
            validator_thread_id: "validator-thread-999"
          })
        ]
      }
    });
  });
});

async function createHarness(options: {
  dispatchPlanPath?: string;
  log?: { info: (...args: unknown[]) => void };
  planTemplate?: string;
} = {}): Promise<{
  directory: string;
  filePath: string;
  dispatchPlanPath: string;
  store: LifecycleStore;
}> {
  const directory = await fsp.mkdtemp(path.join(tmpdir(), "meridian-roles-lifecycle-store-"));
  tempDirectories.add(directory);

  const filePath = path.join(directory, "dispatch_threads.json");
  const dispatchPlanPath = options.dispatchPlanPath ?? path.join(directory, "dispatch_plan.md");

  if (options.dispatchPlanPath) {
    tempDirectories.add(path.dirname(options.dispatchPlanPath));
  }

  if (options.planTemplate) {
    await fsp.mkdir(path.dirname(dispatchPlanPath), { recursive: true });
    await fsp.writeFile(dispatchPlanPath, options.planTemplate, "utf8");
  }

  return {
    directory,
    filePath,
    dispatchPlanPath,
    store: new LifecycleStore(filePath, {
      dispatchPlanPath: options.dispatchPlanPath,
      log: options.log
    })
  };
}

function buildHubResult(overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: overrides.trace_id ?? "11111111-1111-4111-8111-111111111111",
    thread_id: overrides.thread_id ?? "worker-thread-111",
    source: overrides.source ?? "codex",
    status: overrides.status ?? "success",
    run_state: overrides.run_state,
    content: overrides.content ?? "worker finished",
    summary_text: overrides.summary_text,
    details_text: overrides.details_text,
    attachments: overrides.attachments ?? [],
    timestamp: overrides.timestamp ?? "2026-04-03T12:00:00.000Z"
  };
}
