import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { A2AClient } from "../../../a2a/client";
import type { HubMessage, HubResult } from "../../../types";
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
          command_preamble: null
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
          command_preamble: null
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
          command_preamble: null
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
        pendingWorkerCount: 1
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
          command_preamble: null
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
          command_preamble: null
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
          command_preamble: null
        },
        "W-02": {
          thread_id: "placeholder",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null
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
          command_preamble: null
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
