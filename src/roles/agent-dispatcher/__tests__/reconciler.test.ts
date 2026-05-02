import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { A2AClient } from "../../../a2a/client";
import type { DispatchThreadStateV2, HubMessage, HubResult } from "../../../types";
import { buildEmptyDispatchThreadStateV2, LifecycleStore } from "../lifecycle-store";
import {
  DEFAULT_RECONCILE_STALE_TIMEOUT_MS,
  DISPATCHER_ENTRY_ID,
  reconciliationFs,
  reconcile
} from "../reconciler";

const tempDirectories = new Set<string>();
const FIXED_NOW = "2026-04-03T12:30:00.000Z";
const execFileSyncMock = vi.hoisted(() => vi.fn(() => ""));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock
}));

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue("");

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fsp.rm(directory, { recursive: true, force: true });
    })
  );

  tempDirectories.clear();
});

describe("reconcile", () => {
  it("marks a running worker completed when Hub reports completion and outputs exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/N-02_report.md");
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker("worker-thread-111", outputPath)
      }
    }));

    const existsSpy = vi.spyOn(reconciliationFs, "existsSync");
    const statSpy = vi.spyOn(reconciliationFs, "statSync");
    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);
    const nextState = harness.store.load();

    expect(nextState.workers["N-02"]?.status).toBe("completed");
    expect(nextState.last_reconciled_at).toBe(FIXED_NOW);
    expect(report).toEqual({
      changed: [
        {
          workerId: "N-02",
          from: "running",
          to: "completed",
          trigger: "hub_status:completed:outputs_present"
        }
      ],
      unchanged: [DISPATCHER_ENTRY_ID]
    });
    expect(existsSpy).toHaveBeenCalledWith(outputPath);
    expect(statSpy).toHaveBeenCalledWith(outputPath);
  });

  it("marks a running worker completed when outputs exist in a round subdirectory of the expected path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await harness.writeOutput("dev_history/v1_round/N-07_report.md");
    const wrongExpectedPath = path.join(harness.directory, "dev_history", "N-07_report.md");
    harness.store.save(buildState({
      workers: {
        "N-07": buildRunningWorker("worker-thread-707", wrongExpectedPath)
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-07"]?.status).toBe("completed");
    expect(report.changed).toEqual([
      {
        workerId: "N-07",
        from: "running",
        to: "completed",
        trigger: "hub_status:completed:outputs_present"
      }
    ]);
  });

  it("marks a running worker completed when outputs exist in a sibling reports/ directory with short basename", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    // Report is in reports/N-07.md but expected_outputs says dev_history/N-07_report.md
    await harness.writeOutput("reports/N-07.md");
    const wrongExpectedPath = path.join(harness.directory, "dev_history", "N-07_report.md");
    harness.store.save(buildState({
      workers: {
        "N-07": buildRunningWorker("worker-thread-707", wrongExpectedPath)
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-07"]?.status).toBe("completed");
    expect(report.changed).toEqual([
      {
        workerId: "N-07",
        from: "running",
        to: "completed",
        trigger: "hub_status:completed:outputs_present"
      }
    ]);
  });

  it("marks a running worker completed from a stored successful HubResult when outputs exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("test/gui-demo/step1.txt");
    harness.store.save(buildState({
      workers: {
        "A-01": {
          ...buildRunningWorker("worker-thread-111", outputPath),
          hub_result: buildTerminalSuccessResult("worker-thread-111")
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["A-01"]?.status).toBe("completed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report).toEqual({
      changed: [
        {
          workerId: "A-01",
          from: "running",
          to: "completed",
          trigger: "hub_result:outputs_present"
        }
      ],
      unchanged: [DISPATCHER_ENTRY_ID]
    });
  });

  it("keeps validator rework running when the stored HubResult predates feedback delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/N-03.md");
    const staleHubResult = {
      ...buildTerminalSuccessResult("worker-thread-n03"),
      timestamp: "2026-04-03T12:21:00.000Z"
    };
    harness.store.save(buildState({
      workers: {
        "N-03": {
          ...buildRunningWorker("worker-thread-n03", outputPath, "2026-04-03T12:20:00.000Z"),
          last_seen_at: "2026-04-03T12:25:00.000Z",
          hub_result: staleHubResult,
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: 0.68,
            last_feedback: "Add the missing protocol symbol map.",
            history: [
              {
                cycle: 1,
                score: 0.68,
                feedback: "Add the missing protocol symbol map.",
                validator_thread_id: "validator-thread-n03-cycle-1",
                timestamp: "2026-04-03T12:22:00.000Z"
              }
            ]
          }
        }
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-03"]?.status).toBe("running");
    expect(report).toEqual({
      changed: [],
      unchanged: [DISPATCHER_ENTRY_ID, "N-03"]
    });
  });

  it("keeps a worker running when its stored HubResult reports another worker's output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const preflightReportPath = await harness.writeOutput(
      "reports/run/run-001/PRE-FLIGHT.md",
      "# PRE-FLIGHT Completion Report\n\n- Status: ✅ Complete\n"
    );
    const catalogReportPath = path.join(harness.directory, "reports", "run", "run-001", "W-CATALOG.md");
    harness.store.save(buildState({
      workers: {
        "W-CATALOG": {
          ...buildRunningWorker("worker-thread-222", catalogReportPath),
          hub_result: {
            ...buildTerminalSuccessResult("worker-thread-222"),
            content: [
              "PRE-FLIGHT completed with exit code `0`.",
              "",
              `Report written to [PRE-FLIGHT.md](${preflightReportPath}).`
            ].join("\n")
          }
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["W-CATALOG"]?.status).toBe("running");
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(report).toEqual({
      changed: [],
      unchanged: [DISPATCHER_ENTRY_ID, "W-CATALOG"]
    });
  });

  it("marks a running worker failed when a stored success HubResult reports hit limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "A-01": {
          ...buildRunningWorker("worker-thread-111", path.join(harness.directory, "missing-report.md")),
          hub_result: {
            ...buildTerminalSuccessResult("worker-thread-111"),
            content: ":hit limit"
          }
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["A-01"]?.status).toBe("failed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report).toEqual({
      changed: [
        {
          workerId: "A-01",
          from: "running",
          to: "failed",
          trigger: "hub_result:hit_limit"
        }
      ],
      unchanged: [DISPATCHER_ENTRY_ID]
    });
  });

  it("marks a running worker failed when Hub reports an error state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker("worker-thread-111", path.join(harness.directory, "missing-report.md"))
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "error"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("failed");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "running",
        to: "failed",
        trigger: "hub_status:error"
      }
    ]);
  });

  it("marks a running worker completed when the thread is missing but outputs exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/N-02_report.md");
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker("worker-thread-111", outputPath)
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("completed");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "running",
        to: "completed",
        trigger: "thread_missing:outputs_present"
      }
    ]);
  });

  it("keeps a missing-thread worker running when its matching tool process is still active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const scanRunId = "daily-2026-04-27";
    const outputPath = await harness.writeOutput("reports/runs/run-001/W-DETAIL.md", [
      "# W-DETAIL Completion Report",
      "",
      "## Outcome",
      "",
      "✅"
    ].join("\n"));
    await harness.writeOutput("dispatch_plan.md", [
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 2 | W-DETAIL | Run `clawhub-fetch detail-fetch --scan-run-id ${SCAN_RUN_ID} --db /Volumes/Elements/clawhub/clawhub.db --manifest /tmp/clawhub-scan/${SCAN_RUN_ID}/changed_skill_manifest.json` | CODEX-HIGH | W-CATALOG | |"
    ].join("\n"));

    const worker = buildRunningWorker("managed-W-DETAIL-daily-2026-04-27-71436", outputPath);
    worker.command_preamble = [
      "# Scheduler Cycle Context",
      "SCHEDULER_RUN_ID: run-001",
      `SCAN_RUN_ID: ${scanRunId}`
    ].join("\n");
    harness.store.save(buildState({
      workers: {
        "W-DETAIL": worker
      }
    }));

    execFileSyncMock.mockReturnValue([
      `71436 node /Users/yzliu/.local/share/fnm/aliases/default/bin/clawhub-fetch detail-fetch --scan-run-id ${scanRunId} --db /Volumes/Elements/clawhub/clawhub.db --manifest /tmp/clawhub-scan/${scanRunId}/W-DETAIL.remaining-managed.json`
    ].join("\n"));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["W-DETAIL"]?.status).toBe("running");
    expect(report.changed).toEqual([]);
    expect(report.unchanged).toEqual([DISPATCHER_ENTRY_ID, "W-DETAIL"]);
  });

  it("marks a running worker abandoned when the thread is missing, outputs are absent, and the stale timeout is exceeded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker(
          "worker-thread-111",
          path.join(harness.directory, "missing-report.md"),
          "2026-04-03T12:00:00.000Z"
        )
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient, {
      staleTimeoutMs: 5 * 60 * 1000
    });

    expect(harness.store.load().workers["N-02"]?.status).toBe("abandoned");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "running",
        to: "abandoned",
        trigger: "thread_missing:no_evidence"
      }
    ]);
  });

  it("immediately abandons a running worker when the thread is confirmed missing with no evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker(
          "worker-thread-111",
          path.join(harness.directory, "missing-report.md"),
          "2026-04-03T12:28:00.000Z"
        )
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient, {
      staleTimeoutMs: 5 * 60 * 1000
    });

    expect(harness.store.load().workers["N-02"]?.status).toBe("abandoned");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "running",
        to: "abandoned",
        trigger: "thread_missing:no_evidence"
      }
    ]);
  });

  it("promotes an abandoned worker to completed when outputs exist on disk", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/N-02_report.md");
    harness.store.save(buildState({
      workers: {
        "N-02": {
          ...buildRunningWorker("worker-thread-111", outputPath),
          status: "abandoned"
        }
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("completed");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "abandoned",
        to: "completed",
        trigger: "thread_missing:outputs_present"
      }
    ]);
  });

  it("leaves an abandoned worker unchanged when outputs are absent and thread is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-04": {
          ...buildRunningWorker("worker-thread-444", path.join(harness.directory, "missing-report.md")),
          status: "abandoned"
        }
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    // Already abandoned, no outputs, stays abandoned (no further demotion)
    expect(harness.store.load().workers["N-04"]?.status).toBe("abandoned");
    expect(report).toEqual({
      changed: [],
      unchanged: [DISPATCHER_ENTRY_ID, "N-04"]
    });
  });

  it("does not re-evaluate workers that are already completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": {
          ...buildRunningWorker("worker-thread-111", path.join(harness.directory, "done.md")),
          status: "completed",
          hub_result: buildTerminalSuccessResult("worker-thread-111")
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("completed");
    expect(harness.store.load().last_reconciled_at).toBe(FIXED_NOW);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report).toEqual({
      changed: [],
      unchanged: [DISPATCHER_ENTRY_ID, "N-02"]
    });
  });

  it("recovers hub_result for completed workers that are missing it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "R-03": {
          ...buildRunningWorker("worker-thread-333", path.join(harness.directory, "missing-R-03.md")),
          status: "completed",
          hub_result: null
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => {
      if ((message as HubMessage).intent === "history") {
        return buildHistoryResult(message.thread_id, [
          {
            event_kind: "final_reply",
            source: "claude",
            content: "R-03 completed. All assertions passed.",
            raw_content: "# R-03 Completion Report\n\n**Status**: PASS",
            trace_id: "11111111-1111-4111-8111-111111111111",
            timestamp: "2026-04-03T12:25:00.000Z"
          }
        ]);
      }
      return buildStatusResult(message.thread_id, "completed");
    });

    const report = await reconcile(harness.store, hubClient);
    const nextState = harness.store.load();

    expect(nextState.workers["R-03"]?.status).toBe("completed");
    expect(nextState.workers["R-03"]?.hub_result).not.toBeNull();
    expect(nextState.workers["R-03"]?.hub_result?.content).toContain("R-03 Completion Report");
    expect(sendRequest.mock.calls.map(([message]) => ({
      thread_id: (message as HubMessage).thread_id,
      intent: (message as HubMessage).intent
    }))).toEqual([
      { thread_id: "worker-thread-333", intent: "history" }
    ]);
    expect(report.changed).toEqual([
      {
        workerId: "R-03",
        from: "completed",
        to: "completed",
        trigger: "hub_result_recovery:completed_without_result"
      }
    ]);
  });

  it("marks the dispatcher abandoned when its thread is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T12:00:00.000Z",
        status: "running"
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().dispatcher.status).toBe("abandoned");
    expect(report).toEqual({
      changed: [
        {
          workerId: DISPATCHER_ENTRY_ID,
          from: "running",
          to: "abandoned",
          trigger: "dispatcher_thread_missing"
        }
      ],
      unchanged: []
    });
  });

  it("reconciles multiple workers independently and queries Hub only for running entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const completedOutput = await harness.writeOutput("dev_history/R-01_report.md");
    harness.store.save(buildState({
      workers: {
        "R-01": buildRunningWorker("worker-thread-111", completedOutput),
        "R-02": buildRunningWorker(
          "worker-thread-222",
          path.join(harness.directory, "missing-R-02.md"),
          "2026-04-03T11:00:00.000Z"
        ),
        "R-03": buildRunningWorker("worker-thread-333", path.join(harness.directory, "missing-R-03.md")),
        "R-04": {
          ...buildRunningWorker("worker-thread-444", path.join(harness.directory, "done-R-04.md")),
          status: "completed",
          hub_result: buildTerminalSuccessResult("worker-thread-444")
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => {
      switch (message.thread_id) {
        case "worker-thread-111":
          return buildStatusResult(message.thread_id, "completed");
        case "worker-thread-222":
          return buildMissingThreadResult(message.thread_id);
        case "worker-thread-333":
          return buildStatusResult(message.thread_id, "error");
        default:
          return buildStatusResult(message.thread_id, "running");
      }
    });

    const report = await reconcile(harness.store, hubClient, {
      staleTimeoutMs: 10 * 60 * 1000
    });
    const nextState = harness.store.load();

    expect(nextState.workers["R-01"]?.status).toBe("completed");
    expect(nextState.workers["R-02"]?.status).toBe("abandoned");
    expect(nextState.workers["R-03"]?.status).toBe("failed");
    expect(nextState.workers["R-04"]?.status).toBe("completed");
    expect(sendRequest.mock.calls.map(([message]) => ({
      thread_id: (message as HubMessage).thread_id,
      intent: (message as HubMessage).intent
    }))).toEqual([
      { thread_id: "worker-thread-111", intent: "status" },
      { thread_id: "worker-thread-222", intent: "status" },
      { thread_id: "worker-thread-222", intent: "history" },
      { thread_id: "worker-thread-333", intent: "status" },
      { thread_id: "worker-thread-333", intent: "history" }
    ]);
    expect(report).toEqual({
      changed: [
        {
          workerId: "R-01",
          from: "running",
          to: "completed",
          trigger: "hub_status:completed:outputs_present"
        },
        {
          workerId: "R-02",
          from: "running",
          to: "abandoned",
          trigger: "thread_missing:no_evidence"
        },
        {
          workerId: "R-03",
          from: "running",
          to: "failed",
          trigger: "hub_status:error"
        }
      ],
      unchanged: [DISPATCHER_ENTRY_ID, "R-04"]
    });
  });

  it("marks a running worker completed from a stored successful HubResult with inline report when outputs are absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "R-02": {
          ...buildRunningWorker("worker-thread-222", path.join(harness.directory, "missing-R-02-report.md")),
          hub_result: buildInlineReportResult("worker-thread-222")
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["R-02"]?.status).toBe("completed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report.changed).toEqual([
      {
        workerId: "R-02",
        from: "running",
        to: "completed",
        trigger: "hub_result:inline_report"
      }
    ]);
  });

  it("marks a running worker completed from a stored successful inline validation report when report files are absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "PRE-FLIGHT": {
          ...buildRunningWorker("worker-thread-preflight", path.join(harness.directory, "missing-PRE-FLIGHT-report.md")),
          hub_result: buildValidationInlineReportResult("worker-thread-preflight")
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["PRE-FLIGHT"]?.status).toBe("completed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report.changed).toEqual([
      {
        workerId: "PRE-FLIGHT",
        from: "running",
        to: "completed",
        trigger: "hub_result:inline_report"
      }
    ]);
  });

  it("marks a running worker completed from a stored successful inline completion report when report files are absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "R-01": {
          ...buildRunningWorker("worker-thread-r01", path.join(harness.directory, "missing-R-01-report.md")),
          hub_result: buildReportOnlyInlineCompletionResult("worker-thread-r01")
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["R-01"]?.status).toBe("completed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report.changed).toEqual([
      {
        workerId: "R-01",
        from: "running",
        to: "completed",
        trigger: "hub_result:inline_report"
      }
    ]);
  });

  it("marks a running worker completed when a terminal HubResult reports a real dev_history artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const actualReportPath = await harness.writeOutput("dev_history/v1_round_delta/R-07_report.md");
    harness.store.save(buildState({
      workers: {
        "R-07": {
          ...buildRunningWorker(
            "worker-thread-777",
            path.join(harness.directory, "dev_history/v1_round/R-07_report.md")
          ),
          hub_result: {
            ...buildTerminalSuccessResult("worker-thread-777"),
            content: [
              "R-07 completed successfully.",
              `The completion report is at [R-07_report.md](${actualReportPath}).`
            ].join("\n")
          }
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["R-07"]?.status).toBe("completed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report.changed).toEqual([
      {
        workerId: "R-07",
        from: "running",
        to: "completed",
        trigger: "hub_result:reported_outputs_present"
      }
    ]);
  });

  it("marks a running worker completed when reported output paths contain URI fragments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const actualReportPath = await harness.writeOutput("dev_history/v1_round/delta_check_report.md");
    harness.store.save(buildState({
      workers: {
        "DELTA-CHECK": {
          ...buildRunningWorker(
            "worker-thread-dc",
            path.join(harness.directory, "dev_history/DELTA-CHECK_report.md")
          ),
          hub_result: {
            ...buildTerminalSuccessResult("worker-thread-dc"),
            content: [
              "Delta check is complete.",
              `I wrote [delta_check_report.md](${actualReportPath}#L1) and updated`,
              `[dispatch_plan.md](${path.join(harness.directory, "dispatch_plan.md")}#L45).`
            ].join("\n")
          }
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["DELTA-CHECK"]?.status).toBe("completed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report.changed).toEqual([
      {
        workerId: "DELTA-CHECK",
        from: "running",
        to: "completed",
        trigger: "hub_result:reported_outputs_present"
      }
    ]);
  });

  it("marks a running worker completed when hub says completed and hub_result has inline report but no output files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-06": {
          ...buildRunningWorker("worker-thread-666", path.join(harness.directory, "missing-N-06-report.md")),
          hub_result: buildInlineReportResult("worker-thread-666", "N-06")
        }
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-06"]?.status).toBe("completed");
    expect(report.changed[0]?.trigger).toBe("hub_result:inline_report");
  });

  it("marks a running worker completed when thread is missing and hub_result has inline report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "R-02": {
          ...buildRunningWorker("worker-thread-222", path.join(harness.directory, "missing-report.md")),
          hub_result: buildInlineReportResult("worker-thread-222")
        }
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["R-02"]?.status).toBe("completed");
    expect(report.changed[0]?.trigger).toBe("hub_result:inline_report");
  });

  it("recovers a lost terminal worker result from Hub conversation history when callback delivery was lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "DELTA-CHECK": buildRunningWorker(
          "worker-thread-delta",
          path.join(harness.directory, "missing-delta-check-report.md")
        )
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => {
      if (message.intent === "history") {
        return buildHistoryResult(message.thread_id, [
          {
            event_kind: "final_reply",
            source: "codex",
            content: "Worker completed. Returning inline completion report.",
            details_text: [
              "Your message:",
              "Run DELTA-CHECK",
              "",
              "Agent reply:",
              "# Delta Check Report",
              "",
              "| Worker | Status | Findings | Action Required |",
              "|--------|--------|----------|-----------------|",
              "| N-01 | ✅ Aligned | — | — |"
            ].join("\n"),
            raw_content: [
              "Worker completed. Returning inline completion report.",
              "",
              "# Delta Check Report",
              "",
              "| Worker | Status | Findings | Action Required |",
              "|--------|--------|----------|-----------------|",
              "| N-01 | ✅ Aligned | — | — |"
            ].join("\n"),
            trace_id: "11111111-1111-4111-8111-111111111111",
            timestamp: FIXED_NOW
          }
        ]);
      }

      return buildMissingThreadResult(message.thread_id);
    });

    const report = await reconcile(harness.store, hubClient);
    const nextWorker = harness.store.load().workers["DELTA-CHECK"];

    expect(nextWorker?.status).toBe("completed");
    expect(nextWorker?.hub_result?.summary_text).toBe("Worker completed. Returning inline completion report.");
    expect(nextWorker?.hub_result?.details_text).toContain("Agent reply:");
    expect(sendRequest.mock.calls.map(([message]) => (message as HubMessage).intent)).toEqual(["status", "history"]);
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "DELTA-CHECK",
        from: "running",
        to: "completed",
        trigger: "hub_result:inline_report"
      })
    );
  });

  it("recovers a trace-less final reply from Hub history when it was emitted after the current attempt started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "R-03": buildRunningWorker(
          "worker-thread-r03",
          path.join(harness.directory, "missing-r03-report.md"),
          "2026-04-03T12:20:00.000Z"
        )
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => {
      if (message.intent === "history") {
        return buildHistoryResult(message.thread_id, [
          {
            event_kind: "final_reply",
            source: "codex",
            content: "Stale reply from an earlier attempt.",
            raw_content: "# Old completion report",
            trace_id: null,
            timestamp: "2026-04-03T12:10:00.000Z"
          },
          {
            event_kind: "final_reply",
            source: "codex",
            content: "Worker completed. Returning inline completion report.",
            details_text: [
              "Your message:",
              "Run R-03",
              "",
              "Agent reply:",
              "# R-03 Completion Report",
              "",
              "- Status: complete"
            ].join("\n"),
            raw_content: [
              "Worker completed. Returning inline completion report.",
              "",
              "# R-03 Completion Report",
              "",
              "- Status: complete"
            ].join("\n"),
            trace_id: null,
            timestamp: FIXED_NOW
          }
        ]);
      }

      return buildStatusResult(message.thread_id, "idle");
    });

    const report = await reconcile(harness.store, hubClient);
    const nextWorker = harness.store.load().workers["R-03"];

    expect(nextWorker?.status).toBe("completed");
    expect(nextWorker?.hub_result?.summary_text).toBe("Worker completed. Returning inline completion report.");
    expect(nextWorker?.hub_result?.trace_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(sendRequest.mock.calls.map(([message]) => (message as HubMessage).intent)).toEqual(["status", "history"]);
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "R-03",
        from: "running",
        to: "completed",
        trigger: "hub_result:inline_report"
      })
    );
  });

  it("recovers a lost final reply from Hub history when an idle thread has produced expected outputs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/N-02.md", "# N-02 Report\n\nComplete.\n");
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker(
          "worker-thread-n02",
          outputPath,
          "2026-04-03T12:20:00.000Z"
        )
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => {
      if (message.intent === "history") {
        return buildHistoryResult(message.thread_id, [
          {
            event_kind: "final_reply",
            source: "codex",
            content: "N-02 completed and wrote its report.",
            raw_content: "N-02 completed and wrote its report.",
            trace_id: "11111111-1111-4111-8111-111111111111",
            timestamp: "2026-04-03T12:25:00.000Z"
          }
        ]);
      }

      return buildStatusResult(message.thread_id, "idle");
    });

    const report = await reconcile(harness.store, hubClient);
    const nextWorker = harness.store.load().workers["N-02"];

    expect(nextWorker?.status).toBe("completed");
    expect(nextWorker?.hub_result?.content).toBe("N-02 completed and wrote its report.");
    expect(nextWorker?.last_seen_at).toBe("2026-04-03T12:25:00.000Z");
    expect(sendRequest.mock.calls.map(([message]) => (message as HubMessage).intent)).toEqual(["status", "history"]);
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "N-02",
        from: "running",
        to: "completed",
        trigger: "hub_result:outputs_present"
      })
    );
  });

  it("recovers a blocked final reply from Hub history when a sibling report artifact already exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const expectedOutput = path.join(harness.directory, "dev_history/W-ANALYTICS_report.md");
    await harness.writeOutput(
      "reports/W-ANALYTICS.md",
      [
        "# W-ANALYTICS Report",
        "",
        "- Status: BLOCKED",
        "- Exit code: 1",
        "- Reason: current scan output directory was missing."
      ].join("\n")
    );

    harness.store.save(buildState({
      workers: {
        "W-ANALYTICS": {
          ...buildRunningWorker(
            "worker-thread-analytics",
            expectedOutput,
            "2026-04-03T12:20:00.000Z"
          ),
          trace_id: "11111111-1111-4111-8111-111111111111"
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => {
      if (message.intent === "history") {
        return buildHistoryResult(message.thread_id, [
          {
            event_kind: "final_reply",
            source: "codex",
            content: "`W-ANALYTICS` is blocked.",
            raw_content: [
              "`W-ANALYTICS` is blocked.",
              "",
              "The analytics command exited `1` because the expected output directory was missing."
            ].join("\n"),
            trace_id: "99999999-9999-4999-8999-999999999999",
            timestamp: "2026-04-03T12:25:00.000Z"
          }
        ]);
      }

      return buildStatusResult(message.thread_id, "running");
    });

    const report = await reconcile(harness.store, hubClient);
    const nextWorker = harness.store.load().workers["W-ANALYTICS"];

    expect(nextWorker?.status).toBe("blocked");
    expect(nextWorker?.trace_id).toBe("99999999-9999-4999-8999-999999999999");
    expect(nextWorker?.hub_result?.content).toContain("analytics command exited `1`");
    expect(nextWorker?.last_seen_at).toBe("2026-04-03T12:25:00.000Z");
    expect(sendRequest.mock.calls.map(([message]) => (message as HubMessage).intent)).toEqual(["status", "history"]);
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "W-ANALYTICS",
        from: "running",
        to: "blocked",
        trigger: "output_artifact:block_signal"
      })
    );
  });

  it("marks a running worker failed when hub_result is success but content contains a provider error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "DELTA-CHECK": {
          ...buildRunningWorker("worker-thread-dc", path.join(harness.directory, "missing-report.md")),
          hub_result: {
            trace_id: "44444444-4444-4444-8444-444444444444",
            thread_id: "worker-thread-dc",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: '■ {"type":"error","status":400,"error":\n{"type":"invalid_request_error","message":"The \'gpt-5.4 xhigh\' model is not\nsupported when using Codex with a ChatGPT account."}}\n\n\n› Improve documentation in @filename',
            attachments: [],
            timestamp: "2026-04-03T13:00:00.000Z"
          }
        }
      }
    }));

    const { hubClient } = createHubClient(() => buildStatusResult("worker-thread-dc", "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["DELTA-CHECK"]?.status).toBe("failed");
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "DELTA-CHECK",
        from: "running",
        to: "failed",
        trigger: "hub_result:provider_error"
      })
    );
  });

  it("marks a running worker failed when a recorded hub_result timed out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "R-01": {
          ...buildRunningWorker("worker-thread-timeout", path.join(harness.directory, "missing-report.md")),
          hub_result: {
            trace_id: "55555555-5555-4555-8555-555555555555",
            thread_id: "worker-thread-timeout",
            source: "codex",
            status: "partial",
            run_state: "timeout",
            content: "Task is running...",
            attachments: [],
            timestamp: "2026-04-03T13:00:00.000Z"
          }
        }
      }
    }));

    const { hubClient } = createHubClient(() => buildStatusResult("worker-thread-timeout", "running"));
    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["R-01"]?.status).toBe("failed");
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "R-01",
        from: "running",
        to: "failed",
        trigger: "hub_result:timeout"
      })
    );
  });

  it("preserves a hub_result written concurrently by the run tool during reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/E-05_report.md");

    // Initial state: E-02 completed with hub_result, E-05 running with no hub_result
    harness.store.save(buildState({
      workers: {
        "E-02": {
          ...buildRunningWorker("worker-thread-e02", path.join(harness.directory, "dev_history/E-02_report.md")),
          status: "completed",
          hub_result: buildTerminalSuccessResult("worker-thread-e02")
        },
        "E-05": buildRunningWorker("worker-thread-e05", outputPath)
      }
    }));

    // Simulate the race: while the reconciler awaits the hub query for E-05,
    // the run tool writes E-05's hub_result to disk concurrently.
    const concurrentHubResult = buildTerminalSuccessResult("worker-thread-e05");
    concurrentHubResult.content = "E-05 completed its task successfully.";
    concurrentHubResult.details_text = "Your message:\nRun E-05\n\nAgent reply:\nE-05 completed its task successfully.";
    let hubQueryCount = 0;

    const { hubClient } = createHubClient(async (message) => {
      hubQueryCount++;
      // On the hub status query for E-05, simulate the run tool writing concurrently
      if (message.intent === "status" && message.thread_id === "worker-thread-e05") {
        // The run tool writes E-05's hub_result to disk between reconciler's load and save
        const freshState = harness.store.load();
        freshState.workers["E-05"] = {
          ...freshState.workers["E-05"]!,
          status: "completed",
          hub_result: concurrentHubResult,
          last_seen_at: FIXED_NOW
        };
        harness.store.save(freshState);
      }
      return buildStatusResult(message.thread_id!, "completed");
    });

    const report = await reconcile(harness.store, hubClient);
    const nextState = harness.store.load();

    // E-05 should be completed AND its hub_result should be preserved (not overwritten with null)
    expect(hubQueryCount).toBe(1);
    expect(report.changed).toContainEqual(
      expect.objectContaining({ workerId: "E-05", from: "running", to: "completed" })
    );
    expect(nextState.workers["E-05"]?.status).toBe("completed");
    expect(nextState.workers["E-05"]?.hub_result).not.toBeNull();
    expect(nextState.workers["E-05"]?.hub_result?.content).toBe("E-05 completed its task successfully.");
    expect(nextState.workers["E-05"]?.hub_result?.details_text).toContain("Agent reply:");
  });

  it("completes a running worker when hub reports completed with a success hub_result but no outputs or inline report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "PRE-FLIGHT": {
          ...buildRunningWorker("worker-thread-pf", path.join(harness.directory, "missing-report.md")),
          hub_result: {
            trace_id: "55555555-5555-4555-8555-555555555555",
            thread_id: "worker-thread-pf",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "**PRE-FLIGHT complete. ✅**",
            attachments: [],
            timestamp: "2026-04-03T13:00:00.000Z"
          }
        }
      }
    }));

    const { hubClient } = createHubClient(() => buildStatusResult("worker-thread-pf", "completed"));
    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["PRE-FLIGHT"]?.status).toBe("completed");
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "PRE-FLIGHT",
        from: "running",
        to: "completed",
        trigger: expect.stringContaining("explicit_completion_content")
      })
    );
  });

  it("uses the default stale timeout when no override is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker(
          "worker-thread-111",
          path.join(harness.directory, "missing-report.md"),
          "2026-04-03T11:59:59.000Z"
        )
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    await reconcile(harness.store, hubClient);

    expect(Date.parse(FIXED_NOW) - Date.parse("2026-04-03T11:59:59.000Z")).toBeGreaterThan(
      DEFAULT_RECONCILE_STALE_TIMEOUT_MS
    );
    expect(harness.store.load().workers["N-02"]?.status).toBe("abandoned");
  });

  it("marks a worker blocked when its hub_result contains a BLOCKED marker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/PRE-FLIGHT.md");
    const blockedWorker = buildRunningWorker("worker-thread-blocked", outputPath);
    blockedWorker.hub_result = {
      trace_id: "88888888-8888-4888-8888-888888888888",
      thread_id: "worker-thread-blocked",
      source: "codex",
      status: "success",
      run_state: "completed",
      content: "Status: ⛔ BLOCKED\n\nBaseline test suite is failing on main.",
      attachments: [],
      timestamp: FIXED_NOW
    };

    harness.store.save(buildState({
      workers: {
        "PRE-FLIGHT": blockedWorker
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["PRE-FLIGHT"]?.status).toBe("blocked");
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "PRE-FLIGHT",
        from: "running",
        to: "blocked",
        trigger: "hub_result:block_signal"
      })
    );
  });

  it("marks a worker blocked when a report-only hub_result says it finished as BLOCKED", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/run/run-001/PRE-FLIGHT.md");
    const blockedWorker = buildRunningWorker("worker-thread-blocked", outputPath);
    blockedWorker.hub_result = {
      trace_id: "88888888-8888-4888-8888-888888888888",
      thread_id: "worker-thread-blocked",
      source: "codex",
      status: "success",
      run_state: "completed",
      content: [
        "PRE-FLIGHT finished as `BLOCKED`.",
        "",
        `Report written to [PRE-FLIGHT.md](${outputPath}).`,
        "",
        "Blocking issue: `/Volumes/Elements/github-ai-automation-solutions` does not exist."
      ].join("\n"),
      attachments: [],
      timestamp: FIXED_NOW
    };

    harness.store.save(buildState({
      workers: {
        "PRE-FLIGHT": blockedWorker
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["PRE-FLIGHT"]?.status).toBe("blocked");
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "PRE-FLIGHT",
        from: "running",
        to: "blocked",
        trigger: "hub_result:block_signal"
      })
    );
  });

  it("marks a worker failed when a timeout result has an output report with a failure outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/PRE-FLIGHT.md", [
      "# PRE-FLIGHT Report",
      "",
      "## Outcome",
      "",
      "⛔ FAIL",
      "",
      "Tool repo is not on main."
    ].join("\n"));
    const worker = buildRunningWorker("worker-thread-preflight", outputPath);
    worker.hub_result = {
      trace_id: "88888888-8888-4888-8888-888888888888",
      thread_id: "worker-thread-preflight",
      source: "codex",
      status: "partial",
      run_state: "timeout",
      content: "Waiting for approval...",
      attachments: [],
      timestamp: FIXED_NOW
    };

    harness.store.save(buildState({
      workers: {
        "PRE-FLIGHT": worker
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "waiting"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["PRE-FLIGHT"]?.status).toBe("failed");
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "PRE-FLIGHT",
        from: "running",
        to: "failed",
        trigger: "output_artifact:failure_signal"
      })
    );
  });

  it("marks a running worker blocked when its output report has a bold Markdown blocked result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/V-01-A.md", [
      "# V-01-A Report",
      "",
      "**Worker**: V-01-A",
      "**Result**: BLOCKED",
      "",
      "V-01-A did not create the required empty commit or PR because two Runtime Contract assertions did not pass."
    ].join("\n"));
    harness.store.save(buildState({
      workers: {
        "V-01-A": buildRunningWorker("worker-thread-v01a", outputPath)
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    const blockedWorker = harness.store.load().workers["V-01-A"];
    expect(blockedWorker?.status).toBe("blocked");
    expect(blockedWorker?.hub_result).toMatchObject({
      thread_id: "worker-thread-v01a",
      source: "output_artifact",
      status: "success",
      run_state: "completed",
      content: expect.stringContaining("**Result**: BLOCKED"),
      attachments: [
        expect.objectContaining({
          path: outputPath,
          filename: "V-01-A.md",
          mime_type: "text/markdown"
        })
      ]
    });
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "V-01-A",
        from: "running",
        to: "blocked",
        trigger: "output_artifact:block_signal"
      })
    );
  });

  it("does not fail a retry from a blocked report written before the current attempt started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/V-01-A.md", [
      "# V-01-A Report",
      "",
      "**Worker**: V-01-A",
      "**Result**: BLOCKED",
      "",
      "Previous attempt failed before delivery."
    ].join("\n"));
    await fsp.utimes(
      outputPath,
      new Date("2026-04-03T12:10:00.000Z"),
      new Date("2026-04-03T12:10:00.000Z")
    );

    harness.store.save(buildState({
      workers: {
        "V-01-A": buildRunningWorker(
          "worker-thread-v01a-retry",
          outputPath,
          "2026-04-03T12:20:00.000Z"
        )
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["V-01-A"]?.status).toBe("running");
    expect(report.changed).toEqual([]);
    expect(report.unchanged).toContain("V-01-A");
  });

  it("recovers a missing hub_result for an already-blocked worker from its output report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/N-07.md", [
      "# N-07 Report",
      "",
      "Status: BLOCKED",
      "",
      "Remote migration apply cannot proceed without a SQL execution credential."
    ].join("\n"));
    harness.store.save(buildState({
      workers: {
        "N-07": {
          ...buildRunningWorker("worker-thread-n07", outputPath),
          status: "blocked",
          hub_result: null
        }
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    const worker = harness.store.load().workers["N-07"];
    expect(worker?.status).toBe("blocked");
    expect(worker?.hub_result).toMatchObject({
      thread_id: "worker-thread-n07",
      source: "output_artifact",
      content: expect.stringContaining("Status: BLOCKED")
    });
    expect(report.changed).toContainEqual(
      expect.objectContaining({
        workerId: "N-07",
        from: "blocked",
        to: "blocked",
        trigger: "hub_result_recovery:blocked_without_result"
      })
    );
  });

  it("does not auto-complete a worker whose hub_result contains a PAUSE marker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("reports/WORKER.md");
    const pausedWorker = buildRunningWorker("worker-thread-paused", outputPath);
    pausedWorker.hub_result = {
      trace_id: "99999999-9999-4999-8999-999999999999",
      thread_id: "worker-thread-paused",
      source: "codex",
      status: "success",
      run_state: "completed",
      content: "⏸ PAUSE — waiting for upstream dependency to be resolved.",
      attachments: [],
      timestamp: FIXED_NOW
    };

    harness.store.save(buildState({
      workers: {
        "N-05": pausedWorker
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-05"]?.status).toBe("running");
    expect(report.unchanged).toContain("N-05");
  });
});

async function createHarness() {
  const directory = await fsp.mkdtemp(path.join(tmpdir(), "reconciler-test-"));
  tempDirectories.add(directory);

  const filePath = path.join(directory, "dispatch_threads.json");
  const store = new LifecycleStore(filePath);

  return {
    directory,
    filePath,
    store,
    async writeOutput(relativePath: string, content = "done\n"): Promise<string> {
      const outputPath = path.join(directory, relativePath);
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, content, "utf8");
      return outputPath;
    }
  };
}

function createHubClient(
  resolver: (message: HubMessage) => HubResult | Promise<HubResult>
): {
  hubClient: A2AClient;
  sendRequest: ReturnType<typeof vi.fn<(message: HubMessage) => Promise<HubResult>>>;
} {
  const sendRequest = vi.fn(async (message: HubMessage) => await resolver(message));

  return {
    hubClient: {
      serviceId: "service:meridian-roles",
      sendRequest
    } as unknown as A2AClient,
    sendRequest
  };
}

function buildState(partial: Partial<DispatchThreadStateV2>): DispatchThreadStateV2 {
  const base = buildEmptyDispatchThreadStateV2();

  return {
    ...base,
    ...partial,
    dispatcher: {
      ...base.dispatcher,
      ...partial.dispatcher
    },
    workers: partial.workers ?? base.workers,
    last_reconciled_at: partial.last_reconciled_at ?? base.last_reconciled_at
  };
}

function buildRunningWorker(
  threadId: string,
  expectedOutput: string,
  startedAt = "2026-04-03T12:20:00.000Z"
): DispatchThreadStateV2["workers"][string] {
  return {
    thread_id: threadId,
    trace_id: "11111111-1111-4111-8111-111111111111",
    started_at: startedAt,
    last_seen_at: startedAt,
    status: "running",
    expected_outputs: [expectedOutput],
    hub_result: null,
    command_preamble: null,
    retry_count: 0
  };
}

function buildStatusResult(threadId: string, status: string): HubResult {
  return {
    trace_id: "11111111-1111-4111-8111-111111111111",
    thread_id: threadId,
    source: "codex",
    status: "success",
    content: JSON.stringify({
      instance: {
        thread_id: threadId,
        status
      },
      agent_status: {
        status
      }
    }),
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildTerminalSuccessResult(threadId: string): HubResult {
  return {
    trace_id: "11111111-1111-4111-8111-111111111111",
    thread_id: threadId,
    source: "codex",
    status: "success",
    run_state: "completed",
    content: "worker finished",
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildMissingThreadResult(threadId: string): HubResult {
  return {
    trace_id: "22222222-2222-4222-8222-222222222222",
    thread_id: threadId,
    source: "codex",
    status: "error",
    content: `Routing failed: Cannot fetch status; thread_id=${threadId} is not registered`,
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildInlineReportResult(threadId: string, workerId = "R-02"): HubResult {
  return {
    trace_id: "33333333-3333-4333-8333-333333333333",
    thread_id: threadId,
    source: "codex",
    status: "success",
    run_state: "completed",
    content: [
      "Worker completed. Returning inline completion report.",
      "",
      `# ${workerId} — Completion Report`,
      "",
      "- **Status**: ✅ Complete",
      "",
      "## Files Changed",
      "- None by this worker.",
      "",
      "## Sub-task Results",
      "| Sub-task | Status |",
      "|----------|--------|",
      `| ${workerId}.1 | ✅ |`,
      "",
      "## AI Auto-Test Results",
      "```bash",
      "# tests 126",
      "# pass 126",
      "# fail 0",
      "```"
    ].join("\n"),
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildValidationInlineReportResult(threadId: string): HubResult {
  return {
    trace_id: "66666666-6666-4666-8666-666666666666",
    thread_id: threadId,
    source: "codex",
    status: "success",
    run_state: "completed",
    content: [
      "Pre-flight passed on a fresh rerun. Returning the validation report inline because the docs path was not writable.",
      "",
      "```markdown",
      "# PRE-FLIGHT Validation Report",
      "",
      "- **Date**: 2026-04-03T12:30:00.000Z",
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
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildReportOnlyInlineCompletionResult(threadId: string): HubResult {
  return {
    trace_id: "77777777-7777-4777-8777-777777777777",
    thread_id: threadId,
    source: "codex",
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
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildHistoryResult(threadId: string, entries: unknown[]): HubResult {
  return {
    trace_id: "55555555-5555-4555-8555-555555555555",
    thread_id: threadId,
    source: "codex",
    status: "success",
    content: JSON.stringify(entries),
    attachments: [],
    timestamp: FIXED_NOW
  };
}
