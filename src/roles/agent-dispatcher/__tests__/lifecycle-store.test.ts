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

  it("keeps a success HubResult running when content indicates BLOCKED", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      content: "⛔ BLOCKED — Cannot write to dispatch_plan.md, sandbox restriction",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "running",
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
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# R-02 Completion Report\n", "utf8");

    harness.store.recordWorkerStart("R-02", "worker-thread-222", "22222222-2222-4222-8222-222222222222", [
      "dev_history/v1_round/R-02_report.md"
    ]);

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
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, "# R-03 Completion Report\n", "utf8");

    harness.store.recordWorkerStart("R-03", "worker-thread-333", "33333333-3333-4333-8333-333333333333", [
      "dev_history/v1_round/R-03_report.md"
    ]);

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

  it("syncs a sibling *_dispatch_plan.md file when dispatch_plan.md is not present", async () => {
    const directory = await fsp.mkdtemp(path.join(tmpdir(), "meridian-roles-lifecycle-store-custom-plan-"));
    tempDirectories.add(directory);

    const filePath = path.join(directory, "dispatch_threads.json");
    const dispatchPlanPath = path.join(directory, "cli_shared_core_dispatch_plan.md");
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
    store.recordWorkerResult("PRE-FLIGHT", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check |"
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
