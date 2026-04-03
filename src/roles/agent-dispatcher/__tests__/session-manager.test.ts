import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StateStore } from "../../../state-store";
import type { DispatchThreadStateV2 } from "../../../types";
import { buildEmptyDispatchThreadStateV2, LifecycleStore } from "../lifecycle-store";
import {
  SessionManager,
  ThreadTracker,
  type SessionManagerOptions
} from "../session-manager";

const tempDirectories = new Set<string>();
const FIXED_NOW = "2026-03-28T12:00:00.000Z";
const ABANDONED_NOW = "2026-03-28T12:05:00.000Z";

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    })
  );

  tempDirectories.clear();
});

describe("ThreadTracker", () => {
  it("exposes only running lifecycle entries through the legacy tracker view", async () => {
    const harness = await createHarness();
    const lifecycleStore = new LifecycleStore(harness.sidecarPath, {
      now: () => FIXED_NOW
    });

    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: FIXED_NOW,
        status: "running"
      },
      workers: {
        "R-01": {
          thread_id: "worker-thread-111",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "running",
          expected_outputs: [],
          hub_result: null
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: "22222222-2222-4222-8222-222222222222",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "completed",
          expected_outputs: [],
          hub_result: {
            trace_id: "22222222-2222-4222-8222-222222222222",
            thread_id: "worker-thread-222",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "done",
            attachments: [],
            timestamp: FIXED_NOW
          }
        }
      },
      last_reconciled_at: null
    });

    const tracker = new ThreadTracker(harness.dispatchPlanPath, {
      lifecycleStore,
      now: () => FIXED_NOW
    });

    await expect(tracker.load()).resolves.toEqual({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {
        "R-01": {
          thread_id: "worker-thread-111",
          started_at: FIXED_NOW
        }
      }
    });
  });
});

describe("SessionManager", () => {
  it("initSession calls lifecycleStore.recordDispatcher", async () => {
    const harness = await createHarness();
    const lifecycle = createLifecycleStoreMock();
    const manager = new SessionManager("agent-dispatcher-role-1", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store
    });

    await manager.initSession("dispatcher-thread-123", harness.dispatchPlanPath);

    expect(manager.getDispatcherThreadId()).toBe("dispatcher-thread-123");
    expect(lifecycle.store.recordDispatcher).toHaveBeenCalledWith("dispatcher-thread-123");
    expect(lifecycle.getState().dispatcher).toEqual({
      thread_id: "dispatcher-thread-123",
      started_at: FIXED_NOW,
      status: "running"
    });
  });

  it("persists pause and resume state through the state store", async () => {
    const harness = await createHarness();
    const lifecycle = createLifecycleStoreMock();
    const manager = new SessionManager("agent-dispatcher-role-2", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store
    });

    await manager.initSession("dispatcher-thread-123", harness.dispatchPlanPath);
    manager.setPaused(true);
    await waitForRoleStatus(harness.stateStore, "agent-dispatcher-role-2", "paused");

    const restartedManager = new SessionManager("agent-dispatcher-role-2", {
      stateStore: harness.stateStore,
      lifecycleStore: createLifecycleStoreMock().store
    });
    await restartedManager.initSession("dispatcher-thread-456", harness.dispatchPlanPath);

    expect(restartedManager.isPaused()).toBe(true);

    restartedManager.setPaused(false);
    await waitForRoleStatus(harness.stateStore, "agent-dispatcher-role-2", "active");
  });

  it("kills running lifecycle workers during restart recovery and marks them abandoned", async () => {
    const harness = await createHarness();
    const lifecycle = createLifecycleStoreMock({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: FIXED_NOW,
        status: "running"
      },
      workers: {
        "R-01": {
          thread_id: "worker-thread-111",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "running",
          expected_outputs: ["report.md"],
          hub_result: null
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: "22222222-2222-4222-8222-222222222222",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "completed",
          expected_outputs: ["done.txt"],
          hub_result: {
            trace_id: "22222222-2222-4222-8222-222222222222",
            thread_id: "worker-thread-222",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "done",
            attachments: [],
            timestamp: FIXED_NOW
          }
        },
        "N-03": {
          thread_id: "worker-thread-333",
          trace_id: "33333333-3333-4333-8333-333333333333",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "running",
          expected_outputs: ["log.txt"],
          hub_result: null
        }
      },
      last_reconciled_at: null
    });
    const killCalls = vi.fn().mockResolvedValue({ stdout: "{\"ok\":true}\n", stderr: "" });
    const manager = new SessionManager("agent-dispatcher-role-3", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store,
      execFile: killCalls
    });

    const result = await manager.onRestart();

    expect(result).toEqual({
      staleWorkersKilled: ["R-01", "N-03"],
      dispatcherRestarted: true
    });
    expect(lifecycle.store.getWorkersInState).toHaveBeenCalledWith("running");
    expect(lifecycle.store.markAbandoned).toHaveBeenNthCalledWith(
      1,
      "R-01",
      "stale running worker found during restart"
    );
    expect(lifecycle.store.markAbandoned).toHaveBeenNthCalledWith(
      2,
      "N-03",
      "stale running worker found during restart"
    );
    expect(killCalls).toHaveBeenCalledTimes(3);
    expect(killCalls).toHaveBeenNthCalledWith(1, "npx", [
      "tsx",
      "src/bin/meridian-tool.ts",
      "kill",
      "--thread-id",
      "dispatcher-thread-123"
    ]);
    expect(killCalls).toHaveBeenNthCalledWith(2, "npx", [
      "tsx",
      "src/bin/meridian-tool.ts",
      "kill",
      "--thread-id",
      "worker-thread-111"
    ]);
    expect(killCalls).toHaveBeenNthCalledWith(3, "npx", [
      "tsx",
      "src/bin/meridian-tool.ts",
      "kill",
      "--thread-id",
      "worker-thread-333"
    ]);
    expect(lifecycle.getState().dispatcher).toEqual({
      thread_id: null,
      started_at: null,
      status: "pending"
    });
    expect(lifecycle.getState().workers["R-01"]?.status).toBe("abandoned");
    expect(lifecycle.getState().workers["N-02"]?.status).toBe("completed");
    expect(lifecycle.getState().workers["N-03"]?.status).toBe("abandoned");
  });

  it("skips kill attempts when lifecycle store has no running dispatcher or workers", async () => {
    const harness = await createHarness();
    const lifecycle = createLifecycleStoreMock();
    const killCalls = vi.fn().mockResolvedValue({ stdout: "{\"ok\":true}\n", stderr: "" });
    const manager = new SessionManager("agent-dispatcher-role-4", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store,
      execFile: killCalls
    });

    const result = await manager.onRestart();

    expect(result).toEqual({
      staleWorkersKilled: [],
      dispatcherRestarted: true
    });
    expect(lifecycle.store.getWorkersInState).toHaveBeenCalledWith("running");
    expect(lifecycle.store.markAbandoned).not.toHaveBeenCalled();
    expect(killCalls).not.toHaveBeenCalled();
    expect(lifecycle.store.save).not.toHaveBeenCalled();
  });
});

async function createHarness(): Promise<{
  directory: string;
  dispatchPlanPath: string;
  sidecarPath: string;
  stateStore: StateStore;
}> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-session-manager-"));
  tempDirectories.add(directory);

  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  const sidecarPath = path.join(directory, "dispatch_threads.json");
  await fs.writeFile(dispatchPlanPath, buildDispatchPlan(), "utf8");

  return {
    directory,
    dispatchPlanPath,
    sidecarPath,
    stateStore: new StateStore(path.join(directory, "state.json"))
  };
}

function buildDispatchPlan(): string {
  return [
    "# Dispatch Plan",
    "",
    "## Master Dispatch Table",
    "",
    "| Status | Batch | Worker | Task |",
    "|--------|-------|--------|------|",
    "| ✅ | 0 | PRE-FLIGHT | Ready |",
    ""
  ].join("\n");
}

function createLifecycleStoreMock(initialState?: DispatchThreadStateV2): {
  getState: () => DispatchThreadStateV2;
  store: NonNullable<SessionManagerOptions["lifecycleStore"]>;
} {
  let state = structuredClone(initialState ?? buildEmptyDispatchThreadStateV2());

  const store: NonNullable<SessionManagerOptions["lifecycleStore"]> = {
    load: vi.fn(() => structuredClone(state)),
    save: vi.fn((nextState) => {
      state = structuredClone(nextState);
    }),
    recordDispatcher: vi.fn((threadId: string) => {
      state.dispatcher = {
        thread_id: threadId,
        started_at: FIXED_NOW,
        status: "running"
      };
    }),
    getWorkersInState: vi.fn((status) => {
      return Object.entries(state.workers)
        .filter(([, worker]) => worker.status === status)
        .map(([workerId, worker]) => ({
          worker_id: workerId,
          ...structuredClone(worker)
        }));
    }),
    markAbandoned: vi.fn((workerId: string) => {
      const worker = state.workers[workerId];
      if (!worker) {
        throw new Error(`Worker not found in lifecycle state: ${workerId}`);
      }

      state.workers[workerId] = {
        ...worker,
        status: "abandoned",
        last_seen_at: ABANDONED_NOW
      };
    })
  };

  return {
    store,
    getState: () => structuredClone(state)
  };
}

async function waitForRoleStatus(stateStore: StateStore, threadId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const state = await stateStore.load();
    const role = state?.roles.find((entry) => entry.threadId === threadId);
    if (role?.status === status) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(`Timed out waiting for role ${threadId} to reach status ${status}`);
}
