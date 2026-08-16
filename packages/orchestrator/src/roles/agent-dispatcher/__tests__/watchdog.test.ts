import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { A2AClient } from "../../../a2a/client";
import type { DispatchWorkerState, HubMessage, HubResult, LifecycleStatus } from "../../../types";
import killTool from "../../../tool-gateway/tools/kill";
import * as activeToolProcess from "../active-tool-process";
import { continueDispatchWorker } from "../continue-worker";
import {
  buildEmptyDispatchThreadStateV2,
  LifecycleStore,
  PM_RESOLVER_NO_PROGRESS_ERROR_PREFIX
} from "../lifecycle-store";
import { reconciliationFs } from "../reconciler";
import { ReconciliationWatchdog } from "../watchdog";
import type { DispatcherStallInfo } from "../watchdog";

const tempDirectories = new Set<string>();
const FIXED_NOW = "2026-04-03T14:00:00.000Z";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fsp.rm(directory, { recursive: true, force: true });
    })
  );

  tempDirectories.clear();
});

describe("ReconciliationWatchdog", () => {
  it("reconciles active dispatchers on sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/W-01_report.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient((message) =>
      buildStatusResult(message.thread_id, "completed")
    );

    vi.spyOn(reconciliationFs, "existsSync").mockReturnValue(true);
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({
      size: 100,
      mtimeMs: Date.parse(FIXED_NOW)
    } as ReturnType<typeof reconciliationFs.statSync>);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    const reports = await watchdog.sweep();

    expect(reports).toHaveLength(1);
    expect(reports[0].changed).toContainEqual(
      expect.objectContaining({ workerId: "W-01", to: "completed" })
    );

    const nextState = store.load();
    expect(nextState.workers["W-01"]?.status).toBe("completed");
  });

  it("skips sweep when one is already in progress", async () => {
    let resolveBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      resolveBlocker = resolve;
    });

    const { hubClient } = createHubClient(async () => {
      await blocker;
      return buildStatusResult("t", "running");
    });

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    const firstSweep = watchdog.sweep();
    const secondSweep = watchdog.sweep();

    const secondResult = await secondSweep;
    expect(secondResult).toEqual([]);

    resolveBlocker();
    await firstSweep;
  });

  it("returns empty when no dispatch plans are active", async () => {
    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    const reports = await watchdog.sweep();
    expect(reports).toEqual([]);
  });

  it("continues after a failed dispatch plan reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const badHarness = await createHarness("bad-");
    const badStore = new LifecycleStore(path.join(badHarness.directory, "dispatch_threads.json"));
    badStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-bad", started_at: "2026-04-03T12:00:00.000Z", status: "running" }
    });

    const goodHarness = await createHarness("good-");
    const goodStore = new LifecycleStore(path.join(goodHarness.directory, "dispatch_threads.json"));
    goodStore.save(buildEmptyDispatchThreadStateV2());

    let callCount = 0;
    const { hubClient } = createHubClient(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("Hub unreachable");
      }
      return buildStatusResult("t", "running");
    });

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(badHarness.directory, "dispatch_plan.md"),
        path.join(goodHarness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    const reports = await watchdog.sweep();
    expect(reports).toHaveLength(1);
  });

  it("starts and stops the periodic timer", async () => {
    vi.useFakeTimers();

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const sweepSpy = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: sweepSpy,
      hubClient,
      log: silentLog(),
      intervalMs: 5_000
    });

    watchdog.start();
    expect(sweepSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepSpy).toHaveBeenCalledTimes(2);

    watchdog.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweepSpy).toHaveBeenCalledTimes(2);
  });

  it("does not start timer when intervalMs is 0", () => {
    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const logSpy = silentLog();

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [],
      hubClient,
      log: logSpy,
      intervalMs: 0
    });

    watchdog.start();
    expect(logSpy.info).toHaveBeenCalledWith(
      "Reconciliation watchdog disabled (interval <= 0)"
    );
  });

  it("invokes onDispatcherStalled when dispatcher is not running and pending workers exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ⬜ | 1 | W-01 | Pending worker | CODEX | — | Ready to continue. |"
      ].join("\n"),
      "utf8"
    );
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "pending" },
      workers: {
        "W-01": {
          thread_id: "placeholder",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "pending",
        pendingWorkerCount: 1,
        continueWorkerId: "W-01"
      })
    );
  });

  it("invokes onDispatcherStalled when a stale running worker should be continued through the shared service path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| 🔄 | 1 | W-01 | Stale running worker | CODEX | — | Lost dispatcher thread id. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "abandoned" },
      workers: {}
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "abandoned",
        pendingWorkerCount: 0,
        continueWorkerId: "W-01"
      })
    );
  });

  it("invokes onDispatcherStalled when a worker is waiting for validation without a validator thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| 🔍 | 2 | W-06 | Validate final synthesis | CODEX-XHIGH | W-01 | Report written. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "dispatcher-thread", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-06": {
          thread_id: "worker-thread-06",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111106",
            thread_id: "worker-thread-06",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Worker completed and wrote its report.",
            attachments: [],
            timestamp: "2026-04-03T12:10:00.000Z"
          },
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("dispatcher-thread", "completed"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "completed",
        pendingWorkerCount: 0,
        continueWorkerId: "W-06"
      })
    );
  });

  it("invokes onDispatcherStalled when pending markdown rows were appended after lifecycle state was written", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ✅ | 1 | W-01 | Existing worker | CODEX | — | Done already. |",
        "| ⬜ | Ω+1 | W-02 | Newly appended corrective task | CODEX | W-01 | Added by delta-check. |",
        "| ⬜ | Ω+1 | HUMAN-01 | Wait for review | HUMAN | W-02 | Human follow-up should not wake the dispatcher alone. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "completed" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "completed",
        pendingWorkerCount: 1,
        continueWorkerId: "W-02"
      })
    );
  });

  it("selects the first eligible pending worker when multiple workers can advance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ✅ | 1 | W-00 | Foundation | CODEX | — | Complete. |",
        "| ⬜ | 2 | W-01 | First eligible | CODEX | W-00 | Ready. |",
        "| ⬜ | 2 | W-02 | Also eligible | CODEX | W-00 | Ready. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "abandoned" },
      workers: {
        "W-00": {
          thread_id: "w-thread-00",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "abandoned",
        pendingWorkerCount: 2,
        continueWorkerId: "W-01"
      })
    );
  });

  it("does not invoke onDispatcherStalled when dispatcher is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "placeholder",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();
    expect(stallCallback).not.toHaveBeenCalled();
  });

  it("invokes onDispatcherStalled when dispatcher hub reports running but the controller turn is complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ✅ | 0 | PRE-FLIGHT | Environment health check | CODEX | — | Complete. |",
        "| ⛔ BLOCKED | 1 | A-2 | Worker needs PM | CODEX | PRE-FLIGHT | Needs PM resolution. |",
        "| ⬜ | 1 | BATCH-A-GATE | Next eligible worker | CODEX | PRE-FLIGHT | Ready to continue. |"
      ].join("\n"),
      "utf8"
    );
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        DISPATCHER: {
          thread_id: "d-01",
          trace_id: "dispatcher-trace",
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:02:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "PRE-FLIGHT": {
          thread_id: "preflight-thread",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "A-2": {
          thread_id: "a2-thread",
          trace_id: null,
          started_at: "2026-04-03T12:10:00.000Z",
          last_seen_at: "2026-04-03T12:15:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "running_controller_idle",
        pendingWorkerCount: 1,
        continueWorkerId: "BATCH-A-GATE"
      })
    );
  });

  it("invokes onDispatcherStalled when dispatcher hub reports running but a worker is awaiting validation with no validator spawned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| 🔍 | 1 | W-01 | Awaiting validation | CODEX | — | Worker reply received. |",
        "| ⬜ | 2 | W-02 | Pending follow-up | CODEX | W-01 | Eligible later. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "running_validation_pending",
        continueWorkerId: "W-01"
      })
    );
  });

  it("invokes onDispatcherStalled when dispatcher hub reports running but a worker is fix_requested with a retained thread id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| 🔁 | 1 | W-01 | Fix requested | CODEX | — | Validator returned feedback. |",
        "| ⬜ | 2 | W-02 | Pending follow-up | CODEX | W-01 | Eligible later. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "codex_96",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "fix_requested",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: 0.4,
            last_feedback: "needs more tests",
            history: []
          }
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "running_validation_pending",
        continueWorkerId: "W-01"
      })
    );
  });

  it("does not invoke onDispatcherStalled when validator spawn-failure backoff is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| 🔍 | 1 | W-01 | Awaiting validation | CODEX | — | Worker reply received. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: [],
            // 3 consecutive failures, last one within the backoff window.
            spawn_failure_count: 3,
            last_spawn_failure_at: "2026-04-03T13:55:00.000Z"
          }
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();
    expect(stallCallback).not.toHaveBeenCalled();
  });

  it("invokes onDispatcherStalled again once the validator spawn-failure backoff window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| 🔍 | 1 | W-01 | Awaiting validation | CODEX | — | Worker reply received. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: [],
            // Last failure is well outside the 10-minute backoff window
            // (FIXED_NOW = 2026-04-03T14:00:00Z, last failure 2h earlier).
            spawn_failure_count: 5,
            last_spawn_failure_at: "2026-04-03T12:00:00.000Z"
          }
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();
    expect(stallCallback).toHaveBeenCalledTimes(1);
  });

  it("invokes onDispatcherStalled when the dispatcher thread is idle with no live worker blocking the next task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ✅ | 1 | W-01 | Finished worker | CODEX | — | Done. |",
        "| ⬜ | 2 | W-02 | Next eligible worker | CODEX | W-01 | Ready to continue. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-02": {
          thread_id: "placeholder",
          trace_id: null,
          started_at: "2026-04-03T12:10:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient((message) => {
      if (message.thread_id === "d-01") {
        return buildStatusResult(message.thread_id, "idle");
      }

      return buildStatusResult(message.thread_id, "running");
    });
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "idle",
        pendingWorkerCount: 1,
        continueWorkerId: "W-02"
      })
    );
  });

  describe("parallel slot fill while a worker is running", () => {
    // The `blockingRunningWorkers.length > 0 → return` guard treats "a worker
    // is running" as "there is nothing to start". With parallel_dispatch that
    // made ONE running worker suppress continuation for all of
    // max_concurrency, so a plan could only ever advance one row at a time —
    // the second of the three serial choke points behind 0.86/3 mean
    // concurrency over a 20.1h round. The guard itself is untouched (stall
    // recovery stays suppressed); this is a separate narrow exit.
    async function createRunningWorkerFixture() {
      const harness = await createHarness();
      await fsp.writeFile(
        path.join(harness.directory, "dispatch_plan.md"),
        [
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| ✅ | 1 | W-00 | Finished gate | CODEX | — | Done. |",
          "| 🔄 | 2 | W-01 | Running worker | CODEX | W-00 | In flight. |",
          "| ⬜ | 2 | W-02 | Independent sibling | CODEX | W-00 | Ready to continue. |"
        ].join("\n"),
        "utf8"
      );

      const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
      store.save({
        ...buildEmptyDispatchThreadStateV2(),
        dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
        workers: {
          "W-00": {
            thread_id: "w-thread-00",
            trace_id: null,
            started_at: "2026-04-03T12:00:00.000Z",
            last_seen_at: "2026-04-03T12:10:00.000Z",
            status: "completed",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          },
          "W-01": {
            thread_id: "w-thread-01",
            trace_id: null,
            started_at: "2026-04-03T13:50:00.000Z",
            last_seen_at: "2026-04-03T13:59:00.000Z",
            status: "running",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          },
          "W-02": {
            thread_id: "placeholder",
            trace_id: null,
            started_at: "2026-04-03T12:10:00.000Z",
            last_seen_at: "2026-04-03T12:10:00.000Z",
            status: "pending",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        }
      });

      const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));
      return { harness, hubClient };
    }

    afterEach(() => {
      delete process.env.MERIDIAN_DISPATCH_AUTO_PARALLEL;
    });

    it("requests a bare parallel continue when slots are free", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createRunningWorkerFixture();
      const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [path.join(harness.directory, "dispatch_plan.md")],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency: 3 })
      });

      await watchdog.sweep();

      expect(stallCallback).toHaveBeenCalledTimes(1);
      expect(stallCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
          dispatcherStatus: "running_parallel_slots_free",
          pendingWorkerCount: 1,
          // Bare — this is the whole point. A workerId here would force the
          // targeted branch and leave parallel_dispatch dead config.
          continueWorkerId: null,
          parallelSlotFill: true
        })
      );
    });

    it("does not request a slot fill when running workers already fill max_concurrency", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createRunningWorkerFixture();
      const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [path.join(harness.directory, "dispatch_plan.md")],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency: 1 })
      });

      await watchdog.sweep();

      expect(stallCallback).not.toHaveBeenCalled();
    });

    it("does not request a slot fill for a dispatcher that never opted into parallel dispatch", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createRunningWorkerFixture();
      const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [path.join(harness.directory, "dispatch_plan.md")],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: false, maxConcurrency: 1 })
      });

      await watchdog.sweep();

      expect(stallCallback).not.toHaveBeenCalled();
    });

    it("does not request a slot fill when the dep is not wired at all (pre-fix behaviour)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createRunningWorkerFixture();
      const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [path.join(harness.directory, "dispatch_plan.md")],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback
      });

      await watchdog.sweep();

      expect(stallCallback).not.toHaveBeenCalled();
    });

    it("honours the MERIDIAN_DISPATCH_AUTO_PARALLEL kill-switch at call time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));
      process.env.MERIDIAN_DISPATCH_AUTO_PARALLEL = "false";

      const { harness, hubClient } = await createRunningWorkerFixture();
      const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [path.join(harness.directory, "dispatch_plan.md")],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency: 3 })
      });

      await watchdog.sweep();
      expect(stallCallback).not.toHaveBeenCalled();

      // Re-read per tick, not at module load: flipping the env back must take
      // effect on the very next sweep without a restart of the watchdog object.
      process.env.MERIDIAN_DISPATCH_AUTO_PARALLEL = "true";
      await watchdog.sweep();
      expect(stallCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("parallel slot fill with zero running workers", () => {
    // `resolveBlockingRunningWorkers` counts only lifecycle status === "running",
    // so a row held in `awaiting_validation` reads as ZERO running — and the
    // first cut of the slot-fill path lived inside the `running > 0` branch, so
    // it never fired here. The sweep fell through to targeted stall recovery,
    // which services exactly one row per tick. Observed on the deployed build
    // (2026-08-10 16:52 restart): BATCH-7-GATE awaiting_validation, C-02 and
    // C-04a pending with satisfied dependencies, max_concurrency 3, running 0,
    // "Watchdog requesting parallel slot fill" fired 0 times over 8+ minutes.
    //
    // It was also circular: 144729f's validator deferral only engages under
    // `isParallelAutoContinue`, which needs a bare continue, whose only
    // producer was the running>0 branch. A validator-held plan with nothing
    // running could never bootstrap into parallel mode at all.
    const planPathOf = (directory: string) => path.join(directory, "dispatch_plan.md");

    async function createValidatorHeldFixture() {
      const harness = await createHarness();
      await fsp.writeFile(
        planPathOf(harness.directory),
        [
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| ✅ | 6 | W-00 | Finished gate | CODEX | — | Done. |",
          "| 🔍 | 7 | BATCH-7-GATE | Held by a validator | CODEX | W-00 | Report written. |",
          "| ⬜ | 7 | C-02 | Independent, deps satisfied | CODEX | W-00 | Ready to continue. |"
        ].join("\n"),
        "utf8"
      );

      const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
      store.save({
        ...buildEmptyDispatchThreadStateV2(),
        dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
        workers: {
          "W-00": {
            thread_id: "w-thread-00",
            trace_id: null,
            started_at: "2026-04-03T12:00:00.000Z",
            last_seen_at: "2026-04-03T12:10:00.000Z",
            status: "completed",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          },
          // Held by a live validator, so `hasPendingValidatorOrchestration` is
          // false and this row is NOT counted by resolveBlockingRunningWorkers.
          "BATCH-7-GATE": {
            thread_id: "w-thread-gate",
            trace_id: null,
            started_at: "2026-04-03T13:00:00.000Z",
            last_seen_at: "2026-04-03T13:30:00.000Z",
            status: "awaiting_validation",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0,
            validation: {
              current_cycle: 0,
              max_fix_cycles: 3,
              validator_thread_id: "validator-thread-gate",
              last_score: null,
              last_feedback: null,
              history: []
            }
          },
          "C-02": {
            thread_id: "placeholder",
            trace_id: null,
            started_at: "2026-04-03T12:10:00.000Z",
            last_seen_at: "2026-04-03T12:10:00.000Z",
            status: "pending",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        }
      });

      const { hubClient } = createHubClient((message) =>
        buildStatusResult(message.thread_id, message.thread_id === "d-01" ? "idle" : "running")
      );
      return { harness, hubClient, store };
    }

    afterEach(() => {
      delete process.env.MERIDIAN_DISPATCH_AUTO_PARALLEL;
    });

    it("requests a bare parallel continue while a validator holds a row and nothing is running", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createValidatorHeldFixture();
      const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [planPathOf(harness.directory)],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency: 3 })
      });

      await watchdog.sweep();

      expect(stallCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchPlanPath: planPathOf(harness.directory),
          dispatcherStatus: "idle_parallel_slots_free",
          pendingWorkerCount: 1,
          // Bare — the whole point. A workerId here forces the targeted branch
          // and leaves parallel_dispatch dead config.
          continueWorkerId: null,
          parallelSlotFill: true
        })
      );
    });

    it("falls through to ordinary stall recovery when the bare continue starts nothing", async () => {
      // Non-negotiable: a dispatcher with zero running workers may be genuinely
      // stalled, and hub probe / relaunch / role reactivation / PM-resolver
      // spawn is the only thing that recovers it. Unlike the running>0 branch,
      // the slot-fill request here must NOT swallow the tick.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createValidatorHeldFixture();
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [planPathOf(harness.directory)],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency: 3 })
      });

      await watchdog.sweep();

      expect(stallCallback).toHaveBeenCalledTimes(2);
      expect(stallCallback.mock.calls[0]?.[0]).toMatchObject({
        parallelSlotFill: true,
        continueWorkerId: null
      });
      const recoveryCall = stallCallback.mock.calls[1]?.[0] as { parallelSlotFill?: boolean; continueWorkerId: string | null; dispatcherStatus: string };
      expect(recoveryCall.parallelSlotFill).toBeUndefined();
      expect(recoveryCall.continueWorkerId).toBe("C-02");
      expect(recoveryCall.dispatcherStatus).toBe("idle");
    });

    it("skips stall recovery when the bare parallel continue actually launched a worker", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient, store } = await createValidatorHeldFixture();
      // Simulate the launcher: the bare continue flips C-02 to running. The
      // watchdog re-reads the lifecycle store rather than trusting the void
      // callback return, so this is what it observes.
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockImplementation(async () => {
        const current = store.load();
        current.workers["C-02"] = {
          ...current.workers["C-02"]!,
          thread_id: "w-thread-c02",
          status: "running",
          started_at: "2026-04-03T13:59:00.000Z",
          last_seen_at: "2026-04-03T13:59:00.000Z"
        };
        store.save(current);
      });

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [planPathOf(harness.directory)],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency: 3 })
      });

      await watchdog.sweep();

      expect(stallCallback).toHaveBeenCalledTimes(1);
      expect(stallCallback.mock.calls[0]?.[0]).toMatchObject({ parallelSlotFill: true });
    });

    it("leaves the zero-running path untouched when the kill-switch is off", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));
      process.env.MERIDIAN_DISPATCH_AUTO_PARALLEL = "false";

      const { harness, hubClient } = await createValidatorHeldFixture();
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [planPathOf(harness.directory)],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency: 3 })
      });

      await watchdog.sweep();

      expect(stallCallback).toHaveBeenCalledTimes(1);
      expect(stallCallback.mock.calls[0]?.[0]).toMatchObject({
        continueWorkerId: "C-02",
        dispatcherStatus: "idle"
      });
    });

    it("leaves the zero-running path untouched for a non-parallel dispatcher", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createValidatorHeldFixture();
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      const watchdog = new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [planPathOf(harness.directory)],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: false, maxConcurrency: 3 })
      });

      await watchdog.sweep();

      expect(stallCallback).toHaveBeenCalledTimes(1);
      expect(stallCallback.mock.calls[0]?.[0]).toMatchObject({ continueWorkerId: "C-02" });
    });
  });

  describe("parallel slot occupancy accounting", () => {
    // The slot-fill gate used to compare `max_concurrency` against the NARROW
    // running count (`resolveBlockingRunningWorkers`, status === "running"
    // only). Three things hold a Hub lane while contributing zero to that
    // number:
    //   1. `awaiting_validation` — a validator agent is scoring the row on
    //      `validation.validator_thread_id`;
    //   2. `fix_requested` — reserved; the row flips back to `running` the
    //      moment feedback is delivered (observed live inside the same second);
    //   3. an active PM resolver thread (thread-id-reservation.ts already says
    //      so in prose — it reserves those ids against spawn collisions).
    // Result on a real round: peak concurrency 4 against `max_concurrency: 3`.
    //
    // Every test below comes in a pair on ONE fixture, changing only
    // `maxConcurrency`. The pairing is the point: the strict half proves
    // over-dispatch is refused, and the loose half is the regression guard for
    // the under-dispatch fix — an occupied-but-not-running lane must still
    // leave the REMAINING slots fillable, or we are back to 0.751/3 mean
    // concurrency and 38.7% zero-worker time.
    const planPathOf = (directory: string) => path.join(directory, "dispatch_plan.md");

    function buildWorkerState(
      status: LifecycleStatus,
      overrides: Partial<DispatchWorkerState> = {}
    ): DispatchWorkerState {
      return {
        thread_id: "w-thread",
        trace_id: null,
        started_at: "2026-04-03T13:00:00.000Z",
        last_seen_at: "2026-04-03T13:30:00.000Z",
        status,
        expected_outputs: [],
        hub_result: null,
        command_preamble: null,
        retry_count: 0,
        ...overrides
      };
    }

    function createWatchdog(
      directory: string,
      hubClient: A2AClient,
      stallCallback: ReturnType<typeof vi.fn>,
      maxConcurrency: number
    ) {
      return new ReconciliationWatchdog({
        resolveActiveDispatchPlanPaths: async () => [planPathOf(directory)],
        hubClient,
        log: silentLog(),
        intervalMs: 60_000,
        onDispatcherStalled: stallCallback,
        resolveParallelDispatchForPlan: async () => ({ enabled: true, maxConcurrency })
      });
    }

    function slotFillCalls(stallCallback: ReturnType<typeof vi.fn>): DispatcherStallInfo[] {
      return stallCallback.mock.calls
        .map((call) => call[0] as DispatcherStallInfo)
        .filter((info) => info.parallelSlotFill === true);
    }

    afterEach(() => {
      delete process.env.MERIDIAN_DISPATCH_AUTO_PARALLEL;
    });

    // ---------------------------------------------------------------------
    // 1. awaiting_validation alongside a running worker (the `mode: "running"`
    //    entry point). Narrow count is 1; true occupancy is 2.
    // ---------------------------------------------------------------------
    async function createRunningPlusValidatorFixture() {
      const harness = await createHarness();
      await fsp.writeFile(
        planPathOf(harness.directory),
        [
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| ✅ | 1 | W-00 | Finished gate | CODEX | — | Done. |",
          "| 🔄 | 2 | W-01 | Running worker | CODEX | W-00 | In flight. |",
          "| 🔍 | 2 | BATCH-GATE | Held by a validator | CODEX | W-00 | Report written. |",
          "| ⬜ | 2 | C-02 | Independent sibling | CODEX | W-00 | Ready to continue. |"
        ].join("\n"),
        "utf8"
      );

      const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
      store.save({
        ...buildEmptyDispatchThreadStateV2(),
        dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
        workers: {
          "W-00": buildWorkerState("completed", { thread_id: "w-thread-00" }),
          "W-01": buildWorkerState("running", { thread_id: "w-thread-01" }),
          "BATCH-GATE": buildWorkerState("awaiting_validation", {
            thread_id: "w-thread-gate",
            validation: {
              current_cycle: 0,
              max_fix_cycles: 3,
              validator_thread_id: "validator-thread-gate",
              last_score: null,
              last_feedback: null,
              history: []
            }
          }),
          "C-02": buildWorkerState("pending", { thread_id: "placeholder" })
        }
      });

      const { hubClient } = createHubClient((message) =>
        buildStatusResult(message.thread_id, message.thread_id === "d-01" ? "running" : "running")
      );
      return { harness, hubClient };
    }

    it("refuses a slot fill when running + awaiting_validation already fill max_concurrency", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createRunningPlusValidatorFixture();
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      // Pre-fix this fired: the narrow count was 1, so 1 < 2 read as "one slot
      // free" and C-02 was admitted as a THIRD agent against max_concurrency 2.
      await createWatchdog(harness.directory, hubClient, stallCallback, 2).sweep();

      expect(slotFillCalls(stallCallback)).toHaveLength(0);
      // The `blockingRunningWorkers > 0` branch still returns without touching
      // stall recovery, exactly as before — a running worker means progress.
      expect(stallCallback).not.toHaveBeenCalled();
    });

    it("still fills the remaining slot when a validator holds only one of three lanes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createRunningPlusValidatorFixture();
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      await createWatchdog(harness.directory, hubClient, stallCallback, 3).sweep();

      expect(slotFillCalls(stallCallback)).toHaveLength(1);
      expect(slotFillCalls(stallCallback)[0]).toMatchObject({
        dispatcherStatus: "running_parallel_slots_free",
        continueWorkerId: null,
        parallelSlotFill: true
      });
    });

    // ---------------------------------------------------------------------
    // 2. fix_requested with nothing running (the `mode: "idle"` entry point).
    //    Narrow count is 0 — which is exactly why the idle path must stay on
    //    the narrow count — but the lane is reserved.
    // ---------------------------------------------------------------------
    async function createFixRequestedFixture() {
      const harness = await createHarness();
      await fsp.writeFile(
        planPathOf(harness.directory),
        [
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| ✅ | 1 | W-00 | Finished gate | CODEX | — | Done. |",
          "| 🔁 | 2 | C-04a | Validator asked for a fix | CODEX | W-00 | Feedback pending delivery. |",
          "| ⬜ | 2 | C-02 | Independent sibling | CODEX | W-00 | Ready to continue. |"
        ].join("\n"),
        "utf8"
      );

      const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
      store.save({
        ...buildEmptyDispatchThreadStateV2(),
        dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
        workers: {
          "W-00": buildWorkerState("completed", { thread_id: "w-thread-00" }),
          "C-04a": buildWorkerState("fix_requested", {
            thread_id: "w-thread-c04a",
            validation: {
              current_cycle: 1,
              max_fix_cycles: 3,
              validator_thread_id: "validator-thread-c04a",
              last_score: null,
              last_feedback: "please fix the failing gate",
              history: []
            }
          }),
          "C-02": buildWorkerState("pending", { thread_id: "placeholder" })
        }
      });

      const { hubClient } = createHubClient((message) =>
        buildStatusResult(message.thread_id, message.thread_id === "d-01" ? "idle" : "running")
      );
      return { harness, hubClient };
    }

    it("refuses a slot fill when a fix_requested row reserves the only lane", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createFixRequestedFixture();
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      // fix_requested auto-transitions back to `running` on
      // `validator_feedback_delivered`, which the very next continueDispatcher
      // tick performs — so treating this as a free lane admits a second agent
      // against max_concurrency 1 for as long as feedback delivery takes.
      await createWatchdog(harness.directory, hubClient, stallCallback, 1).sweep();

      expect(slotFillCalls(stallCallback)).toHaveLength(0);
      // Non-negotiable: the idle path must still fall through to ordinary stall
      // recovery, otherwise the fix_requested row itself never gets serviced.
      expect(stallCallback).toHaveBeenCalledTimes(1);
      const recoveryCall = stallCallback.mock.calls[0]?.[0] as DispatcherStallInfo;
      expect(recoveryCall.continueWorkerId).toBe("C-04a");
      expect(recoveryCall.parallelSlotFill).toBeUndefined();
    });

    it("still fills the free lane when a fix_requested row reserves one of two", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createFixRequestedFixture();
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      await createWatchdog(harness.directory, hubClient, stallCallback, 2).sweep();

      expect(slotFillCalls(stallCallback)).toHaveLength(1);
      expect(slotFillCalls(stallCallback)[0]).toMatchObject({
        dispatcherStatus: "idle_parallel_slots_free",
        continueWorkerId: null
      });
    });

    // ---------------------------------------------------------------------
    // 3. An active PM resolver thread. The worker it owns is `blocked`, which
    //    is deliberately NOT slot-occupying (a wedged row must not burn a lane
    //    for hours) — the resolver thread is the live agent, so it is the one
    //    that counts.
    // ---------------------------------------------------------------------
    async function createPmResolverFixture(pmStatus: "running" | "completed") {
      const harness = await createHarness();
      await fsp.writeFile(
        planPathOf(harness.directory),
        [
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| ✅ | 1 | W-00 | Finished gate | CODEX | — | Done. |",
          "| ⬜ | 2 | C-02 | Independent sibling | CODEX | W-00 | Ready to continue. |"
        ].join("\n"),
        "utf8"
      );

      const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
      store.save({
        ...buildEmptyDispatchThreadStateV2(),
        dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
        workers: {
          "W-00": buildWorkerState("completed", { thread_id: "w-thread-00" }),
          "C-02": buildWorkerState("pending", { thread_id: "placeholder" })
        },
        pm_resolvers: [
          {
            thread_id: "pm-thread-01",
            status: pmStatus,
            started_at: "2026-04-03T13:58:00.000Z",
            last_seen_at: "2026-04-03T13:59:30.000Z",
            agent_type: "codex",
            model_id: "gpt-5.5 xhigh",
            mode: "bridge",
            auto_approve: true,
            issue: {
              status: "manual_intervention_required",
              worker_id: "W-BLOCKED",
              message: "manual intervention required",
              error: null,
              source: "dispatcher"
            },
            result: null,
            error: null,
            transport_error: null,
            marker_outcome: null,
            marker_pm_action: null
          }
        ]
      });

      const { hubClient } = createHubClient((message) =>
        buildStatusResult(message.thread_id, message.thread_id === "d-01" ? "idle" : "running")
      );
      return { harness, hubClient };
    }

    it("refuses a slot fill when an active PM resolver thread holds the only lane", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createPmResolverFixture("running");
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      await createWatchdog(harness.directory, hubClient, stallCallback, 1).sweep();

      expect(slotFillCalls(stallCallback)).toHaveLength(0);
    });

    it("fills the lane once that PM resolver has finished", async () => {
      // Same fixture, same max_concurrency — only the resolver's status
      // differs. This is what proves the resolver thread is what was counted,
      // rather than something incidental about the fixture.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_NOW));

      const { harness, hubClient } = await createPmResolverFixture("completed");
      const stallCallback = vi.fn<(info: DispatcherStallInfo) => Promise<void>>().mockResolvedValue(undefined);

      await createWatchdog(harness.directory, hubClient, stallCallback, 1).sweep();

      expect(slotFillCalls(stallCallback)).toHaveLength(1);
    });
  });

  it("continues when only the stale synthetic dispatcher worker is still marked running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ✅ | 1 | W-01 | Finished worker | CODEX | — | Done. |",
        "| ⬜ | 2 | W-02 | Next eligible worker | CODEX | W-01 | Ready to continue. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        DISPATCHER: {
          thread_id: "d-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-02": {
          thread_id: "placeholder",
          trace_id: null,
          started_at: "2026-04-03T12:10:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient((message) => {
      if (message.thread_id === "d-01") {
        return buildStatusResult(message.thread_id, "running");
      }

      return buildStatusResult(message.thread_id, "running");
    });
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "running_stale",
        pendingWorkerCount: 1,
        continueWorkerId: "W-02"
      })
    );
  });

  it("invokes onDispatcherStalled when a blocked worker needs PM handoff and no pending rows remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ⛔ BLOCKED | 1 | W-01 | Blocked worker | CODEX | — | Needs PM resolution. |"
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "abandoned" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).toHaveBeenCalledTimes(1);
    expect(stallCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPlanPath: path.join(harness.directory, "dispatch_plan.md"),
        dispatcherStatus: "abandoned",
        pendingWorkerCount: 0,
        continueWorkerId: "W-01"
      })
    );
  });

  it("does not invoke onDispatcherStalled when no pending workers remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "abandoned" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();
    expect(stallCallback).not.toHaveBeenCalled();
  });

  it("does not invoke onDispatcherStalled when only PM-blocked pending workers remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    await fsp.writeFile(
      path.join(harness.directory, "dispatch_plan.md"),
      [
        "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ✅ | 0 | PRE-FLIGHT | Environment health check | OPUS | — | Complete. |",
        "| ⬜ | 1 | R-02 | Pending PM decision | CODEX | PRE-FLIGHT | **⏳ BLOCKED: PM Blocker Resolution #1 must be confirmed first** |"
      ].join("\n"),
      "utf8"
    );
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "abandoned" },
      workers: {
        "PRE-FLIGHT": {
          thread_id: "preflight-thread",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();

    expect(stallCallback).not.toHaveBeenCalled();
  });

  it("does not invoke onDispatcherStalled when workers are still running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "abandoned" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-02": {
          thread_id: "placeholder",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("w-thread-01", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback
    });

    await watchdog.sweep();
    expect(stallCallback).not.toHaveBeenCalled();
  });

  it("does not invoke onDispatcherStalled when dispatcher is paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: null, started_at: null, status: "pending" },
      workers: {
        "W-01": {
          thread_id: "placeholder",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("t", "running"));
    const stallCallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      onDispatcherStalled: stallCallback,
      isDispatcherPaused: async () => true
    });

    await watchdog.sweep();
    expect(stallCallback).not.toHaveBeenCalled();
  });

  it("runs auto-resolve after reconciliation when autoResolveConfig is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    await fsp.writeFile(dispatchPlanPath, [
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 0 | PRE-FLIGHT | Env Check | SONNET | — | |",
      ""
    ].join("\n"), "utf8");

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"), {
      dispatchPlanPath
    });
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "PRE-FLIGHT": {
          thread_id: "w-thread-pf",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:10:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: {
            trace_id: "a0000000-0000-4000-a000-000000000001",
            thread_id: "w-thread-pf",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Status: ⛔ BLOCKED\n\nBaseline test suite failing on main.",
            attachments: [],
            timestamp: "2026-04-03T12:10:00.000Z"
          },
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() =>
      buildStatusResult("w-thread-pf", "completed")
    );

    const log = silentLog();
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPath],
      hubClient,
      log,
      intervalMs: 60_000,
      autoResolveConfig: {
        enabled: true,
        taskspecDir: harness.directory,
        maxAutoResolveAttempts: 1,
        humanEscalationPatterns: [/\bMISSING:/i]
      }
    });

    await watchdog.sweep();

    // Verify FIX task was generated
    const planContent = await fsp.readFile(dispatchPlanPath, "utf8");
    expect(planContent).toContain("FIX-PRE-FLIGHT");

    // Verify auto-resolve log was emitted
    expect(log.info).toHaveBeenCalledWith(
      "Auto-resolve completed",
      expect.objectContaining({
        generated: ["FIX-PRE-FLIGHT"]
      })
    );
  });

  it("logs changes detected during sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/W-01_report.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("w-thread-01", "completed"));

    vi.spyOn(reconciliationFs, "existsSync").mockReturnValue(true);
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({
      size: 100,
      mtimeMs: Date.parse(FIXED_NOW)
    } as ReturnType<typeof reconciliationFs.statSync>);

    const log = silentLog();
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log,
      intervalMs: 60_000
    });

    await watchdog.sweep();

    expect(log.info).toHaveBeenCalledWith(
      "Watchdog reconciliation detected changes",
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({ workerId: "W-01", to: "completed" })
        ])
      })
    );
  });

  it("kills a worker thread once the watchdog reconciles it to completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness("watchdog-terminal-cleanup-");
    const outputPath = await harness.writeOutput("dev_history/W-01_report.md");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-02": {
          thread_id: "w-thread-02",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient((message) => {
      if (message.thread_id === "w-thread-01") {
        return buildStatusResult(message.thread_id, "completed");
      }
      return buildStatusResult(message.thread_id, "running");
    });

    vi.spyOn(reconciliationFs, "existsSync").mockReturnValue(true);
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({
      size: 100,
      mtimeMs: Date.parse(FIXED_NOW)
    } as ReturnType<typeof reconciliationFs.statSync>);

    const killThread = vi.fn(async () => {});
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPath],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      resolveKillPolicyForDispatchPlan: async () => "always",
      killThread
    });

    await watchdog.sweep();

    expect(store.load().workers["W-01"]?.status).toBe("completed");
    expect(killThread).toHaveBeenCalledTimes(1);
    expect(killThread).toHaveBeenCalledWith("w-thread-01");
    // Subsequent sweeps must not re-kill the same thread.
    await watchdog.sweep();
    expect(killThread).toHaveBeenCalledTimes(1);
  });

  it("does not kill terminal workers when kill_policy is never", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness("watchdog-terminal-cleanup-never-");
    const outputPath = await harness.writeOutput("dev_history/W-01_report.md");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient((message) =>
      buildStatusResult(message.thread_id, "completed")
    );

    vi.spyOn(reconciliationFs, "existsSync").mockReturnValue(true);
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({
      size: 100,
      mtimeMs: Date.parse(FIXED_NOW)
    } as ReturnType<typeof reconciliationFs.statSync>);

    const killThread = vi.fn(async () => {});
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPath],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      resolveKillPolicyForDispatchPlan: async () => "never",
      killThread
    });

    await watchdog.sweep();

    expect(store.load().workers["W-01"]?.status).toBe("completed");
    expect(killThread).not.toHaveBeenCalled();
  });

  it("does not kill awaiting_validation workers or the dispatcher controller thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness("watchdog-terminal-cleanup-validation-");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        DISPATCHER: {
          thread_id: "d-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));

    const killThread = vi.fn(async () => {});
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPath],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      resolveKillPolicyForDispatchPlan: async () => "always",
      killThread
    });

    await watchdog.sweep();

    expect(killThread).not.toHaveBeenCalled();
  });

  it("does not kill an active validator thread that collides with a terminal worker's stale thread_id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness("watchdog-terminal-cleanup-validator-collision-");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    // Reproduces dispatcher 02972423: N-07 finished on codex_09 (terminal,
    // stale thread_id row), the Hub recycled the freed id, and the validator
    // orchestrator now tracks codex_09 as N-39's active validator thread. The
    // watchdog cleanup must skip codex_09 — killing it strands the validator
    // and the next continue tick spawns a duplicate (codex_10 in the bug).
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "N-07": {
          thread_id: "codex_09",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "N-39": {
          thread_id: "codex_42",
          trace_id: null,
          started_at: "2026-04-03T12:05:00.000Z",
          last_seen_at: "2026-04-03T12:05:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: "codex_09",
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("d-01", "running"));

    const killThread = vi.fn(async () => {});
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPath],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      resolveKillPolicyForDispatchPlan: async () => "always",
      killThread
    });

    await watchdog.sweep();

    expect(killThread).not.toHaveBeenCalledWith("codex_09");
  });

  it("does not kill a validator thread that collides with another active dispatch plan's stale terminal row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    // Reproduces dispatcher 9fd97803 C-11 cycle 2: the Hub recycled freed
    // thread_id codex_38 to plan A's live validator while plan B still had
    // a stale terminal row (BATCH-2-GATE) pointing at codex_38. The watchdog
    // sweeps plan B and its cleanup must NOT kill codex_38 even though plan
    // B's own state thinks codex_38 is a freed terminal-worker thread.
    const harnessA = await createHarness("watchdog-cross-plan-validator-collision-A-");
    const harnessB = await createHarness("watchdog-cross-plan-validator-collision-B-");
    const dispatchPlanPathA = path.join(harnessA.directory, "dispatch_plan.md");
    const dispatchPlanPathB = path.join(harnessB.directory, "dispatch_plan.md");

    const storeA = new LifecycleStore(path.join(harnessA.directory, "dispatch_threads.json"));
    storeA.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "dispatcher-A", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "C-11": {
          thread_id: "worker-thread-A",
          trace_id: null,
          started_at: "2026-04-03T12:05:00.000Z",
          last_seen_at: "2026-04-03T12:05:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: "codex_38",
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      }
    });

    const storeB = new LifecycleStore(path.join(harnessB.directory, "dispatch_threads.json"));
    storeB.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "dispatcher-B", started_at: "2026-04-03T11:00:00.000Z", status: "running" },
      workers: {
        "BATCH-2-GATE": {
          thread_id: "codex_38",
          trace_id: null,
          started_at: "2026-04-03T11:00:00.000Z",
          last_seen_at: "2026-04-03T11:30:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient(() => buildStatusResult("dispatcher-B", "running"));

    const killThread = vi.fn(async () => {});
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPathA, dispatchPlanPathB],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      resolveKillPolicyForDispatchPlan: async () => "always",
      killThread
    });

    await watchdog.sweep();

    expect(killThread).not.toHaveBeenCalledWith("codex_38");
  });

  it("marks a terminal thread cleaned when the hub reports it is no longer registered", async () => {
    // Regression: the watchdog's local missing-thread matcher only knew about
    // /not found/, /missing/, /unknown thread/ — it did not recognise the
    // hub's actual response wording (`Routing failed: No registered agent
    // instance found for thread_id=...`). Each watchdog tick therefore
    // re-attempted the same kill, producing the 315k+ "terminal worker
    // cleanup kill failed" warnings observed during 2026-05-18 incident.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness("watchdog-terminal-cleanup-missing-thread-");
    const outputPath = await harness.writeOutput("dev_history/W-01_report.md");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient((message) =>
      buildStatusResult(message.thread_id, "completed")
    );

    vi.spyOn(reconciliationFs, "existsSync").mockReturnValue(true);
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({
      size: 100,
      mtimeMs: Date.parse(FIXED_NOW)
    } as ReturnType<typeof reconciliationFs.statSync>);

    const killThread = vi.fn(async () => {
      throw new Error(
        "kill failed: Routing failed: No registered agent instance found for thread_id=w-thread-01"
      );
    });

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPath],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      resolveKillPolicyForDispatchPlan: async () => "always",
      killThread
    });

    await watchdog.sweep();
    expect(killThread).toHaveBeenCalledTimes(1);

    // The hub no longer knows about this thread; subsequent sweeps must not
    // re-attempt the same kill or the cleanup loop hammers the hub forever.
    await watchdog.sweep();
    expect(killThread).toHaveBeenCalledTimes(1);
  });

  it("backs off terminal-kill retries when the hub returns an IPC transport error", async () => {
    // Regression: when the hub starts returning
    //   "kill failed: Server error: IPC request completed without response body"
    // the missing-thread matcher correctly does NOT match (kill outcome
    // unknown), but the watchdog previously fell through to a per-tick retry.
    // On 2026-05-19 against agent-dispatcher-98b73906, the result was 315k+
    // "terminal worker cleanup kill failed" entries in 24h, which EPIPE'd
    // the hub's pino transport, dropped A2A response bodies, and stalled
    // /api/system-monitor and /api/continue-dispatcher. The cooldown bounds
    // retries to one per 60s per thread.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness("watchdog-terminal-cleanup-transport-stall-");
    const outputPath = await harness.writeOutput("dev_history/W-01_report.md");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const { hubClient } = createHubClient((message) =>
      buildStatusResult(message.thread_id, "completed")
    );

    vi.spyOn(reconciliationFs, "existsSync").mockReturnValue(true);
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({
      size: 100,
      mtimeMs: Date.parse(FIXED_NOW)
    } as ReturnType<typeof reconciliationFs.statSync>);

    const killThread = vi.fn(async () => {
      throw new Error(
        "kill failed: Server error: IPC request completed without response body"
      );
    });

    let nowMs = Date.parse(FIXED_NOW);
    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [dispatchPlanPath],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      resolveKillPolicyForDispatchPlan: async () => "always",
      killThread,
      now: () => nowMs
    });

    // First sweep: kill attempted once, transport error caught, cooldown set.
    await watchdog.sweep();
    expect(killThread).toHaveBeenCalledTimes(1);

    // Multiple sweeps at representative points within the cooldown must NOT
    // re-attempt the kill. Advancing the injected clock directly keeps this
    // behavior test independent of the cost of a full reconciliation sweep.
    for (const advanceMs of [1_000, 24_000, 25_000]) {
      nowMs += advanceMs; // 50 seconds total — still under the 60s window
      await watchdog.sweep();
    }
    expect(killThread).toHaveBeenCalledTimes(1);

    // After the cooldown window elapses, exactly one more attempt fires.
    nowMs += 15_000; // total elapsed > 60s
    await watchdog.sweep();
    expect(killThread).toHaveBeenCalledTimes(2);
  });
});

describe("ReconciliationWatchdog PM resolver liveness sweep", () => {
  it("preserves a newly-started hub-missing PM resolver during the spawn/run grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-fresh",
          status: "running",
          started_at: "2026-04-03T13:59:30.000Z",
          last_seen_at: "2026-04-03T13:59:30.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "dispatcher"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const hubSend = vi.fn((): HubResult => ({
      trace_id: "trace",
      thread_id: "pm-thread-fresh",
      source: "codex",
      status: "error",
      content: "unknown thread: no registered agent instance found for thread_id=pm-thread-fresh",
      attachments: [],
      timestamp: FIXED_NOW
    }));
    const { hubClient } = createHubClient(hubSend);
    const aliveSpy = vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread");

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find((e) => e.thread_id === "pm-thread-fresh");
    expect(entry?.status).toBe("running");
    expect(hubSend).not.toHaveBeenCalledWith(expect.objectContaining({ target: "pm-thread-fresh" }));
    expect(aliveSpy).not.toHaveBeenCalledWith("pm-thread-fresh");
  });

  it("evicts a stale PM resolver whose hub thread is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const storePath = path.join(harness.directory, "dispatch_threads.json");
    const store = new LifecycleStore(storePath);
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-stale",
          status: "running",
          started_at: "2026-04-03T12:30:00.000Z",
          last_seen_at: "2026-04-03T12:30:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "dispatcher"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const { hubClient } = createHubClient((message) => ({
      trace_id: "trace",
      thread_id: message.target,
      source: "codex",
      status: "error",
      content: `unknown thread: no registered agent instance found for thread_id=${message.target}`,
      attachments: [],
      timestamp: FIXED_NOW
    }));

    vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread").mockReturnValue(false);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find((e) => e.thread_id === "pm-thread-stale");
    expect(entry?.status).toBe("failed");
  });

  it("preserves a hub-missing PM resolver whose agentapi codex process is still alive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-orphan",
          status: "running",
          started_at: "2026-04-03T13:55:00.000Z",
          last_seen_at: "2026-04-03T13:55:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "dispatcher"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const { hubClient } = createHubClient((message) => ({
      trace_id: "trace",
      thread_id: message.target,
      source: "codex",
      status: "error",
      content: `unknown thread: no registered agent instance found for thread_id=${message.target}`,
      attachments: [],
      timestamp: FIXED_NOW
    }));

    vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread").mockReturnValue(true);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find((e) => e.thread_id === "pm-thread-orphan");
    expect(entry?.status).toBe("running");
  });

  it("preserves a PM resolver whose hub thread is still live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-live",
          status: "running",
          started_at: "2026-04-03T13:55:00.000Z",
          last_seen_at: "2026-04-03T13:55:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "dispatcher"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const { hubClient } = createHubClient((message) => buildStatusResult(message.target, "running"));
    const aliveSpy = vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread");

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find((e) => e.thread_id === "pm-thread-live");
    expect(entry?.status).toBe("running");
    expect(aliveSpy).not.toHaveBeenCalled();
  });

  it("demotes a stale no-progress PM resolver even when the hub still reports running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-no-progress",
          status: "running",
          started_at: "2026-04-03T13:30:00.000Z",
          last_seen_at: "2026-04-03T13:30:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "dispatcher"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const { hubClient } = createHubClient((message) => buildStatusResult(message.target, "running"));
    const killThread = vi.fn<(threadId: string) => Promise<void>>().mockResolvedValue();

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000,
      killThread
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find((e) => e.thread_id === "pm-thread-no-progress");
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toMatch(new RegExp(`^${PM_RESOLVER_NO_PROGRESS_ERROR_PREFIX}`));
    expect(killThread).toHaveBeenCalledWith("pm-thread-no-progress");
  });

  // Regression: agent-dispatcher-67f6a3fc V-01-A 2026-05-15 PM respawn storm.
  // `recordPmResolverTransportStall` retains a `running` entry with
  // `transport_error` set when meridianApi.run rejects with hub-overload /
  // request-timeout language. The PM agent never attached, so a hub probe
  // returns `missing` and the unguarded sweep used to demote the entry to
  // `failed`. That re-opened the watchdog/pm-resolve respawn gate, which
  // spawned a fresh PM that hit the same overloaded hub and re-stalled —
  // observed as codex_08→codex_10→codex_11 stacked within 4 minutes.
  //
  // Bounded-retry contract (P-2 from the 2026-06-05 stuck-recovery handoff):
  // inside the `PM_RESOLVER_TRANSPORT_STALL_GRACE_MS` grace we preserve as
  // before; past the grace we demote so the dispatcher can spawn a fresh PM
  // — until we hit `PM_RESOLVER_TRANSPORT_STALL_MAX_RETRIES`, at which point
  // we revert to the original preserve-for-human-takeover behavior.
  it("preserves a transport-stalled PM resolver while inside the grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-transport-stalled",
          status: "running",
          started_at: "2026-04-03T13:59:45.000Z",
          // Inside 60s grace from FIXED_NOW (14:00:00).
          last_seen_at: "2026-04-03T13:59:45.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: "run failed: Request timed out — the hub may be overloaded.",
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const hubSend = vi.fn((message: HubMessage) => buildStatusResult(message.target ?? "", "running"));
    const { hubClient } = createHubClient(hubSend);
    const aliveSpy = vi.spyOn(activeToolProcess, "isAgentapiProcessAliveForThread");

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find(
      (e) => e.thread_id === "pm-thread-transport-stalled"
    );
    expect(entry?.status).toBe("running");
    expect(entry?.transport_error).toBe(
      "run failed: Request timed out — the hub may be overloaded."
    );
    const pmTargetedCalls = hubSend.mock.calls.filter(
      ([message]) => (message as { target?: string } | undefined)?.target === "pm-thread-transport-stalled"
    );
    expect(pmTargetedCalls).toHaveLength(0);
    expect(aliveSpy).not.toHaveBeenCalled();
  });

  it("demotes a transport-stalled PM resolver past the grace window when retries remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "pm-thread-transport-stale",
          status: "running",
          started_at: "2026-04-03T12:30:00.000Z",
          // 90 minutes past FIXED_NOW — far past the 60s grace.
          last_seen_at: "2026-04-03T12:30:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: "run failed: Request timed out — the hub may be overloaded.",
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const hubSend = vi.fn((message: HubMessage) => buildStatusResult(message.target ?? "", "running"));
    const { hubClient } = createHubClient(hubSend);

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find(
      (e) => e.thread_id === "pm-thread-transport-stale"
    );
    expect(entry?.status).toBe("failed");
    expect(entry?.transport_error).toBeNull();
    expect(entry?.error).toMatch(/^transport_stall_demoted_by_watchdog:/);
    const pmTargetedCalls = hubSend.mock.calls.filter(
      ([message]) => (message as { target?: string } | undefined)?.target === "pm-thread-transport-stale"
    );
    expect(pmTargetedCalls).toHaveLength(0);
  });

  it("preserves a transport-stalled PM resolver once the retry cap is reached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    const priorDemotion = (suffix: string, lastSeenAt: string) => ({
      thread_id: `pm-thread-prior-${suffix}`,
      status: "failed" as const,
      started_at: "2026-04-03T12:30:00.000Z",
      last_seen_at: lastSeenAt,
      agent_type: "codex",
      model_id: "gpt-5.5 xhigh",
      mode: "bridge",
      auto_approve: true,
      issue: {
        status: "manual_intervention_required",
        worker_id: "W-01",
        message: "manual intervention required",
        error: null,
        source: "watchdog"
      },
      result: null,
      error: "transport_stall_demoted_by_watchdog: attempt=1 reason=run failed: timeout",
      transport_error: null,
      marker_outcome: null,
      marker_pm_action: null
    });
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "d-01", started_at: "2026-04-03T12:00:00.000Z", status: "running" },
      workers: {
        "W-01": {
          thread_id: "w-thread-01",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        priorDemotion("a", "2026-04-03T12:31:00.000Z"),
        priorDemotion("b", "2026-04-03T12:35:00.000Z"),
        priorDemotion("c", "2026-04-03T12:40:00.000Z"),
        {
          thread_id: "pm-thread-transport-stale-final",
          status: "running",
          started_at: "2026-04-03T12:45:00.000Z",
          last_seen_at: "2026-04-03T12:45:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "W-01",
            message: "manual intervention required",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: "run failed: Request timed out — the hub may be overloaded.",
          marker_outcome: null,
          marker_pm_action: null
        }
      ]
    });

    const { hubClient } = createHubClient(() => buildStatusResult("ignored", "running"));

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [
        path.join(harness.directory, "dispatch_plan.md")
      ],
      hubClient,
      log: silentLog(),
      intervalMs: 60_000
    });

    await watchdog.sweep();

    const nextState = store.load();
    const entry = (nextState.pm_resolvers ?? []).find(
      (e) => e.thread_id === "pm-thread-transport-stale-final"
    );
    expect(entry?.status).toBe("running");
    expect(entry?.transport_error).toBe(
      "run failed: Request timed out — the hub may be overloaded."
    );
  });
});

describe("continueDispatchWorker", () => {
  it("retries an abandoned worker through the shared continuation contract before relaunching", async () => {
    const harness = await createHarness("continue-worker-abandoned-");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const commandFilePath = path.join(harness.directory, "agent_dispatch_command.md");
    const lifecycleStore = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"), {
      dispatchPlanPath
    });

    await fsp.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ⚠️ ABANDONED | Ω+1 | R-04A | Recovery | CODEX | DELTA-CHECK | stale watchdog recovery |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "dispatcher-thread-1", started_at: FIXED_NOW, status: "abandoned" },
      workers: {
        "R-04A": {
          thread_id: "worker-thread-stale",
          trace_id: null,
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const killSpy = vi.spyOn(killTool, "execute").mockResolvedValue({
      ok: true,
      data: {
        thread_id: "worker-thread-stale"
      }
    });
    const launchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "worker-thread-relaunched"
    }));

    try {
      const result = await continueDispatchWorker({
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: commandFilePath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: false
      }, [
        {
          status: "⚠️ ABANDONED",
          worker: "R-04A",
          model: "CODEX"
        }
      ], "R-04A", launchWorker);

      expect(result).toEqual({
        ok: true,
        workerId: "R-04A",
        threadId: "worker-thread-relaunched",
        resumeResult: {
          worker: "R-04A",
          action: "retry",
          status: "pending",
          thread_id: "worker-thread-stale",
          thread_killed: true,
          retry_count: 1
        }
      });
      expect(killSpy).toHaveBeenCalledWith({
        thread_id: "worker-thread-stale"
      });
      expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
        workerId: "R-04A",
        dispatchPlanPath,
        commandFilePath
      }));
      // After the launch-initiated synchronous lifecycle write, the row
      // reflects 🔄 immediately (no more pre-recordWorkerStart ⬜
      // window). retry_count was bumped from 0→1 by resume_worker, then
      // again would be bumped by the launch-initiated write — but the
      // launch-initiated path sees previousStatus="pending" (set by
      // resume_worker) and shouldIncrementRetry only fires for
      // failed/blocked/abandoned, so retry_count stays at 1.
      await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| 🔄 | Ω+1 | R-04A | Recovery | CODEX | DELTA-CHECK | stale watchdog recovery |"
      );
      expect(lifecycleStore.load().workers["R-04A"]).toMatchObject({
        status: "running",
        retry_count: 1
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it("keeps the worker pending when relaunch bootstrap fails after a retry", async () => {
    const harness = await createHarness("continue-worker-failed-");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const commandFilePath = path.join(harness.directory, "agent_dispatch_command.md");
    const sidecarPath = path.join(harness.directory, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath
    });

    await fsp.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ❌ | Ω+1 | R-04B | Recovery | CODEX | DELTA-CHECK | bootstrap failed |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "dispatcher-thread-1", started_at: FIXED_NOW, status: "abandoned" },
      workers: {
        "R-04B": {
          thread_id: "worker-thread-failed",
          trace_id: null,
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "failed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 1
        }
      }
    });

    const killSpy = vi.spyOn(killTool, "execute").mockResolvedValue({
      ok: true,
      data: {
        thread_id: "worker-thread-failed"
      }
    });
    const launchWorker = vi.fn(async () => ({
      ok: false,
      threadId: "",
      error: "spawn failed: Command failed: listen EPERM: operation not permitted /tmp/tsx-501/84525.pipe"
    }));

    try {
      const result = await continueDispatchWorker({
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: commandFilePath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: false
      }, [
        {
          status: "❌",
          worker: "R-04B",
          model: "CODEX"
        }
      ], "R-04B", launchWorker);

      expect(result).toEqual({
        ok: false,
        workerId: "R-04B",
        error: "spawn failed: Command failed: listen EPERM: operation not permitted /tmp/tsx-501/84525.pipe",
        localToolBootstrapFailure: true
      });
      expect(killSpy).toHaveBeenCalledWith({
        thread_id: "worker-thread-failed"
      });
      await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| ⬜ | Ω+1 | R-04B | Recovery | CODEX | DELTA-CHECK | bootstrap failed |"
      );
      expect(lifecycleStore.load().workers["R-04B"]).toMatchObject({
        thread_id: "worker-thread-failed",
        status: "pending",
        retry_count: 2
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it("does not relaunch a stale running worker at all (short-circuit on running+thread)", async () => {
    const harness = await createHarness("continue-worker-stale-running-");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const commandFilePath = path.join(harness.directory, "agent_dispatch_command.md");
    const lifecycleStore = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"), {
      dispatchPlanPath
    });

    await fsp.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 🔄 | 0 | PRE-FLIGHT | Environment health check | OPUS | — | Report-only worker |"
    ].join("\n"), "utf8");
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: { thread_id: "dispatcher-thread-1", started_at: FIXED_NOW, status: "running" },
      workers: {
        "PRE-FLIGHT": {
          thread_id: "codex_03",
          trace_id: "9639d2dd-431f-430a-81de-84c3c4b6d980",
          started_at: "2026-04-15T08:07:08.491Z",
          last_seen_at: "2026-04-15T08:08:09.840Z",
          status: "running",
          expected_outputs: [path.join(harness.directory, "reports", "PRE-FLIGHT.md")],
          hub_result: {
            trace_id: "9639d2dd-431f-430a-81de-84c3c4b6d980",
            thread_id: "codex_03",
            source: "codex",
            status: "partial",
            run_state: "still_running",
            content: "Task is running...",
            summary_text: "Task is running...",
            details_text: "",
            attachments: [],
            timestamp: "2026-04-15T08:08:09.840Z"
          },
          command_preamble: null,
          retry_count: 2
        }
      }
    });

    const killSpy = vi.spyOn(killTool, "execute").mockResolvedValue({
      ok: true,
      data: {
        thread_id: "codex_03"
      }
    });
    const launchWorker = vi.fn(async () => ({
      ok: false,
      threadId: "",
      error: "run launch failed: ENOENT"
    }));

    try {
      const result = await continueDispatchWorker({
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: commandFilePath,
        dispatch_repo_root: harness.directory,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: false
      }, [
        {
          status: "🔄",
          worker: "PRE-FLIGHT",
          model: "OPUS"
        }
      ], "PRE-FLIGHT", launchWorker);

      // New behavior (regression fix for agent-dispatcher-4db5c870): a
      // worker already in lifecycle status `running` with a thread_id is
      // assumed to be the responsibility of the reconciler / watchdog
      // probe, not a candidate for relaunch. Short-circuit returns the
      // existing thread without calling launchWorker, killing, or
      // resetting any state. This is precisely the behavior that prevents
      // the parallel-spawn footprint the operator reported (every
      // continue tick stacking another agent on the same task).
      expect(result).toEqual({
        ok: true,
        workerId: "PRE-FLIGHT",
        threadId: "codex_03"
      });
      expect(launchWorker).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      // Lifecycle row is left untouched — same status, thread_id,
      // retry_count, hub_result. Plan markdown row should also stay 🔄.
      const preflightAfter = lifecycleStore.load().workers["PRE-FLIGHT"];
      expect(preflightAfter).toMatchObject({
        thread_id: "codex_03",
        status: "running",
        retry_count: 2
      });
      await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| 🔄 | 0 | PRE-FLIGHT | Environment health check | OPUS | — | Report-only worker |"
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it("launches legacy OPUS workers with an implicit Claude Opus mapping", async () => {
    const harness = await createHarness("continue-worker-legacy-opus-");
    const dispatchPlanPath = path.join(harness.directory, "dispatch_plan.md");
    const commandFilePath = path.join(harness.directory, "agent_dispatch_command.md");

    await fsp.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Model | Code | Assign When |",
      "| --- | --- | --- |",
      "| Claude Opus | OPUS | Complex coordination |",
      "| Codex | CODEX | Surgical edits |",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ⬜ | 0 | PRE-FLIGHT | Environment health check | OPUS | — | Launch the first worker |"
    ].join("\n"), "utf8");

    const launchWorker = vi.fn(async () => ({
      ok: true,
      threadId: "claude_02"
    }));

    const result = await continueDispatchWorker({
      dispatch_plan_path: dispatchPlanPath,
      command_file_path: commandFilePath,
      dispatch_repo_root: harness.directory,
      mode: "bridge",
      agent_type: "codex",
      kill_policy: "always",
      auto_approve: false
    }, [
      {
        status: "⬜",
        worker: "PRE-FLIGHT",
        model: "OPUS"
      }
    ], "PRE-FLIGHT", launchWorker);

    expect(result).toEqual({
      ok: true,
      workerId: "PRE-FLIGHT",
      threadId: "claude_02"
    });
    expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "claude",
      modelId: "claude-opus-4-7",
      dispatchRepoRoot: harness.directory,
      workerId: "PRE-FLIGHT"
    }));
  });
});

describe("ReconciliationWatchdog PM-resolver exhausted self-loop guard", () => {
  // Reproduces agent-dispatcher-f0953280 / R-04 (skills-ux-h1, 2026-06-01).
  // Without the fix the watchdog re-detected the stalled dispatcher every
  // ~2 minutes for 12 days because the failed PM resolver kept the worker
  // in the manual-intervention queue while the per-issue dedup blocked
  // respawn. The fix has two halves we assert here:
  //   1. resolveManualInterventionWorker now skips the worker — so the
  //      onDispatcherStalled callback is never invoked (no
  //      "Watchdog detected stalled dispatcher" log).
  //   2. The watchdog emits the new structured log line
  //      `dispatcher_pm_resolver_exhausted` exactly once per
  //      (dispatchPlanPath, workerId) so the system-monitor card can
  //      surface the dispatcher to the operator without flooding.

  const PLAN_MARKDOWN = [
    "| Status | Batch | Worker | Model | Depends_On | Task |",
    "| --- | --- | --- | --- | --- | --- |",
    "| ⛔ BLOCKED | 1 | R-04 | gpt-5.5::xhigh | R-01 | blocked task |",
    ""
  ].join("\n");

  async function setupExhaustedPmResolverHarness() {
    const harness = await createHarness("watchdog-exhausted-pm-");
    const planPath = path.join(harness.directory, "dispatch_plan.md");
    await fsp.writeFile(planPath, PLAN_MARKDOWN, "utf8");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: {
        thread_id: "agent-dispatcher-f0953280",
        started_at: "2026-05-31T06:45:59.788Z",
        status: "running"
      },
      workers: {
        "R-04": {
          thread_id: "codex_438",
          trace_id: null,
          started_at: "2026-05-31T11:45:34.048Z",
          last_seen_at: "2026-05-31T12:00:20.773Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 1
        }
      },
      pm_resolvers: [
        {
          thread_id: "codex_440",
          status: "failed",
          started_at: "2026-05-31T11:49:15.079Z",
          last_seen_at: "2026-05-31T11:57:08.305Z",
          agent_type: "codex",
          model_id: null,
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "R-04",
            message: "manual intervention required: R-04 reported a blocking failure",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: "escalated",
          marker_pm_action: "escalate_human"
        }
      ]
    });
    return { harness, planPath };
  }

  it("does not fire the stall-detection callback when PM resolver is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const { harness, planPath } = await setupExhaustedPmResolverHarness();
    const { hubClient } = createHubClient(() => ({
      trace_id: "trace",
      thread_id: "agent-dispatcher-f0953280",
      source: "codex",
      status: "success",
      content: "",
      attachments: [],
      timestamp: FIXED_NOW
    }));
    const onDispatcherStalled = vi.fn(async () => {});
    const log = silentLog();

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [planPath],
      hubClient,
      log,
      intervalMs: 60_000,
      onDispatcherStalled
    });

    await watchdog.sweep();
    await watchdog.sweep();

    expect(onDispatcherStalled).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalledWith(
      "Watchdog detected stalled dispatcher with recoverable workers",
      expect.anything()
    );
    expect(harness.directory).toBeTruthy(); // silence unused warning
  });

  it("emits dispatcher_pm_resolver_exhausted exactly once per (plan, worker) across multiple sweeps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const { planPath } = await setupExhaustedPmResolverHarness();
    const { hubClient } = createHubClient(() => ({
      trace_id: "trace",
      thread_id: "agent-dispatcher-f0953280",
      source: "codex",
      status: "success",
      content: "",
      attachments: [],
      timestamp: FIXED_NOW
    }));
    const log = silentLog();

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [planPath],
      hubClient,
      log,
      intervalMs: 60_000
    });

    await watchdog.sweep();
    await watchdog.sweep();
    await watchdog.sweep();

    const exhaustedCalls = log.info.mock.calls.filter(
      ([message]) => message === "dispatcher_pm_resolver_exhausted"
    );
    expect(exhaustedCalls).toHaveLength(1);
    expect(exhaustedCalls[0]?.[1]).toEqual(expect.objectContaining({
      event: "dispatcher_pm_resolver_exhausted",
      dispatchPlanPath: planPath,
      dispatcherThreadId: "agent-dispatcher-f0953280",
      workerId: "R-04",
      issueStatus: "manual_intervention_required"
    }));
  });

  it("re-arms the one-shot log when the PM resolver transitions back to running (operator action)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const { harness, planPath } = await setupExhaustedPmResolverHarness();
    const storePath = path.join(harness.directory, "dispatch_threads.json");
    const store = new LifecycleStore(storePath);
    const { hubClient } = createHubClient(() => ({
      trace_id: "trace",
      thread_id: "agent-dispatcher-f0953280",
      source: "codex",
      status: "success",
      content: "",
      attachments: [],
      timestamp: FIXED_NOW
    }));
    const log = silentLog();

    const watchdog = new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [planPath],
      hubClient,
      log,
      intervalMs: 60_000
    });

    await watchdog.sweep();
    expect(log.info.mock.calls.filter(([m]) => m === "dispatcher_pm_resolver_exhausted")).toHaveLength(1);

    // Simulate operator action: a fresh PM resolver thread starts for the
    // same issue (the worker is no longer exhausted).
    const refreshed = store.load();
    refreshed.pm_resolvers = [
      ...(refreshed.pm_resolvers ?? []),
      {
        thread_id: "codex_900",
        status: "running",
        started_at: "2026-06-01T03:00:00.000Z",
        last_seen_at: "2026-06-01T03:00:00.000Z",
        agent_type: "codex",
        model_id: null,
        mode: "bridge",
        auto_approve: true,
        issue: {
          status: "manual_intervention_required",
          worker_id: "R-04",
          message: "fresh attempt",
          error: null,
          source: "watchdog"
        },
        result: null,
        error: null,
        transport_error: null,
        marker_outcome: null,
        marker_pm_action: null
      }
    ];
    store.save(refreshed);
    await watchdog.sweep();

    // Resolver back to failed → the key should be re-armed and the next
    // sweep should emit exactly one more log line, not stay silent.
    const reExhausted = store.load();
    reExhausted.pm_resolvers = (reExhausted.pm_resolvers ?? []).map((resolver) =>
      resolver.thread_id === "codex_900"
        ? { ...resolver, status: "failed", last_seen_at: "2026-06-01T03:05:00.000Z" }
        : resolver
    );
    store.save(reExhausted);
    await watchdog.sweep();

    expect(log.info.mock.calls.filter(([m]) => m === "dispatcher_pm_resolver_exhausted")).toHaveLength(2);
  });
});

// Regression: unification-layer-decoupling-2026-08-06 / BATCH-8-GATE. The
// watchdog is the automatic driver of targeted continues, and it has three
// doors into one: the service-continue resolver, the VALIDATION-continue
// resolver, and the manual-intervention resolver. The parked row cycled back
// through the validation door four times (fix_requested -> relaunch -> validate
// -> fix_requested) while `human_resolution` stayed null.
describe("ReconciliationWatchdog human-escalation freeze", () => {
  const FROZEN_PLAN = [
    "| Status | Batch | Worker | Model | Depends_On | Task |",
    "| --- | --- | --- | --- | --- | --- |",
    // Markdown reads ✅ (synced before the validator sent it back), so the ONLY
    // resolver that can select this row is the validation-continue one.
    "| ✅ | 1 | BATCH-8-GATE | gpt-5.5::xhigh | — | escalated gate |",
    ""
  ].join("\n");

  async function setupFrozenHarness(options: {
    humanResolution?: { resolved_at: string; note: string | null };
    workerStatus?: LifecycleStatus;
  } = {}) {
    const harness = await createHarness("watchdog-human-escalation-");
    const planPath = path.join(harness.directory, "dispatch_plan.md");
    await fsp.writeFile(planPath, FROZEN_PLAN, "utf8");
    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: {
        thread_id: "agent-dispatcher-unification",
        started_at: "2026-08-06T18:00:00.000Z",
        status: "pending"
      },
      workers: {
        "BATCH-8-GATE": {
          thread_id: "codex_71",
          trace_id: null,
          started_at: "2026-08-06T21:02:11.000Z",
          last_seen_at: "2026-08-06T22:40:00.000Z",
          status: options.workerStatus ?? "fix_requested",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 1,
          ...(options.humanResolution ? { human_resolution: options.humanResolution } : {})
        }
      },
      pm_resolvers: [
        {
          thread_id: "codex_69",
          status: "failed",
          started_at: "2026-08-06T20:50:00.000Z",
          last_seen_at: "2026-08-06T20:58:53.000Z",
          agent_type: "codex",
          model_id: null,
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "BATCH-8-GATE",
            message: "manual intervention required",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: "escalated",
          marker_pm_action: "escalate_human"
        }
      ]
    });
    return { harness, planPath, store };
  }

  function buildWatchdog(planPath: string, log: ReturnType<typeof silentLog>, onDispatcherStalled?: ReturnType<typeof vi.fn>) {
    const { hubClient } = createHubClient(() => ({
      trace_id: "trace",
      thread_id: "agent-dispatcher-unification",
      source: "codex",
      status: "success",
      content: "",
      attachments: [],
      timestamp: FIXED_NOW
    }));
    return new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [planPath],
      hubClient,
      log,
      intervalMs: 60_000,
      ...(onDispatcherStalled ? { onDispatcherStalled } : {})
    });
  }

  it("never selects a frozen row through the validation-continue door", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T23:00:00.000Z"));

    const { planPath } = await setupFrozenHarness();
    const onDispatcherStalled = vi.fn(async () => {});
    const log = silentLog();

    await buildWatchdog(planPath, log, onDispatcherStalled).sweep();

    expect(onDispatcherStalled).not.toHaveBeenCalled();
  });

  it("selects it again once /human-resolve releases the escalation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T23:00:00.000Z"));

    const { planPath } = await setupFrozenHarness({
      humanResolution: { resolved_at: "2026-08-06T22:50:00.000Z", note: "operator released" }
    });
    const onDispatcherStalled = vi.fn(async () => {});
    const log = silentLog();

    await buildWatchdog(planPath, log, onDispatcherStalled).sweep();

    expect(onDispatcherStalled).toHaveBeenCalledWith(expect.objectContaining({
      continueWorkerId: "BATCH-8-GATE"
    }));
  });

  it("emits dispatcher_awaiting_human_resolution as a throttled heartbeat, not once and never again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T23:00:00.000Z"));

    const { planPath } = await setupFrozenHarness();
    const log = silentLog();
    const watchdog = buildWatchdog(planPath, log);

    await watchdog.sweep();
    await watchdog.sweep();
    await watchdog.sweep();

    const parkedCalls = () => log.info.mock.calls.filter(
      ([message]) => message === "dispatcher_awaiting_human_resolution"
    );
    expect(parkedCalls()).toHaveLength(1);
    expect(parkedCalls()[0]?.[1]).toEqual(expect.objectContaining({
      event: "dispatcher_awaiting_human_resolution",
      dispatchPlanPath: planPath,
      workerId: "BATCH-8-GATE",
      pmResolverThreadId: "codex_69",
      escalatedAt: "2026-08-06T20:58:53.000Z",
      lastHumanResolvedAt: null
    }));

    // Inside the throttle window: still one line.
    vi.setSystemTime(new Date("2026-08-06T23:10:00.000Z"));
    await watchdog.sweep();
    expect(parkedCalls()).toHaveLength(1);

    // Past the window: the park is still live, so it must be re-announced.
    vi.setSystemTime(new Date("2026-08-06T23:20:00.000Z"));
    await watchdog.sweep();
    expect(parkedCalls()).toHaveLength(2);
  });

  it("stops announcing once the escalation is released", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T23:00:00.000Z"));

    const { planPath, store } = await setupFrozenHarness();
    const log = silentLog();
    const watchdog = buildWatchdog(planPath, log);

    await watchdog.sweep();
    expect(log.info.mock.calls.filter(([m]) => m === "dispatcher_awaiting_human_resolution")).toHaveLength(1);

    const released = store.load();
    released.workers["BATCH-8-GATE"]!.human_resolution = {
      resolved_at: "2026-08-06T23:05:00.000Z",
      note: null
    };
    store.save(released);

    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    await watchdog.sweep();

    expect(log.info.mock.calls.filter(([m]) => m === "dispatcher_awaiting_human_resolution")).toHaveLength(1);
  });

  // Regression: W1-03 / C-04b, observed 2026-08-10. Both rows were escalated to
  // a human, then concluded by another route (operator retry, PM
  // force_complete) that never stamps `human_resolution` — so the escalation
  // entry stayed unreleased and the heartbeat re-announced them on every sweep,
  // one of them with `parkedForMs: 204240274` (~56h). A permanent backlog of
  // long-concluded rows is exactly what drowns the signal the heartbeat exists
  // to give.
  it.each(["completed", "skipped"] as const)(
    "never heartbeats a %s row whose escalation was never formally released",
    async (workerStatus) => {
      vi.useFakeTimers();
      // Two days after the escalation — the W1-03 shape.
      vi.setSystemTime(new Date("2026-08-08T23:00:00.000Z"));

      const { planPath } = await setupFrozenHarness({ workerStatus });
      const log = silentLog();
      const watchdog = buildWatchdog(planPath, log);

      await watchdog.sweep();
      vi.setSystemTime(new Date("2026-08-09T23:00:00.000Z"));
      await watchdog.sweep();

      expect(log.info.mock.calls.filter(([m]) => m === "dispatcher_awaiting_human_resolution")).toHaveLength(0);
    }
  );

  it("still heartbeats a blocked row — a blocked escalation is the genuine park", async () => {
    vi.useFakeTimers();
    // Same two-day-old escalation as the suppressed case above: the difference
    // is the row's STATE, never its age.
    vi.setSystemTime(new Date("2026-08-08T23:00:00.000Z"));

    const { planPath } = await setupFrozenHarness({ workerStatus: "blocked" });
    const log = silentLog();

    await buildWatchdog(planPath, log).sweep();

    const parked = log.info.mock.calls.filter(([m]) => m === "dispatcher_awaiting_human_resolution");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.[1]).toEqual(expect.objectContaining({
      workerId: "BATCH-8-GATE",
      escalatedAt: "2026-08-06T20:58:53.000Z"
    }));
  });
});

// Regression: unification-layer-decoupling-2026-08-06 / I-02..I-06. The
// watchdog is the automatic driver of targeted continues, so a row whose
// Context Capsule is still `⏳ 待物化` must never become `continueWorkerId` —
// and while it is parked, the operator must be told, because the markdown reads
// ⬜ and the lifecycle reads `pending`: indistinguishable from ordinary queueing
// without a signal.
describe("ReconciliationWatchdog materialization precondition", () => {
  const PLACEHOLDER =
    "⏳ **待物化** —— 依赖行：I-01。其实际 SHA 由 `BATCH-98-GATE`（本波 Integrator）在派发本波前填入。";

  const HELD_PLAN = [
    "| Status | Batch | Worker | Model | Depends_On | Task |",
    "| --- | --- | --- | --- | --- | --- |",
    "| ✅ | 9 | I-01 | gpt-5.5::xhigh | — | contract |",
    "| ⬜ | 9 | I-02 | gpt-5.5::xhigh | I-01 | resolver |",
    ""
  ].join("\n");

  async function setupHeldHarness(options: { materialized?: boolean } = {}) {
    const harness = await createHarness("watchdog-materialization-");
    const planPath = path.join(harness.directory, "dispatch_plan.md");
    await fsp.writeFile(planPath, HELD_PLAN, "utf8");
    await fsp.mkdir(path.join(harness.directory, "context"), { recursive: true });
    await fsp.writeFile(
      path.join(harness.directory, "context", "I-02-context.md"),
      [
        "# I-02 Context Capsule",
        "",
        "## Upstream Inputs",
        "",
        options.materialized
          ? "I-01@7712e542d71d0f48e1cf81f0922547d72b46ef00"
          : PLACEHOLDER,
        ""
      ].join("\n"),
      "utf8"
    );

    const store = new LifecycleStore(path.join(harness.directory, "dispatch_threads.json"));
    store.save({
      ...buildEmptyDispatchThreadStateV2(),
      dispatcher: {
        thread_id: "agent-dispatcher-uld",
        started_at: "2026-08-11T09:00:00.000Z",
        status: "pending"
      },
      workers: {
        "I-01": {
          thread_id: "codex_10",
          trace_id: null,
          started_at: "2026-08-11T09:10:00.000Z",
          last_seen_at: "2026-08-11T09:40:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: []
    });

    return { harness, planPath, store };
  }

  function buildWatchdog(planPath: string, log: ReturnType<typeof silentLog>, onDispatcherStalled?: ReturnType<typeof vi.fn>) {
    const { hubClient } = createHubClient(() => ({
      trace_id: "trace",
      thread_id: "agent-dispatcher-uld",
      source: "codex",
      status: "success",
      content: "",
      attachments: [],
      timestamp: FIXED_NOW
    }));
    return new ReconciliationWatchdog({
      resolveActiveDispatchPlanPaths: async () => [planPath],
      hubClient,
      log,
      intervalMs: 60_000,
      ...(onDispatcherStalled ? { onDispatcherStalled } : {})
    });
  }

  it("never selects a row whose capsule is still unmaterialized", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));

    const { planPath } = await setupHeldHarness();
    const onDispatcherStalled = vi.fn(async () => {});
    const log = silentLog();

    await buildWatchdog(planPath, log, onDispatcherStalled).sweep();

    expect(onDispatcherStalled).not.toHaveBeenCalledWith(expect.objectContaining({
      continueWorkerId: "I-02"
    }));
  });

  it("selects the same row once its capsule carries no placeholder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));

    const { planPath } = await setupHeldHarness({ materialized: true });
    const onDispatcherStalled = vi.fn(async () => {});
    const log = silentLog();

    await buildWatchdog(planPath, log, onDispatcherStalled).sweep();

    expect(onDispatcherStalled).toHaveBeenCalledWith(expect.objectContaining({
      continueWorkerId: "I-02"
    }));
  });

  it("emits dispatcher_awaiting_materialization as a throttled heartbeat naming the reason", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));

    const { planPath } = await setupHeldHarness();
    const log = silentLog();
    const watchdog = buildWatchdog(planPath, log);

    await watchdog.sweep();
    await watchdog.sweep();

    const parkedCalls = () => log.info.mock.calls.filter(
      ([message]) => message === "dispatcher_awaiting_materialization"
    );
    expect(parkedCalls()).toHaveLength(1);
    expect(parkedCalls()[0]?.[1]).toEqual(expect.objectContaining({
      event: "dispatcher_awaiting_materialization",
      dispatchPlanPath: planPath,
      workerId: "I-02",
      // The watchdog's gate is READ-ONLY: it never attempts the derivation, so
      // it must not claim PM is owed anything. `awaiting_fill` is the honest
      // answer — the continue tick performs the fill, and only THAT path can
      // report `awaiting_pm`, because only it knows the derivation was tried
      // and failed.
      reason: "awaiting_fill"
    }));

    // Inside the throttle window: still one line.
    vi.setSystemTime(new Date("2026-08-11T10:10:00.000Z"));
    await watchdog.sweep();
    expect(parkedCalls()).toHaveLength(1);

    // Past the window: the park is still live, so it must be re-announced.
    vi.setSystemTime(new Date("2026-08-11T10:20:00.000Z"));
    await watchdog.sweep();
    expect(parkedCalls()).toHaveLength(2);
  });

  it("stops announcing once the capsule is materialized", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));

    const { harness, planPath } = await setupHeldHarness();
    const log = silentLog();
    const watchdog = buildWatchdog(planPath, log);

    await watchdog.sweep();
    expect(log.info.mock.calls.filter(([m]) => m === "dispatcher_awaiting_materialization")).toHaveLength(1);

    await fsp.writeFile(
      path.join(harness.directory, "context", "I-02-context.md"),
      "# I-02 Context Capsule\n\n## Upstream Inputs\n\nI-01@7712e542d71d0f48e1cf81f0922547d72b46ef00\n",
      "utf8"
    );

    vi.setSystemTime(new Date("2026-08-11T11:00:00.000Z"));
    await watchdog.sweep();

    expect(log.info.mock.calls.filter(([m]) => m === "dispatcher_awaiting_materialization")).toHaveLength(1);
  });
});

async function createHarness(prefix = "watchdog-test-") {
  const directory = await fsp.mkdtemp(path.join(tmpdir(), prefix));
  tempDirectories.add(directory);

  return {
    directory,
    async writeOutput(relativePath: string): Promise<string> {
      const fullPath = path.join(directory, relativePath);
      await fsp.mkdir(path.dirname(fullPath), { recursive: true });
      await fsp.writeFile(fullPath, "test output content\n", "utf8");
      return fullPath;
    }
  };
}

function createHubClient(
  handler: (message: HubMessage) => HubResult | Promise<HubResult>
): { hubClient: A2AClient } {
  const hubClient = {
    serviceId: "service:meridian-roles",
    sendRequest: async (message: HubMessage) => handler(message)
  } as unknown as A2AClient;

  return { hubClient };
}

function buildStatusResult(threadId: string, status: string): HubResult {
  return {
    trace_id: "test-trace",
    thread_id: threadId,
    source: "codex",
    status: "success",
    content: JSON.stringify({ status }),
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function silentLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn()
  };
}
