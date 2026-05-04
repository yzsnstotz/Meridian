import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { A2AClient } from "../../../a2a/client";
import type { HubMessage, HubResult } from "../../../types";
import killTool from "../../../tool-gateway/tools/kill";
import { continueDispatchWorker } from "../continue-worker";
import { buildEmptyDispatchThreadStateV2, LifecycleStore } from "../lifecycle-store";
import { reconciliationFs } from "../reconciler";
import { ReconciliationWatchdog } from "../watchdog";

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
      await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| ⬜ | Ω+1 | R-04A | Recovery | CODEX | DELTA-CHECK | stale watchdog recovery |"
      );
      expect(lifecycleStore.load().workers["R-04A"]).toMatchObject({
        status: "pending",
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

  it("does not resurrect a stale running worker when relaunch bootstrap fails", async () => {
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

      expect(result).toEqual({
        ok: false,
        workerId: "PRE-FLIGHT",
        error: "run launch failed: ENOENT",
        localToolBootstrapFailure: true
      });
      await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toContain(
        "| ⬜ | 0 | PRE-FLIGHT | Environment health check | OPUS | — | Report-only worker |"
      );
      expect(lifecycleStore.load().workers["PRE-FLIGHT"]).toMatchObject({
        thread_id: "codex_03",
        status: "pending",
        retry_count: 3
      });
      expect(lifecycleStore.load().workers["PRE-FLIGHT"]?.hub_result).toMatchObject({
        trace_id: "9639d2dd-431f-430a-81de-84c3c4b6d980",
        thread_id: "codex_03",
        status: "partial"
      });
      expect(killSpy).toHaveBeenCalledWith({
        thread_id: "codex_03"
      });
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
