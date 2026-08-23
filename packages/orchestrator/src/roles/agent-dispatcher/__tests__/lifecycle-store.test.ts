import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DispatchThreadStateV2, HubResult } from "../../../types";
import {
  findActivePmResolversForWorker,
  isPmResolverNoProgressStale,
  isValidatorSpawnBackoffActive,
  isWorkerHeartbeatStale,
  LifecycleStore,
  PM_RESOLVER_NO_PROGRESS_STALE_MS,
  VALIDATOR_SPAWN_FAILURE_BACKOFF_MS,
  VALIDATOR_SPAWN_FAILURE_BACKOFF_THRESHOLD,
  WORKER_HEARTBEAT_STALE_THRESHOLD_MS,
  buildEmptyDispatchThreadStateV2
} from "../lifecycle-store";

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

  // Regression: launchDispatchWorker fires the run handoff as a microtask,
  // so dispatch_threads.json had no entry for the worker between
  // continue-dispatcher's "continued: <workerId>" reply and runTool's
  // recordWorkerStart landing — the next dispatcher tick would re-spawn
  // because it saw "no entry". recordWorkerLaunchInitiated closes the race
  // by writing a placeholder synchronously the moment spawn returns.
  it("recordWorkerLaunchInitiated writes a synchronous running placeholder before recordWorkerStart", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerLaunchInitiated("C-01", "worker-thread-launch-init");

    const placeholderState = harness.store.load();
    expect(placeholderState.workers["C-01"]).toMatchObject({
      thread_id: "worker-thread-launch-init",
      status: "running",
      hub_result: null,
      command_preamble: null,
      retry_count: 0
    });

    // runTool.execute eventually calls recordWorkerStart with the full
    // preamble + traceId. That must overwrite the placeholder cleanly
    // without double-incrementing retry_count (placeholder already set
    // status=running, so recordWorkerStart's shouldIncrementRetry path
    // sees previousStatus=running and skips the bump).
    harness.store.recordWorkerStart(
      "C-01",
      "worker-thread-launch-init",
      "22222222-2222-4222-8222-222222222222",
      ["report.md"],
      "# Worker Identity\nC-01"
    );

    const finalState = harness.store.load();
    expect(finalState.workers["C-01"]).toMatchObject({
      thread_id: "worker-thread-launch-init",
      status: "running",
      command_preamble: "# Worker Identity\nC-01",
      expected_outputs: ["report.md"],
      retry_count: 0
    });
  });

  it("recordWorkerLaunchInitiated bumps retry_count when relaunching from a terminal state", async () => {
    const harness = await createHarness();

    // Simulate a worker that previously failed.
    harness.store.recordWorkerStart("C-01", "worker-thread-old", "11111111-1111-4111-8111-111111111111", []);
    harness.store.setWorkerStatus("C-01", "failed", "synthetic_failure");
    expect(harness.store.load().workers["C-01"]?.retry_count ?? 0).toBe(0);

    // Relaunch: placeholder fires first (synchronous in launcher).
    harness.store.recordWorkerLaunchInitiated("C-01", "worker-thread-new");
    expect(harness.store.load().workers["C-01"]?.retry_count).toBe(1);

    // recordWorkerStart afterwards must NOT double-count: it sees
    // previousStatus=running because the placeholder already landed.
    harness.store.recordWorkerStart(
      "C-01",
      "worker-thread-new",
      "33333333-3333-4333-8333-333333333333",
      [],
      "# Worker Identity\nC-01"
    );
    expect(harness.store.load().workers["C-01"]?.retry_count).toBe(1);
  });

  it("recordWorkerLaunchInitiated is a no-op when a richer recordWorkerStart row already exists for the same thread", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart(
      "C-01",
      "worker-thread-x",
      "44444444-4444-4444-8444-444444444444",
      ["report.md"],
      "# Worker Identity\nC-01"
    );
    const before = harness.store.load();
    const beforePreamble = before.workers["C-01"]?.command_preamble;

    // Race in the other direction: recordWorkerLaunchInitiated fires
    // late and must NOT clobber the richer record.
    harness.store.recordWorkerLaunchInitiated("C-01", "worker-thread-x");

    const after = harness.store.load();
    expect(after.workers["C-01"]?.command_preamble).toBe(beforePreamble);
    expect(after.workers["C-01"]?.expected_outputs).toEqual(["report.md"]);
  });

  it("recordDispatcher synchronizes the DISPATCHER worker row to the active dispatcher thread", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart(
      "DISPATCHER",
      "dispatcher-thread-old",
      "11111111-1111-4111-8111-111111111111",
      ["old-report.md"],
      "# Worker Identity\nDISPATCHER"
    );
    harness.store.recordWorkerResult("DISPATCHER", buildHubResult({
      thread_id: "dispatcher-thread-old",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    harness.store.recordDispatcher("dispatcher-thread-new");

    const state = harness.store.load();
    expect(state.dispatcher).toMatchObject({
      thread_id: "dispatcher-thread-new",
      status: "running"
    });
    expect(state.workers.DISPATCHER).toMatchObject({
      thread_id: "dispatcher-thread-new",
      trace_id: null,
      status: "running",
      expected_outputs: [],
      hub_result: null,
      command_preamble: null,
      retry_count: 0
    });
    expect(state.workers.DISPATCHER?.started_at).toBe(state.dispatcher.started_at);
    expect(state.workers.DISPATCHER?.last_seen_at).toBe(state.dispatcher.started_at);
  });

  it("recordDispatcher keeps a richer DISPATCHER row when the active thread already matches", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart(
      "DISPATCHER",
      "dispatcher-thread-same",
      "22222222-2222-4222-8222-222222222222",
      ["report.md"],
      "# Worker Identity\nDISPATCHER"
    );

    harness.store.recordDispatcher("dispatcher-thread-same");

    const state = harness.store.load();
    expect(state.dispatcher).toMatchObject({
      thread_id: "dispatcher-thread-same",
      status: "running"
    });
    expect(state.workers.DISPATCHER).toMatchObject({
      thread_id: "dispatcher-thread-same",
      trace_id: "22222222-2222-4222-8222-222222222222",
      status: "running",
      expected_outputs: ["report.md"],
      command_preamble: "# Worker Identity\nDISPATCHER"
    });
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

  it("trusts a fresh clean output report over narrative block phrases (e.g. 'smoke is blocked by … switching to …')", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "reports", "N-12.md");
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });

    harness.store.recordWorkerStart(
      "N-12",
      "worker-thread-n12",
      "11111111-1111-4111-8111-111111111111",
      [reportPath]
    );

    await fsp.writeFile(reportPath, [
      "# N-12 Completion Report",
      "",
      "## Summary",
      "",
      "- Worker: N-12",
      "- Result: passed",
      "",
      "## Validation",
      "",
      "All seven tables created with RLS enabled."
    ].join("\n"), "utf8");

    harness.store.recordWorkerResult("N-12", buildHubResult({
      thread_id: "worker-thread-n12",
      status: "success",
      run_state: "completed",
      content: [
        "The worker's literal `SELECT 0 FROM table LIMIT 0` smoke is blocked by the repo's query wrapper allowlist, not by the migration.",
        "I'm switching to the wrapper-supported `SELECT count(*) FROM <table>` smoke form so validation stays inside the approved remote contract.",
        "",
        "N-12 is complete and merged."
      ].join("\n"),
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-12"]).toMatchObject({
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

  it("reaps a running worker into failed with markWorkerReaped", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-06", "worker-thread-stuck", "11111111-1111-4111-8111-111111111111", []);

    harness.store.markWorkerReaped(
      "W-06",
      "watchdog_reaped: heartbeat_stale; agentapi_process_missing; hub_status=missing"
    );

    expect(harness.store.load().workers["W-06"]?.status).toBe("failed");
  });

  it("markWorkerReaped is idempotent on non-running workers", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("W-07", "worker-thread-done", "22222222-2222-4222-8222-222222222222", []);
    harness.store.setWorkerStatus("W-07", "completed", "test_setup");

    harness.store.markWorkerReaped("W-07", "should-not-apply");

    expect(harness.store.load().workers["W-07"]?.status).toBe("completed");
  });

  it("markWorkerReaped throws when worker is unknown", async () => {
    const harness = await createHarness();
    expect(() => harness.store.markWorkerReaped("MISSING", "x"))
      .toThrowError(/Worker not found/);
  });

  it("isWorkerHeartbeatStale returns true when last_seen_at is older than threshold", () => {
    const nowMs = Date.parse("2026-04-03T14:00:00.000Z");
    const worker = {
      started_at: "2026-04-03T08:00:00.000Z",
      last_seen_at: "2026-04-03T13:00:00.000Z",
      status: "running" as const
    };
    expect(isWorkerHeartbeatStale(worker, nowMs)).toBe(true);
  });

  it("isWorkerHeartbeatStale returns false when last_seen_at is recent", () => {
    const nowMs = Date.parse("2026-04-03T14:00:00.000Z");
    const worker = {
      started_at: "2026-04-03T13:55:00.000Z",
      last_seen_at: "2026-04-03T13:59:30.000Z",
      status: "running" as const
    };
    expect(isWorkerHeartbeatStale(worker, nowMs)).toBe(false);
  });

  it("isWorkerHeartbeatStale ignores non-running workers", () => {
    const nowMs = Date.parse("2026-04-03T14:00:00.000Z");
    const worker = {
      started_at: "2026-04-03T08:00:00.000Z",
      last_seen_at: "2026-04-03T08:30:00.000Z",
      status: "completed" as const
    };
    expect(isWorkerHeartbeatStale(worker, nowMs)).toBe(false);
  });

  it("isWorkerHeartbeatStale uses the threshold constant by default", () => {
    const nowMs = Date.parse("2026-04-03T14:00:00.000Z");
    const stillFreshAt = new Date(nowMs - WORKER_HEARTBEAT_STALE_THRESHOLD_MS + 1_000).toISOString();
    const justStaleAt = new Date(nowMs - WORKER_HEARTBEAT_STALE_THRESHOLD_MS - 1_000).toISOString();
    expect(isWorkerHeartbeatStale({
      started_at: stillFreshAt,
      last_seen_at: stillFreshAt,
      status: "running"
    }, nowMs)).toBe(false);
    expect(isWorkerHeartbeatStale({
      started_at: justStaleAt,
      last_seen_at: justStaleAt,
      status: "running"
    }, nowMs)).toBe(true);
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

  it("renders a validator-completed worker as ✅ even when its original hub result was blocked", async () => {
    const harness = await createHarness({
      dispatchPlanPath: path.join(tmpdir(), "meridian-roles-custom-plan", `dispatch-plan-validated-blocked-${Date.now()}.md`),
      planTemplate: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ⛔ BLOCKED | 3 | BATCH-3-GATE | Cross-package gate |",
        "| ⬜ | 7 | N-40 | Downstream UI |",
        ""
      ].join("\n")
    });

    harness.store.recordWorkerStart("BATCH-3-GATE", "worker-thread-333", "33333333-3333-4333-8333-333333333333", []);
    harness.store.recordWorkerResult("BATCH-3-GATE", buildHubResult({
      thread_id: "worker-thread-333",
      status: "success",
      content: "⛔ BLOCKED — gate failed before PM resolved it",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));
    harness.store.transitionToAwaitingValidation("BATCH-3-GATE", 3);
    harness.store.transitionToValidated("BATCH-3-GATE", {
      score: 1,
      feedback: "PM verified the blocker was fixed.",
      validatorThreadId: "validator-thread-333"
    });

    await expect(fsp.readFile(harness.dispatchPlanPath, "utf8")).resolves.toContain("| ✅ | 3 | BATCH-3-GATE | Cross-package gate |");
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

    // Phase A6 introduced a per-decision `lifecycle_signal_source` info log
    // emitted from `recordWorkerResult` AFTER the worker_transition log.
    // Verify the transition events fire by filtering on event name rather
    // than asserting fixed call positions, which keeps the test robust
    // against future observability additions.
    const transitionCalls = info.mock.calls.filter(
      ([message]) => message === "Lifecycle transition"
    );
    expect(transitionCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        event: "worker_transition",
        worker_id: "N-01",
        from_status: "pending",
        to_status: "running",
        trigger: "run_tool_start"
      })
    );
    expect(transitionCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        event: "worker_transition",
        worker_id: "N-01",
        from_status: "running",
        to_status: "completed",
        trigger: "hub_result"
      })
    );
    expect(transitionCalls[3]?.[1]).toEqual(
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

  // Regression: BATCH-3-GATE on dispatcher a9a66025 spawned codex_74 + codex_75
  // both at cycle 1 because a duplicate transitionToAwaitingValidation cleared
  // validator_thread_id while the first validator was still in flight.
  it("increments spawn_failure_count and stamps last_spawn_failure_at on clearValidatorStart", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart("N-25", "worker-thread", "11111111-1111-4111-8111-111111111125", []);
    harness.store.transitionToAwaitingValidation("N-25", 3);
    harness.store.recordValidatorStart("N-25", "validator-thread-1");
    harness.store.clearValidatorStart("N-25", "validator-thread-1");

    const after1 = harness.store.load().workers["N-25"];
    expect(after1?.validation?.spawn_failure_count).toBe(1);
    expect(after1?.validation?.last_spawn_failure_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after1?.validation?.validator_thread_id).toBeNull();

    harness.store.recordValidatorStart("N-25", "validator-thread-2");
    harness.store.clearValidatorStart("N-25", "validator-thread-2");

    const after2 = harness.store.load().workers["N-25"];
    expect(after2?.validation?.spawn_failure_count).toBe(2);
  });

  it("resets spawn_failure_count and last_spawn_failure_at when a validator successfully decides", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart("N-25", "worker-thread", "11111111-1111-4111-8111-111111111125", []);
    harness.store.transitionToAwaitingValidation("N-25", 3);
    harness.store.recordValidatorStart("N-25", "validator-thread-1");
    harness.store.clearValidatorStart("N-25", "validator-thread-1");
    harness.store.recordValidatorStart("N-25", "validator-thread-2");
    harness.store.clearValidatorStart("N-25", "validator-thread-2");

    expect(harness.store.load().workers["N-25"]?.validation?.spawn_failure_count).toBe(2);

    // A successful validator verdict means future failures shouldn't compound
    // on top of pre-success failures — the loop is no longer broken.
    harness.store.transitionToValidated("N-25", {
      score: 0.95,
      feedback: "looks good",
      validatorThreadId: "validator-thread-3"
    });

    const after = harness.store.load().workers["N-25"];
    expect(after?.validation?.spawn_failure_count).toBe(0);
    expect(after?.validation?.last_spawn_failure_at).toBeNull();
  });

  it("isValidatorSpawnBackoffActive flags workers with N+ failures inside the backoff window", () => {
    const now = Date.parse("2026-05-04T10:00:00.000Z");

    expect(
      isValidatorSpawnBackoffActive(
        {
          spawn_failure_count: VALIDATOR_SPAWN_FAILURE_BACKOFF_THRESHOLD,
          last_spawn_failure_at: new Date(now - 60_000).toISOString()
        },
        now
      )
    ).toBe(true);

    expect(
      isValidatorSpawnBackoffActive(
        {
          spawn_failure_count: VALIDATOR_SPAWN_FAILURE_BACKOFF_THRESHOLD - 1,
          last_spawn_failure_at: new Date(now - 60_000).toISOString()
        },
        now
      )
    ).toBe(false);

    expect(
      isValidatorSpawnBackoffActive(
        {
          spawn_failure_count: VALIDATOR_SPAWN_FAILURE_BACKOFF_THRESHOLD,
          last_spawn_failure_at: new Date(now - VALIDATOR_SPAWN_FAILURE_BACKOFF_MS - 1_000).toISOString()
        },
        now
      )
    ).toBe(false);

    expect(
      isValidatorSpawnBackoffActive(
        { spawn_failure_count: 0, last_spawn_failure_at: null },
        now
      )
    ).toBe(false);

    expect(isValidatorSpawnBackoffActive(undefined, now)).toBe(false);
  });

  it("does not clear validator_thread_id when re-entering awaiting_validation while a validator is in flight", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart("BATCH-3-GATE", "worker-thread-72", "11111111-1111-4111-8111-111111111111", []);
    harness.store.transitionToAwaitingValidation("BATCH-3-GATE", 3);
    harness.store.recordValidatorStart("BATCH-3-GATE", "validator-thread-74");

    const before = harness.store.load().workers["BATCH-3-GATE"];
    expect(before?.validation?.validator_thread_id).toBe("validator-thread-74");

    // Simulate the dispatcher's Phase 1 calling intercept again because a
    // late hub_result silently flipped the worker back to "completed".
    harness.store.transitionToAwaitingValidation("BATCH-3-GATE", 3);

    const after = harness.store.load().workers["BATCH-3-GATE"];
    expect(after?.status).toBe("awaiting_validation");
    expect(after?.validation?.validator_thread_id).toBe("validator-thread-74");
  });

  // Regression: PM resolver entry that failed with a Headers Timeout while
  // the worker was blocked must be promoted to "completed" once the worker
  // is later validated. Otherwise downstream consumers treat the timed-out
  // PM as a real worker failure (BATCH-3-GATE codex_73 on a9a66025).
  it("reconciles a previously failed PM resolver to completed when the worker passes validation", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "reports", "BATCH-3-GATE.md");
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# BATCH-3-GATE Report\n\nWorker report.\n", "utf8");

    harness.store.recordWorkerStart("BATCH-3-GATE", "worker-thread-72", "11111111-1111-4111-8111-111111111111", [reportPath]);
    // Worker reaches a blocked state before PM is invoked. This matches the
    // a9a66025 production trace: the worker emitted a block_signal marker,
    // which transitioned status to "blocked", which is what the PM was
    // dispatched to resolve. PM_RESOLVED_TARGET_STATUSES does NOT include
    // "blocked", so the existing recordPmResolverFailure reconcile path
    // leaves the PM as "failed" — which is what we want to verify is
    // rectified once the worker later passes validation.
    harness.store.setWorkerStatus("BATCH-3-GATE", "blocked", "output_artifact:block_signal");

    harness.store.recordPmResolverStart("pm-thread-73", {
      status: "manual_intervention_required",
      workerId: "BATCH-3-GATE",
      message: "manual intervention required: BATCH-3-GATE reported a blocking failure",
      source: "watchdog"
    });
    harness.store.recordPmResolverFailure("pm-thread-73", "Meridian API unreachable: Headers Timeout Error");

    const failedPm = harness.store.load().pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-73");
    expect(failedPm?.status).toBe("failed");
    expect(failedPm?.error).toContain("Headers Timeout Error");

    harness.store.transitionToAwaitingValidation("BATCH-3-GATE", 3);
    harness.store.transitionToValidated("BATCH-3-GATE", {
      score: 1,
      feedback: "PASS",
      validatorThreadId: "validator-thread-74"
    });

    const reconciledPm = harness.store.load().pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-73");
    expect(reconciledPm?.status).toBe("completed");
    expect(reconciledPm?.error).toBeNull();
    expect(reconciledPm?.result?.content).toContain("completed because worker BATCH-3-GATE recovered to completed");

    const report = await fsp.readFile(reportPath, "utf8");
    expect(report).toContain("## Validator Report - BATCH-3-GATE - Cycle 1");
    expect(report).toContain("PASS");
    expect(report).toContain("## PM Resolver Report - BATCH-3-GATE");
    expect(report).toContain("Headers Timeout Error");
  });

  // Regression: after a service restart the previous PM agent process is
  // gone, so the recorded `running` thread_id no longer routes through the
  // Hub. Leaving the entry as `running` permanently blocks worker relaunch
  // because `findActivePmResolversForWorker` reads it as live.
  // `markPmResolverThreadMissing` demotes such entries to `failed` so the
  // dispatcher can resume; the existing reconcile-on-recovery path still
  // promotes them to `completed` if the worker later turns out to have
  // already been resolved before the crash.
  it("demotes a running PM resolver to failed when the Hub thread is missing", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart("C-01", "worker-thread-c01", "11111111-1111-4111-8111-111111111111", []);
    harness.store.setWorkerStatus("C-01", "blocked", "output_artifact:block_signal");
    harness.store.recordPmResolverStart("pm-thread-c01", {
      status: "manual_intervention_required",
      workerId: "C-01",
      message: "manual intervention required: C-01 reported a blocking failure",
      source: "watchdog"
    });

    const beforePm = harness.store.load().pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-c01");
    expect(beforePm?.status).toBe("running");

    harness.store.markPmResolverThreadMissing(
      "pm-thread-c01",
      "service_restart_pm_thread_missing: unknown thread"
    );

    const afterPm = harness.store.load().pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-c01");
    expect(afterPm?.status).toBe("failed");
    expect(afterPm?.error).toContain("service_restart_pm_thread_missing");
    expect(afterPm?.transport_error).toBeNull();
  });

  it("findActivePmResolversForWorker returns only running entries for that worker", async () => {
    const { findActivePmResolversForWorker } = await import("../lifecycle-store");
    const harness = await createHarness();

    harness.store.recordWorkerStart("C-01", "worker-thread-c01", "11111111-1111-4111-8111-111111111111", []);
    harness.store.setWorkerStatus("C-01", "blocked", "output_artifact:block_signal");
    harness.store.recordPmResolverStart("pm-thread-c01", {
      status: "manual_intervention_required",
      workerId: "C-01",
      message: "manual intervention required: C-01 reported a blocking failure",
      source: "watchdog"
    });

    const stateRunning = harness.store.load();
    expect(findActivePmResolversForWorker(stateRunning, "C-01")).toHaveLength(1);
    expect(findActivePmResolversForWorker(stateRunning, "C-01")[0]?.thread_id).toBe("pm-thread-c01");
    expect(findActivePmResolversForWorker(stateRunning, "C-02")).toHaveLength(0);

    harness.store.recordPmResolverFailure("pm-thread-c01", "any failure reason");
    const stateFailed = harness.store.load();
    expect(findActivePmResolversForWorker(stateFailed, "C-01")).toHaveLength(0);
  });

  it("findActivePmResolversForWorker ignores stale no-progress PM resolver entries", () => {
    const startedAt = "2026-04-03T12:00:00.000Z";
    const nowMs = Date.parse(startedAt) + PM_RESOLVER_NO_PROGRESS_STALE_MS;
    const state = {
      ...buildEmptyDispatchThreadStateV2(),
      pm_resolvers: [
        {
          thread_id: "pm-thread-stale-no-progress",
          status: "running" as const,
          started_at: startedAt,
          last_seen_at: startedAt,
          agent_type: "codex" as const,
          model_id: "gpt-5.5 xhigh",
          mode: "bridge" as const,
          auto_approve: true,
          issue: {
            status: "manual_intervention_required" as const,
            worker_id: "C-01",
            message: "manual intervention required",
            error: null,
            source: "watchdog" as const
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    };

    expect(isPmResolverNoProgressStale(state.pm_resolvers[0], nowMs - 1)).toBe(false);
    expect(findActivePmResolversForWorker(state, "C-01", nowMs - 1)).toHaveLength(1);
    expect(isPmResolverNoProgressStale(state.pm_resolvers[0], nowMs)).toBe(true);
    expect(findActivePmResolversForWorker(state, "C-01", nowMs)).toHaveLength(0);
  });

  it("appends PM resolver replies to the target worker report", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "reports", "N-57.md");
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# N-57 Report\n\nWorker report.\n", "utf8");

    harness.store.recordWorkerStart("N-57", "worker-thread-n57", "11111111-1111-4111-8111-111111111111", [reportPath]);
    harness.store.setWorkerStatus("N-57", "blocked", "test_blocked");
    harness.store.recordPmResolverStart("pm-thread-n57", {
      status: "manual_intervention_required",
      workerId: "N-57",
      message: "manual intervention required: N-57 claimed completion without expected outputs",
      source: "watchdog"
    });
    harness.store.recordPmResolverResult("pm-thread-n57", {
      status: "success",
      content: "Resolved N-57 by verifying the report and marking it complete.",
      raw: {
        trace_id: "pm-trace-n57",
        timestamp: "2026-05-05T20:36:01.550Z"
      }
    });

    const report = await fsp.readFile(reportPath, "utf8");
    expect(report).toContain("Worker report.");
    expect(report).toContain("## PM Resolver Report - N-57");
    expect(report).toContain("Resolved N-57 by verifying the report and marking it complete.");
  });

  it("finalizes a running PM resolver when its target worker is manually completed", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "reports", "BATCH-7-GATE.md");
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# BATCH-7-GATE Report\n\nWorker report.\n", "utf8");

    harness.store.recordWorkerStart(
      "BATCH-7-GATE",
      "worker-thread-b7",
      "11111111-1111-4111-8111-111111111111",
      [reportPath]
    );
    harness.store.setWorkerStatus("BATCH-7-GATE", "blocked", "needs_pm");
    harness.store.recordPmResolverStart("pm-thread-b7", {
      status: "manual_intervention_required",
      workerId: "BATCH-7-GATE",
      message: "manual intervention required: BATCH-7-GATE requested PM resolution",
      source: "watchdog"
    });

    harness.store.setWorkerStatus("BATCH-7-GATE", "completed", "update_status_tool");

    const pmResolver = harness.store.load().pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-b7");
    expect(pmResolver?.status).toBe("completed");
    expect(pmResolver?.error).toBeNull();
    expect(pmResolver?.result?.content).toContain("completed because worker BATCH-7-GATE recovered to completed");
  });

  // Regression: PM that successfully called `resume-worker --action retry`
  // moves the worker back to `pending` and then the run wrapper times out
  // before the PM can emit a final marker. Without `pending` in
  // PM_RESOLVED_TARGET_STATUSES, the PM entry stays `running`,
  // `findActivePmResolversForWorker` keeps the relaunch gate closed, and the
  // dispatcher deadlocks on the next continue tick until a service restart
  // probes the dead PM thread (BATCH-7-GATE on agent-dispatcher-9fd97803).
  it("reconciles a running PM resolver to completed when the worker is reset to pending for retry", async () => {
    const harness = await createHarness();
    const reportPath = path.join(harness.directory, "reports", "BATCH-7-GATE.md");
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# BATCH-7-GATE Report\n\nAttempt 1 worker report.\n", "utf8");

    harness.store.recordWorkerStart(
      "BATCH-7-GATE",
      "worker-thread-b7",
      "11111111-1111-4111-8111-111111111111",
      [reportPath]
    );
    harness.store.setWorkerStatus("BATCH-7-GATE", "blocked", "needs_pm");
    harness.store.recordPmResolverStart("pm-thread-b7", {
      status: "manual_intervention_required",
      workerId: "BATCH-7-GATE",
      message: "manual intervention required: BATCH-7-GATE requested PM resolution",
      source: "watchdog"
    });

    // PM has called `resume-worker --action retry` which resets the worker
    // back to pending so the dispatcher can relaunch it. The PM run wrapper
    // never received a terminal marker (token cap / hub disconnect), so the
    // PM entry is still recorded as `running`.
    harness.store.setWorkerStatus("BATCH-7-GATE", "pending", "resume_worker:retry", {
      clearHubResult: true
    });

    const pmResolver = harness.store.load().pm_resolvers?.find((entry) => entry.thread_id === "pm-thread-b7");
    expect(pmResolver?.status).toBe("completed");
    expect(pmResolver?.error).toBeNull();
    expect(pmResolver?.result?.content).toContain("completed because worker BATCH-7-GATE recovered to pending");
  });

  // ─── MeridianStatusMarker primary-signal tests (Phase A, Task A2) ────────
  describe("MeridianStatusMarker primary signal", () => {
    it("marks worker completed when marker says complete and the expected report file is fresh, despite narrative block phrases", async () => {
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "N-12.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "N-12",
        "worker-thread-n12",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      await fsp.writeFile(reportPath, [
        "# N-12 Completion Report",
        "",
        "## Summary",
        "",
        "- Worker: N-12",
        "- Result: passed"
      ].join("\n"), "utf8");

      harness.store.recordWorkerResult("N-12", buildHubResult({
        thread_id: "worker-thread-n12",
        status: "success",
        run_state: "completed",
        content: [
          "The worker's literal SELECT smoke is blocked by the wrapper allowlist, switching to a different probe.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-12",
          "outcome: complete",
          `report_path: ${reportPath}`,
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-12"]).toMatchObject({
        status: "completed",
        last_seen_at: "2026-04-03T12:00:00.000Z"
      });
    });

    it("keeps worker running when marker says complete but expected output file is missing", async () => {
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "N-12.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "N-12",
        "worker-thread-n12",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );
      // Intentionally do NOT write the report file. Marker is a claim only.

      harness.store.recordWorkerResult("N-12", buildHubResult({
        thread_id: "worker-thread-n12",
        status: "success",
        run_state: "completed",
        content: [
          "Done.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-12",
          "outcome: complete",
          `report_path: ${reportPath}`,
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-12"]).toMatchObject({
        status: "running"
      });
    });

    it("marks worker completed when marker says complete and there are no expected outputs at all", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "PRE-FLIGHT",
        "worker-thread-pf",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
        thread_id: "worker-thread-pf",
        status: "success",
        run_state: "completed",
        content: [
          "All checks passed.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: PRE-FLIGHT",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["PRE-FLIGHT"]).toMatchObject({
        status: "completed"
      });
    });

    it("marks worker blocked when marker says blocked even if hub envelope reports success and outputs look fine", async () => {
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "N-13.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "N-13",
        "worker-thread-n13",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      await fsp.writeFile(reportPath, [
        "# N-13 Report",
        "",
        "- Result: passed"
      ].join("\n"), "utf8");

      harness.store.recordWorkerResult("N-13", buildHubResult({
        thread_id: "worker-thread-n13",
        status: "success",
        run_state: "completed",
        content: [
          "Wrote report. Looks fine.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-13",
          "outcome: blocked",
          "notes: dependency missing",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-13"]).toMatchObject({
        status: "blocked"
      });
    });

    it("marks worker failed when marker says failed", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "N-14",
        "worker-thread-n14",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-14", buildHubResult({
        thread_id: "worker-thread-n14",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-14",
          "outcome: failed",
          "error: assertion failed",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-14"]).toMatchObject({
        status: "failed"
      });
    });

    it("marks worker failed when marker says hit_limit", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "N-15",
        "worker-thread-n15",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-15", buildHubResult({
        thread_id: "worker-thread-n15",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-15",
          "outcome: hit_limit",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-15"]).toMatchObject({
        status: "failed"
      });
    });

    it("marks worker blocked when marker says needs_pm so service-continuation routes it to PM", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "N-16",
        "worker-thread-n16",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-16", buildHubResult({
        thread_id: "worker-thread-n16",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-16",
          "outcome: needs_pm",
          "notes: cannot proceed without PM input",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-16"]).toMatchObject({
        status: "blocked"
      });
    });

    it("falls through to existing block heuristic when no marker is present", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "N-17",
        "worker-thread-n17",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-17", buildHubResult({
        thread_id: "worker-thread-n17",
        status: "success",
        content: "⛔ BLOCKED — Cannot write to dispatch_plan.md, sandbox restriction",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-17"]).toMatchObject({
        status: "blocked"
      });
    });

    it("ignores a marker whose worker_id mismatches the launched worker, falls through to heuristics, and emits lifecycle.marker_mismatch log", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info } });

      harness.store.recordWorkerStart(
        "N-18",
        "worker-thread-n18",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-18", buildHubResult({
        thread_id: "worker-thread-n18",
        status: "success",
        content: [
          "⛔ BLOCKED — sandbox restriction",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-99",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-18"]).toMatchObject({
        status: "blocked"
      });

      expect(info).toHaveBeenCalledWith("Lifecycle marker mismatch", {
        event: "marker_mismatch",
        worker_id: "N-18",
        marker_worker_id: "N-99",
        marker_role: "worker"
      });
    });

    it("ignores a marker with role validator (wrong role for worker context) and falls through to heuristics", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "N-19",
        "worker-thread-n19",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-19", buildHubResult({
        thread_id: "worker-thread-n19",
        status: "success",
        content: [
          "⛔ BLOCKED — sandbox restriction",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: validator",
          "worker_id: N-19",
          "outcome: pass",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-19"]).toMatchObject({
        status: "blocked"
      });
    });

    it("trusts a complete marker even when narrative incidentally mentions 'hit limit'", async () => {
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "N-30.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });
      harness.store.recordWorkerStart("N-30", "worker-thread-n30", "11111111-1111-4111-8111-111111111111", [reportPath]);
      await fsp.writeFile(reportPath, "# N-30 Report\nDone.\n", "utf8");

      harness.store.recordWorkerResult("N-30", buildHubResult({
        thread_id: "worker-thread-n30",
        status: "success",
        run_state: "completed",
        content: [
          "Carefully avoided the token limit by streaming output.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: N-30",
          "role: worker",
          "outcome: complete",
          `report_path: ${reportPath}`,
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-30"]).toMatchObject({ status: "completed" });
    });

    it("emits lifecycle.marker_decision log when a worker marker is honoured", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info } });
      harness.store.recordWorkerStart(
        "N-31",
        "worker-thread-n31",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-31", buildHubResult({
        thread_id: "worker-thread-n31",
        status: "success",
        run_state: "completed",
        content: [
          "All checks passed.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: N-31",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-31"]).toMatchObject({ status: "completed" });
      expect(info).toHaveBeenCalledWith("Lifecycle decided via marker", {
        event: "marker_decision",
        worker_id: "N-31",
        outcome: "complete"
      });
    });

    it("emits lifecycle.marker_wrong_role log when a validator-role marker lands in the worker channel", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info } });
      harness.store.recordWorkerStart(
        "N-20",
        "worker-thread-n20",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-20", buildHubResult({
        thread_id: "worker-thread-n20",
        status: "success",
        content: [
          "⛔ BLOCKED — sandbox restriction",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: validator",
          "worker_id: N-20",
          "outcome: pass",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      // Heuristic chain still runs (worker stays on its inferred status), and
      // the wrong-role event is logged exactly once with the expected payload.
      expect(harness.store.load().workers["N-20"]).toMatchObject({
        status: "blocked"
      });

      expect(info).toHaveBeenCalledWith("Lifecycle marker wrong role", {
        event: "marker_wrong_role",
        worker_id: "N-20",
        marker_role: "validator",
        marker_worker_id: "N-20"
      });
    });
  });

  describe("Phase A6: heuristic fallback gate", () => {
    it("uses block heuristic when no marker is present and the gate is ON (backwards-compat)", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: true });
      harness.store.recordWorkerStart(
        "A6-01",
        "worker-thread-a6-01",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("A6-01", buildHubResult({
        thread_id: "worker-thread-a6-01",
        status: "success",
        content: "⛔ BLOCKED — sandbox denied write access to dispatch_plan.md",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["A6-01"]).toMatchObject({ status: "blocked" });
    });

    it("returns running (reconciler-retry default) when no marker is present and the gate is OFF", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: false });
      // Worker has expected outputs that have NOT been produced — trivial
      // success branch cannot fire, so the gate-off path must default to
      // "running" rather than running the block heuristic.
      const reportPath = path.join(harness.directory, "reports", "A6-02-missing.md");
      harness.store.recordWorkerStart(
        "A6-02",
        "worker-thread-a6-02",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      harness.store.recordWorkerResult("A6-02", buildHubResult({
        thread_id: "worker-thread-a6-02",
        status: "success",
        content: "⛔ BLOCKED — sandbox denied write access to dispatch_plan.md",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      // Heuristic skipped → reconciler-eligible "running" status.
      expect(harness.store.load().workers["A6-02"]).toMatchObject({ status: "running" });
    });

    it("still maps envelope status=error to failed even when the gate is OFF (envelope short-circuit)", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: false });
      harness.store.recordWorkerStart(
        "A6-03",
        "worker-thread-a6-03",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("A6-03", buildHubResult({
        thread_id: "worker-thread-a6-03",
        status: "error",
        content: "hub disconnected",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["A6-03"]).toMatchObject({ status: "failed" });
    });

    it("still maps envelope timeout to running even when the gate is OFF (envelope short-circuit)", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: false });
      harness.store.recordWorkerStart(
        "A6-04",
        "worker-thread-a6-04",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("A6-04", buildHubResult({
        thread_id: "worker-thread-a6-04",
        status: "timeout",
        content: "relay timed out",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["A6-04"]).toMatchObject({ status: "running" });
    });

    it("trusts the marker when the gate is OFF — marker still wins regardless of heuristic state", async () => {
      const harness = await createHarness({ fallbackHeuristicsEnabled: false });
      harness.store.recordWorkerStart(
        "A6-05",
        "worker-thread-a6-05",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("A6-05", buildHubResult({
        thread_id: "worker-thread-a6-05",
        status: "success",
        run_state: "completed",
        content: [
          "All clear.",
          "",
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: A6-05",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["A6-05"]).toMatchObject({ status: "completed" });
    });

    it("emits lifecycle_signal_source=marker when a worker marker is honoured", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info }, fallbackHeuristicsEnabled: true });
      harness.store.recordWorkerStart(
        "A6-06",
        "worker-thread-a6-06",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("A6-06", buildHubResult({
        thread_id: "worker-thread-a6-06",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "role: worker",
          "worker_id: A6-06",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(info).toHaveBeenCalledWith("Lifecycle signal source", {
        event: "lifecycle_signal_source",
        worker_id: "A6-06",
        signal_source: "marker",
        result: "completed"
      });
    });

    it("emits lifecycle_signal_source=heuristic when no marker fires but the gate is ON", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info }, fallbackHeuristicsEnabled: true });
      harness.store.recordWorkerStart(
        "A6-07",
        "worker-thread-a6-07",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("A6-07", buildHubResult({
        thread_id: "worker-thread-a6-07",
        status: "success",
        content: "⛔ BLOCKED — sandbox restriction",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(info).toHaveBeenCalledWith("Lifecycle signal source", {
        event: "lifecycle_signal_source",
        worker_id: "A6-07",
        signal_source: "heuristic",
        result: "blocked"
      });
    });

    it("emits lifecycle_signal_source=none when no marker fires and the gate is OFF", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info }, fallbackHeuristicsEnabled: false });
      const reportPath = path.join(harness.directory, "reports", "A6-08-missing.md");
      harness.store.recordWorkerStart(
        "A6-08",
        "worker-thread-a6-08",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      harness.store.recordWorkerResult("A6-08", buildHubResult({
        thread_id: "worker-thread-a6-08",
        status: "success",
        content: "⛔ BLOCKED — sandbox restriction",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(info).toHaveBeenCalledWith("Lifecycle signal source", {
        event: "lifecycle_signal_source",
        worker_id: "A6-08",
        signal_source: "none",
        result: "running"
      });
    });

    it("completes a no-expected-outputs success even when fallback heuristics are disabled (envelope short-circuit)", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info }, fallbackHeuristicsEnabled: false });
      // Empty expected_outputs — light worker that emits no marker. Without
      // this short-circuit a regression that swapped the trivial-success
      // branch to "running" unconditionally would silently break this path.
      harness.store.recordWorkerStart(
        "N-A6",
        "worker-thread-na6",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("N-A6", buildHubResult({
        thread_id: "worker-thread-na6",
        status: "success",
        run_state: "completed",
        content: "Done. No marker emitted.",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-A6"]).toMatchObject({ status: "completed" });
      expect(info).toHaveBeenCalledWith("Lifecycle signal source", {
        event: "lifecycle_signal_source",
        worker_id: "N-A6",
        signal_source: "envelope",
        result: "completed"
      });
    });

    it("emits lifecycle_signal_source=envelope when envelope status=error short-circuits", async () => {
      const info = vi.fn();
      const harness = await createHarness({ log: { info }, fallbackHeuristicsEnabled: true });
      harness.store.recordWorkerStart(
        "A6-09",
        "worker-thread-a6-09",
        "11111111-1111-4111-8111-111111111111",
        []
      );

      harness.store.recordWorkerResult("A6-09", buildHubResult({
        thread_id: "worker-thread-a6-09",
        status: "error",
        content: "hub disconnected",
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(info).toHaveBeenCalledWith("Lifecycle signal source", {
        event: "lifecycle_signal_source",
        worker_id: "A6-09",
        signal_source: "envelope",
        result: "failed"
      });
    });
  });

  describe("output artifact block signal scoping to current attempt", () => {
    it("completes a worker when the report has historical BLOCKED text from earlier attempts but the current attempt section is clean", async () => {
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "N-60.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "N-60",
        "worker-thread-n60",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      // Derive timestamps relative to the actual started_at set by the store.
      const startedAtMs = Date.parse(harness.store.load().workers["N-60"]!.started_at!);
      const beforeIso = new Date(startedAtMs - 3600_000).toISOString(); // 1 hour before
      const afterIso = new Date(startedAtMs + 1000).toISOString();      // 1 second after

      const historicalSection = [
        `## Attempt 1 — ${beforeIso} — role: worker`,
        "",
        "Outcome: BLOCKED before implementation.",
        ""
      ].join("\n");

      const currentSection = [
        `## Attempt 2 — ${afterIso} — role: worker`,
        "",
        "PR #308 merged. Work complete.",
        "Git delivery: branch pushed, PR merged."
      ].join("\n");

      await fsp.writeFile(reportPath, historicalSection + currentSection, "utf8");

      harness.store.recordWorkerResult("N-60", buildHubResult({
        thread_id: "worker-thread-n60",
        status: "success",
        run_state: "completed",
        source: "output_artifact",
        content: "Recovered N-60 result from output artifact:\n\n" + historicalSection + currentSection,
        timestamp: afterIso
      }));

      expect(harness.store.load().workers["N-60"]).toMatchObject({
        status: "completed"
      });
    });

    it("still flags blocked when the CURRENT attempt section contains a real BLOCKED signal", async () => {
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "N-61.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "N-61",
        "worker-thread-n61",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      const startedAtMs = Date.parse(harness.store.load().workers["N-61"]!.started_at!);
      const beforeIso = new Date(startedAtMs - 3600_000).toISOString();
      const afterIso = new Date(startedAtMs + 1000).toISOString();

      const content = [
        `## Attempt 1 — ${beforeIso} — role: worker`,
        "",
        "Previously: succeeded.",
        "",
        `## Attempt 2 — ${afterIso} — role: worker`,
        "",
        "Outcome: BLOCKED before implementation. Missing dependency."
      ].join("\n");

      await fsp.writeFile(reportPath, content, "utf8");

      harness.store.recordWorkerResult("N-61", buildHubResult({
        thread_id: "worker-thread-n61",
        status: "success",
        run_state: "completed",
        source: "output_artifact",
        content,
        timestamp: afterIso
      }));

      expect(harness.store.load().workers["N-61"]).toMatchObject({
        status: "blocked"
      });
    });

    it("does not treat PASS_WITH_FINDINGS report findings as worker-level block or failure signals", async () => {
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "V-04-A.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "V-04-A",
        "worker-thread-v04a",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      const startedAtMs = Date.parse(harness.store.load().workers["V-04-A"]!.started_at!);
      const beforeIso = new Date(startedAtMs - 1000).toISOString();
      const afterDate = new Date(startedAtMs + 1000);
      const afterTimestamp = afterDate.toISOString();
      const afterIso = new Date(afterDate.getTime() + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");

      const content = [
        `## Attempt 0 - ${beforeIso} - role: worker`,
        "",
        "# V-04-A Report",
        "",
        "**Result**: BLOCKED",
        "",
        `## Attempt 1 - ${afterIso} - role: worker`,
        "",
        "# V-04-A Report",
        "",
        "## Decision",
        "",
        "PASS_WITH_FINDINGS.",
        "",
        "## Findings",
        "",
        "| ID | Severity | Summary | Status |",
        "| --- | --- | --- | --- |",
        "| F-V04-A-16 | P1 | Real transactional email send failed because the provider domain is unverified. | Open |",
        "",
        "## Sub-Task Evidence Matrix",
        "",
        "| Phase A item | Result | Evidence |",
        "| --- | --- | --- |",
        "| Email render parity | PASS_WITH_FINDINGS | Local render parity passed; transactional send was blocked by Resend domain verification. |"
      ].join("\n");

      await fsp.writeFile(reportPath, content, "utf8");

      harness.store.recordWorkerResult("V-04-A", buildHubResult({
        thread_id: "worker-thread-v04a",
        status: "success",
        run_state: "completed",
        source: "output_artifact",
        content,
        timestamp: afterTimestamp
      }));

      expect(harness.store.load().workers["V-04-A"]).toMatchObject({
        status: "completed"
      });
    });

    it("honors a worker's `outcome: complete` MERIDIAN-STATUS marker over narrative failure words in the same attempt", async () => {
      // Regression: clawso C-01 on dispatcher 9fd97803 (2026-05-09). The
      // worker emitted a clean `<<<MERIDIAN-STATUS>>> outcome: complete`
      // marker (wrapped in a ```text fence in the report file). The
      // current-attempt slice still contained the worker's TDD-narrative
      // phrase "fixture validation failed", which tripped the broad
      // `\bvalidation failed\b` regex and the synthesized output_artifact
      // hub_result was classified `failed`. Worker stayed `failed` even
      // though it had shipped the work. The marker is the worker's
      // structured claim and must win over the narrative regex.
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "C-01.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "C-01",
        "codex_06",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      const startedAtMs = Date.parse(harness.store.load().workers["C-01"]!.started_at!);
      const beforeIso = new Date(startedAtMs - 60_000).toISOString();
      const afterIso = new Date(startedAtMs + 60_000).toISOString();

      const content = [
        `## Attempt 1 - ${beforeIso} - role: worker`,
        "",
        "Outcome: blocked — dirty working tree.",
        "",
        `## Attempt 3 - ${afterIso} - role: worker`,
        "",
        "TDD red step: fixture validation failed before the schema existed.",
        "Green step: added the schema and re-ran fixtures; all green.",
        "",
        "## Reply marker",
        "",
        "```text",
        "<<<MERIDIAN-STATUS>>>",
        "worker_id: C-01",
        "role: worker",
        "outcome: complete",
        `report_path: ${reportPath}`,
        "notes: shipped",
        "<<<END>>>",
        "```"
      ].join("\n");

      await fsp.writeFile(reportPath, content, "utf8");

      harness.store.recordWorkerResult("C-01", buildHubResult({
        thread_id: "codex_06",
        status: "success",
        run_state: "completed",
        source: "output_artifact",
        content,
        timestamp: afterIso
      }));

      expect(harness.store.load().workers["C-01"]).toMatchObject({
        status: "completed"
      });
    });

    it("honors a worker's narrative `### Outcome \\n complete` claim over a 'tool ... exited 1' false-positive in test report prose", async () => {
      // Regression: clawso ranked-data-search-100k R-01 on dispatcher
      // 738fb284 (2026-05-11). The worker shipped (PR merged, commit pushed),
      // wrote a clean report with `### Outcome \n `complete`.`, but did NOT
      // emit a `<<<MERIDIAN-STATUS>>>` marker in the file. The report quoted
      // an audit reporter line:
      //   [audit-bundled-tool-page-app-root] PASS (eslint exited 1 on the negative fixture; ...)
      // which matches the CONTEXTUAL_FAILURE_SIGNAL_PATTERNS regex
      // `\b(?:command|process|script|tool|test|build|check|run)\b...\bexited 1\b`
      // because hyphen-bounded `tool` inside `audit-bundled-tool-page-app-root`
      // is a word match and "exited 1" follows within 80 chars. The benign
      // filter did not recognize "negative fixture" or the "[name] PASS"
      // bracket pattern. PR #186's `## Decision` short-circuit covers
      // validators, PR #191's MERIDIAN-STATUS short-circuit covers workers
      // that emit the marker — but workers writing narrative
      // `### Outcome \n complete` had no structured-claim short-circuit and
      // fell through to the narrative-regex layer. Result: lifecycle flipped
      // `running → failed (output_artifact:failure_signal)`, watchdog killed
      // the worker thread, and a PM resolver was spawned to handle a
      // non-existent block. The worker's own outcome claim must win.
      const harness = await createHarness();
      const reportPath = path.join(harness.directory, "reports", "R-01.md");
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });

      harness.store.recordWorkerStart(
        "R-01",
        "codex_10",
        "11111111-1111-4111-8111-111111111111",
        [reportPath]
      );

      const startedAtIso = harness.store.load().workers["R-01"]!.started_at!;

      const content = [
        "# R-01 Report — Behavior baseline + `FakeDb.rpc` test harness",
        "",
        `## Attempt 1 — ${startedAtIso} — role: worker`,
        "",
        "### Outcome",
        "",
        "`complete`.",
        "",
        "Implemented and shipped R-01 on branch `ranked-data-search-100k/R-01`.",
        "",
        "### Validation",
        "",
        "```text",
        "$ npm run lint:boundaries 2>&1 | tail -15",
        "[audit-bundled-tool-page-app-root] PASS (eslint exited 1 on the negative fixture; output contained \"BundledToolPage\" and the fixture path)",
        "[lint-fixture-namespace.test] PASS",
        "[lint-investigation-isolation.test] PASS",
        "```",
        ""
      ].join("\n");

      await fsp.writeFile(reportPath, content, "utf8");

      harness.store.recordWorkerResult("R-01", buildHubResult({
        thread_id: "codex_10",
        status: "success",
        run_state: "completed",
        source: "output_artifact",
        content,
        timestamp: startedAtIso
      }));

      expect(harness.store.load().workers["R-01"]).toMatchObject({
        status: "completed"
      });
    });
  });

  describe("recordWorkerStart validation history preservation", () => {
    it("preserves validation history across relaunches even when previous status is not fix_requested", async () => {
      // Regression: V-03-A 2026-05-07. The earlier gate keyed on
      // `previousStatus === "fix_requested"` only, so a worker that hit
      // fix_requested → relaunched → abandoned → resume_worker:retry had its
      // entire validation history wiped on the pending → running transition.
      // The operator was left with no record of why the worker had been
      // respawning. Any prior validation context must survive a relaunch.
      const harness = await createHarness();

      harness.store.recordWorkerStart(
        "N-37",
        "codex_45",
        "11111111-1111-4111-8111-111111111111",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );
      harness.store.transitionToFixRequested(
        "N-37",
        0.5,
        "cycle one needs more work",
        "validator-thread-1"
      );

      // Simulate the catastrophic relaunch chain: thread cleared for
      // relaunch, new thread launched, that thread abandons, operator
      // retries via setWorkerStatus(pending) + new recordWorkerStart.
      harness.store.clearWorkerThreadForRelaunch("N-37", "validator_feedback_undeliverable");
      harness.store.recordWorkerStart(
        "N-37",
        "codex_46",
        "22222222-2222-4222-8222-222222222222",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );
      harness.store.markAbandoned("N-37", "thread_missing:no_evidence");
      harness.store.setWorkerStatus("N-37", "pending", "resume_worker:retry", { incrementRetryCount: true });
      harness.store.recordWorkerStart(
        "N-37",
        "codex_47",
        "33333333-3333-4333-8333-333333333333",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );

      const reloaded = harness.store.load().workers["N-37"];
      expect(reloaded?.status).toBe("running");
      // The validator's cycle-1 evidence must still be visible to the
      // operator (and to runValidationCycleWithFeedbackLoop, which uses
      // current_cycle to pick the next cycle number).
      expect(reloaded?.validation?.last_score).toBe(0.5);
      expect(reloaded?.validation?.last_feedback).toBe("cycle one needs more work");
      expect(reloaded?.validation?.history).toHaveLength(1);
      expect(reloaded?.validation?.history?.[0]).toMatchObject({
        cycle: 1,
        score: 0.5,
        feedback: "cycle one needs more work"
      });
      expect(reloaded?.validation?.current_cycle).toBe(1);
      // validator_thread_id is correctly reset on a fresh worker launch:
      // the prior validator was for the old thread.
      expect(reloaded?.validation?.validator_thread_id).toBeNull();
    });

    it("starts fresh validation block for a worker with no prior validation context", async () => {
      const harness = await createHarness();

      harness.store.recordWorkerStart(
        "N-01",
        "worker-thread-111",
        "11111111-1111-4111-8111-111111111111",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );

      const worker = harness.store.load().workers["N-01"];
      expect(worker?.validation).toMatchObject({
        current_cycle: 0,
        max_fix_cycles: 3,
        validator_thread_id: null,
        last_score: null,
        last_feedback: null,
        history: []
      });
    });
  });

  describe("clearWorkerThreadForRelaunch", () => {
    it("persists empty thread_id without throwing on schema validation", async () => {
      // Regression: DispatchWorkerStateSchema previously enforced
      // thread_id.min(1), so save() rejected the cleared state and the
      // dispatcher looped forever trying to deliver validator feedback to
      // a dead thread (observed: thread_id=codex_45 after a hub restart).
      const harness = await createHarness();

      harness.store.recordWorkerStart(
        "N-37",
        "codex_45",
        "11111111-1111-4111-8111-111111111111",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );
      harness.store.transitionToFixRequested(
        "N-37",
        0.5,
        "needs more work",
        "validator-thread-1"
      );

      expect(() => harness.store.clearWorkerThreadForRelaunch("N-37", "validator_feedback_undeliverable"))
        .not.toThrow();

      const reloaded = harness.store.load();
      expect(reloaded.workers["N-37"]?.thread_id).toBe("");
      expect(reloaded.workers["N-37"]?.status).toBe("fix_requested");
      // Validation feedback must be preserved so the relaunched worker can
      // be fed prior context via buildPreviousAttemptContext.
      expect(reloaded.workers["N-37"]?.validation?.last_feedback).toBe("needs more work");

      const onDisk = JSON.parse(await fsp.readFile(harness.filePath, "utf8")) as DispatchThreadStateV2;
      expect(onDisk.workers["N-37"]?.thread_id).toBe("");
    });
  });

  describe("recordWorkerResult validation re-entry intercept", () => {
    // M-01 on agent-dispatcher-9fd97803: cycle 2 returned fix_requested,
    // worker's next reply was outcome:blocked (dirty worktree gate),
    // dispatcher escalated to PM, then later attempts produced complete
    // markers. Without this intercept the recovering hub_result lands
    // directly on "completed" and the validator never gets a third cycle
    // until PR #194's reconciler tick — observed gap of >10 minutes.
    it("routes blocked->completed back to awaiting_validation when prior validation history exists", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "M-01",
        "worker-thread-m01",
        "11111111-1111-4111-8111-111111111111",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );
      harness.store.transitionToAwaitingValidation("M-01", 3);
      harness.store.transitionToFixRequested(
        "M-01",
        0.5,
        "address the runtime stub",
        "validator-thread-cycle-1"
      );
      harness.store.transitionToAwaitingValidation("M-01", 3);
      harness.store.transitionToFixRequested(
        "M-01",
        0.5,
        "still missing the runtime",
        "validator-thread-cycle-2"
      );
      // Worker reply between cycles 2 and 3 was outcome: blocked (dirty
      // worktree). PM resolution then unblocks; the worker's *next* reply
      // is the recovering complete attempt.
      harness.store.recordWorkerResult("M-01", buildHubResult({
        thread_id: "worker-thread-m01",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: M-01",
          "role: worker",
          "outcome: blocked",
          "notes: dirty worktree from prior worker",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:39:29.000Z"
      }));
      expect(harness.store.load().workers["M-01"]?.status).toBe("blocked");
      const validationAfterBlock = harness.store.load().workers["M-01"]?.validation;
      expect(validationAfterBlock?.history?.length).toBe(2);

      // Recovering attempt — outcome: complete. The intercept should route
      // this to awaiting_validation so the validator gets cycle 3 instead
      // of the dispatcher treating M-01 as terminally completed.
      harness.store.recordWorkerResult("M-01", buildHubResult({
        thread_id: "worker-thread-m01",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: M-01",
          "role: worker",
          "outcome: complete",
          "report_path: /tmp/M-01.md",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:55:42.000Z"
      }));

      const recovered = harness.store.load().workers["M-01"];
      expect(recovered?.status).toBe("awaiting_validation");
      expect(recovered?.validation?.history?.length).toBe(2);
      expect(recovered?.validation?.last_score).toBe(0.5);
    });

    it("routes failed->completed back to awaiting_validation when prior validation history exists", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "M-02",
        "worker-thread-m02",
        "11111111-1111-4111-8111-111111111111",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );
      harness.store.transitionToAwaitingValidation("M-02", 3);
      harness.store.transitionToFixRequested(
        "M-02",
        0.5,
        "needs work",
        "validator-thread-cycle-1"
      );
      // Simulate a prior failed attempt landing while in fix cycle.
      harness.store.recordWorkerResult("M-02", buildHubResult({
        thread_id: "worker-thread-m02",
        status: "error",
        run_state: "completed",
        content: "Outcome: FAILED — transient subprocess crash",
        timestamp: "2026-04-03T12:30:00.000Z"
      }));
      expect(harness.store.load().workers["M-02"]?.status).toBe("failed");

      // Recovering attempt with passing marker.
      harness.store.recordWorkerResult("M-02", buildHubResult({
        thread_id: "worker-thread-m02",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: M-02",
          "role: worker",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:45:00.000Z"
      }));

      expect(harness.store.load().workers["M-02"]?.status).toBe("awaiting_validation");
    });

    it("does NOT intercept blocked->completed when validation history is empty", async () => {
      const harness = await createHarness();
      // First-attempt blocked worker: validation skeleton present but no
      // cycle has ever recorded a verdict (history.length === 0). This
      // worker has not been "in validation" yet — going to completed
      // directly preserves the original first-entry behavior. PR #194's
      // separate reconciler sweep handles the artifact-marker case.
      harness.store.recordWorkerStart(
        "M-03",
        "worker-thread-m03",
        "11111111-1111-4111-8111-111111111111",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );
      harness.store.recordWorkerResult("M-03", buildHubResult({
        thread_id: "worker-thread-m03",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: M-03",
          "role: worker",
          "outcome: blocked",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));
      expect(harness.store.load().workers["M-03"]?.status).toBe("blocked");
      expect(harness.store.load().workers["M-03"]?.validation?.history?.length).toBe(0);

      harness.store.recordWorkerResult("M-03", buildHubResult({
        thread_id: "worker-thread-m03",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: M-03",
          "role: worker",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:10:00.000Z"
      }));

      // First-cycle entry into validation should still go through the
      // running/fix_requested arm — but here the prior status is "blocked"
      // with no history, so we land on "awaiting_validation" only via
      // PR #194's reconciler artifact path on the next tick. Direct
      // recordWorkerResult here lands on plain "completed" by design;
      // history-gate exists to keep this preserved.
      expect(harness.store.load().workers["M-03"]?.status).toBe("completed");
    });

    it("preserves the existing running->completed intercept", async () => {
      const harness = await createHarness();
      harness.store.recordWorkerStart(
        "N-50",
        "worker-thread-n50",
        "11111111-1111-4111-8111-111111111111",
        [],
        null,
        { validationMaxFixCycles: 3 }
      );

      harness.store.recordWorkerResult("N-50", buildHubResult({
        thread_id: "worker-thread-n50",
        status: "success",
        run_state: "completed",
        content: [
          "<<<MERIDIAN-STATUS>>>",
          "worker_id: N-50",
          "role: worker",
          "outcome: complete",
          "<<<END>>>"
        ].join("\n"),
        timestamp: "2026-04-03T12:00:00.000Z"
      }));

      expect(harness.store.load().workers["N-50"]?.status).toBe("awaiting_validation");
    });
  });
});

async function createHarness(options: {
  dispatchPlanPath?: string;
  log?: { info: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  planTemplate?: string;
  fallbackHeuristicsEnabled?: boolean;
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
        ? { info: options.log.info, warn: options.log.warn ?? (() => undefined) }
        : undefined,
      fallbackHeuristicsEnabled: options.fallbackHeuristicsEnabled
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
