import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StateStore } from "../../../state-store";
import {
  SessionManager,
  ThreadTracker,
  type DispatchThreadState
} from "../session-manager";

const tempDirectories = new Set<string>();

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
  it("records dispatcher and worker thread ids in the sidecar file", async () => {
    const harness = await createHarness();
    const tracker = new ThreadTracker(harness.dispatchPlanPath, {
      now: () => "2026-03-28T12:00:00.000Z"
    });

    await tracker.recordDispatcher("dispatcher-thread-123");
    await tracker.recordWorker("N-03", "worker-thread-456");

    await expect(tracker.getAll()).resolves.toEqual({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {
        "N-03": {
          thread_id: "worker-thread-456",
          started_at: "2026-03-28T12:00:00.000Z"
        }
      }
    });

    const saved = JSON.parse(await fs.readFile(harness.sidecarPath, "utf8")) as DispatchThreadState;
    expect(saved.dispatcher_thread_id).toBe("dispatcher-thread-123");
    expect(saved.workers["N-03"]?.thread_id).toBe("worker-thread-456");
  });

  it("removes workers without disturbing dispatcher metadata", async () => {
    const harness = await createHarness();
    const tracker = new ThreadTracker(harness.dispatchPlanPath, {
      now: () => "2026-03-28T12:00:00.000Z"
    });

    await tracker.recordDispatcher("dispatcher-thread-123");
    await tracker.recordWorker("R-01", "worker-thread-111");
    await tracker.removeWorker("R-01");

    await expect(tracker.load()).resolves.toEqual({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {}
    });
  });
});

describe("SessionManager", () => {
  it("initSession writes dispatcher_thread_id to the sidecar", async () => {
    const harness = await createHarness();
    const manager = new SessionManager("agent-dispatcher-role-1", {
      stateStore: harness.stateStore,
      dispatchPlanPath: harness.dispatchPlanPath
    });

    await manager.initSession("dispatcher-thread-123", harness.dispatchPlanPath);

    expect(manager.getDispatcherThreadId()).toBe("dispatcher-thread-123");
    await expect(readSidecar(harness.sidecarPath)).resolves.toEqual({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {}
    });
  });

  it("persists pause and resume state through the state store", async () => {
    const harness = await createHarness();
    const manager = new SessionManager("agent-dispatcher-role-2", {
      stateStore: harness.stateStore,
      dispatchPlanPath: harness.dispatchPlanPath
    });

    await manager.initSession("dispatcher-thread-123", harness.dispatchPlanPath);
    manager.setPaused(true);
    await waitForRoleStatus(harness.stateStore, "agent-dispatcher-role-2", "paused");

    const restartedManager = new SessionManager("agent-dispatcher-role-2", {
      stateStore: harness.stateStore,
      dispatchPlanPath: harness.dispatchPlanPath
    });
    await restartedManager.initSession("dispatcher-thread-456", harness.dispatchPlanPath);

    expect(restartedManager.isPaused()).toBe(true);

    restartedManager.setPaused(false);
    await waitForRoleStatus(harness.stateStore, "agent-dispatcher-role-2", "active");
  });

  it("kills stale dispatcher and running worker threads during restart recovery", async () => {
    const harness = await createHarness({
      planRows: [
        ["🔄", "1", "R-01", "Foundation"],
        ["✅", "2", "N-02", "CLI"],
        ["🔄", "2", "N-03", "Spawn tool"]
      ]
    });
    const killCalls = vi.fn().mockResolvedValue({ stdout: "{\"ok\":true}\n", stderr: "" });
    await writeSidecar(harness.sidecarPath, {
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {
        "R-01": {
          thread_id: "worker-thread-111",
          started_at: "2026-03-28T12:00:00.000Z"
        },
        "N-02": {
          thread_id: "worker-thread-222",
          started_at: "2026-03-28T12:01:00.000Z"
        },
        "N-03": {
          thread_id: "worker-thread-333",
          started_at: "2026-03-28T12:02:00.000Z"
        }
      }
    });

    const manager = new SessionManager("agent-dispatcher-role-3", {
      stateStore: harness.stateStore,
      dispatchPlanPath: harness.dispatchPlanPath,
      execFile: killCalls
    });

    const result = await manager.onRestart();

    expect(result).toEqual({
      staleWorkersKilled: ["R-01", "N-03"],
      dispatcherRestarted: true
    });
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
    await expect(readSidecar(harness.sidecarPath)).resolves.toEqual({
      dispatcher_thread_id: null,
      workers: {
        "N-02": {
          thread_id: "worker-thread-222",
          started_at: "2026-03-28T12:01:00.000Z"
        }
      }
    });
  });

  it("skips kill attempts when restart recovery has no sidecar file", async () => {
    const harness = await createHarness({
      planRows: [["🔄", "1", "R-01", "Foundation"]]
    });
    const killCalls = vi.fn().mockResolvedValue({ stdout: "{\"ok\":true}\n", stderr: "" });
    const manager = new SessionManager("agent-dispatcher-role-4", {
      stateStore: harness.stateStore,
      dispatchPlanPath: harness.dispatchPlanPath,
      execFile: killCalls
    });

    const result = await manager.onRestart();

    expect(result).toEqual({
      staleWorkersKilled: [],
      dispatcherRestarted: true
    });
    expect(killCalls).not.toHaveBeenCalled();
    await expect(fs.access(harness.sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createHarness(options: {
  planRows?: string[][];
} = {}): Promise<{
  directory: string;
  dispatchPlanPath: string;
  sidecarPath: string;
  stateStore: StateStore;
}> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-session-manager-"));
  tempDirectories.add(directory);

  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  const sidecarPath = path.join(directory, "dispatch_threads.json");
  await fs.writeFile(dispatchPlanPath, buildDispatchPlan(options.planRows), "utf8");

  return {
    directory,
    dispatchPlanPath,
    sidecarPath,
    stateStore: new StateStore(path.join(directory, "state.json"))
  };
}

function buildDispatchPlan(planRows: string[][] = []): string {
  const rows = planRows.length > 0
    ? planRows
    : [["✅", "0", "PRE-FLIGHT", "Ready"]];

  return [
    "# Dispatch Plan",
    "",
    "## Master Dispatch Table",
    "",
    "| Status | Batch | Worker | Task |",
    "|--------|-------|--------|------|",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    ""
  ].join("\n");
}

async function readSidecar(sidecarPath: string): Promise<DispatchThreadState> {
  return JSON.parse(await fs.readFile(sidecarPath, "utf8")) as DispatchThreadState;
}

async function writeSidecar(sidecarPath: string, state: DispatchThreadState): Promise<void> {
  await fs.writeFile(sidecarPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
