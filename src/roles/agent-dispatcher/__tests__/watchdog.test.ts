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
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({ size: 100 } as ReturnType<typeof reconciliationFs.statSync>);

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
    vi.spyOn(reconciliationFs, "statSync").mockReturnValue({ size: 100 } as ReturnType<typeof reconciliationFs.statSync>);

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
        kill_policy: "always"
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

  it("restores plan and lifecycle snapshots when retrying a failed worker but launch bootstrap fails", async () => {
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

    const originalPlan = await fsp.readFile(dispatchPlanPath, "utf8");
    const originalSidecar = await fsp.readFile(sidecarPath, "utf8");
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
        kill_policy: "always"
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
      await expect(fsp.readFile(dispatchPlanPath, "utf8")).resolves.toBe(originalPlan);
      await expect(fsp.readFile(sidecarPath, "utf8")).resolves.toBe(originalSidecar);
    } finally {
      killSpy.mockRestore();
    }
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
