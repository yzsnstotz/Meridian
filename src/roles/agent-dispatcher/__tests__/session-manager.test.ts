import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StateStore } from "../../../state-store";
import type { DispatchThreadStateV2 } from "../../../types";
import { buildEmptyDispatchThreadStateV2, LifecycleStore } from "../lifecycle-store";
import { buildMeridianToolArgs, MERIDIAN_TOOL_EXECUTABLE } from "../tool-entrypoint";
import {
  DispatchThreadView,
  SessionManager,
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

describe("DispatchThreadView", () => {
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
          hub_result: null,
          command_preamble: null,
          retry_count: 0
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
          },
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });

    const tracker = new DispatchThreadView(harness.dispatchPlanPath, {
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

  it("hides dispatcher thread ids after lifecycle demotes the dispatcher from running", async () => {
    const harness = await createHarness();
    const lifecycleStore = new LifecycleStore(harness.sidecarPath, {
      now: () => FIXED_NOW
    });

    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: FIXED_NOW,
        status: "abandoned"
      },
      workers: {},
      last_reconciled_at: null
    });

    const tracker = new DispatchThreadView(harness.dispatchPlanPath, {
      lifecycleStore,
      now: () => FIXED_NOW
    });

    await expect(tracker.load()).resolves.toEqual({
      dispatcher_thread_id: null,
      workers: {}
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
    expect(lifecycle.getState().workers.DISPATCHER).toEqual({
      thread_id: "dispatcher-thread-123",
      trace_id: null,
      started_at: FIXED_NOW,
      last_seen_at: FIXED_NOW,
      status: "running",
      expected_outputs: [],
      hub_result: null,
      command_preamble: null,
      retry_count: 0
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

  describe("setPaused — real pause kills attached threads", () => {
    it("kills the dispatcher controller + every running worker on transition to paused", async () => {
      const harness = await createHarness();
      const lifecycle = createLifecycleStoreMock({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: FIXED_NOW,
          status: "running"
        },
        workers: {
          "BATCH-3-GATE": {
            thread_id: "codex_42",
            trace_id: "11111111-1111-4111-8111-111111111111",
            started_at: FIXED_NOW,
            last_seen_at: FIXED_NOW,
            status: "running",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          },
          "N-07": {
            thread_id: "codex_55",
            trace_id: "22222222-2222-4222-8222-222222222222",
            started_at: FIXED_NOW,
            last_seen_at: FIXED_NOW,
            status: "running",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          },
          "DONE-WORKER": {
            thread_id: "codex_99",
            trace_id: "33333333-3333-4333-8333-333333333333",
            started_at: FIXED_NOW,
            last_seen_at: FIXED_NOW,
            status: "completed",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        },
        last_reconciled_at: null
      });

      const killAttachedThread = vi.fn(async (threadId: string) => ({
        threadId,
        pidsKilled: [100],
        pidsResistedTerm: [],
        socketsRemoved: [`/tmp/agentapi-${threadId}.sock`],
        errors: []
      }));

      const manager = new SessionManager("agent-dispatcher-role-kill-1", {
        stateStore: harness.stateStore,
        lifecycleStore: lifecycle.store,
        killAttachedThread
      });
      await manager.initSession("dispatcher-thread-123", harness.dispatchPlanPath);

      manager.setPaused(true);
      await manager.awaitPendingPauseWork();

      const killedIds = killAttachedThread.mock.calls.map((call) => call[0]).sort();
      // Dispatcher controller + the two running workers; the completed worker is skipped.
      expect(killedIds).toEqual(["codex_42", "codex_55", "dispatcher-thread-123"]);
      await waitForRoleStatus(harness.stateStore, "agent-dispatcher-role-kill-1", "paused");
    });

    it("does NOT invoke killer on transition to resumed", async () => {
      const harness = await createHarness();
      const lifecycle = createLifecycleStoreMock({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-resume",
          started_at: FIXED_NOW,
          status: "running"
        },
        workers: {},
        last_reconciled_at: null
      });

      const killAttachedThread = vi.fn(async (threadId: string) => ({
        threadId,
        pidsKilled: [],
        pidsResistedTerm: [],
        socketsRemoved: [],
        errors: []
      }));

      const manager = new SessionManager("agent-dispatcher-role-kill-2", {
        stateStore: harness.stateStore,
        lifecycleStore: lifecycle.store,
        killAttachedThread
      });
      await manager.initSession("dispatcher-thread-resume", harness.dispatchPlanPath);

      manager.setPaused(true);
      await manager.awaitPendingPauseWork();
      killAttachedThread.mockClear();

      manager.setPaused(false);
      await manager.awaitPendingPauseWork();

      expect(killAttachedThread).not.toHaveBeenCalled();
    });

    it("does not re-kill when setPaused(true) is called while already paused", async () => {
      const harness = await createHarness();
      const lifecycle = createLifecycleStoreMock({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-idem",
          started_at: FIXED_NOW,
          status: "running"
        },
        workers: {},
        last_reconciled_at: null
      });

      const killAttachedThread = vi.fn(async (threadId: string) => ({
        threadId,
        pidsKilled: [],
        pidsResistedTerm: [],
        socketsRemoved: [],
        errors: []
      }));

      const manager = new SessionManager("agent-dispatcher-role-kill-3", {
        stateStore: harness.stateStore,
        lifecycleStore: lifecycle.store,
        killAttachedThread
      });
      await manager.initSession("dispatcher-thread-idem", harness.dispatchPlanPath);

      manager.setPaused(true);
      await manager.awaitPendingPauseWork();
      expect(killAttachedThread).toHaveBeenCalledTimes(1);

      killAttachedThread.mockClear();
      manager.setPaused(true);
      await manager.awaitPendingPauseWork();
      expect(killAttachedThread).not.toHaveBeenCalled();
    });

    it("skipPersist=true still runs the kill phase (the role owns the outer state write)", async () => {
      // This is the operator-initiated path: GUI/CLI pause -> runner.pauseRole
      // -> role.onStatusChange -> sessionManager.setPaused(true, { skipPersist: true }).
      // skipPersist suppresses the inner state-store write only — the kill
      // must still happen, otherwise pause stays "fake".
      const harness = await createHarness();
      const lifecycle = createLifecycleStoreMock();
      const killAttachedThread = vi.fn(async (threadId: string) => ({
        threadId,
        pidsKilled: [],
        pidsResistedTerm: [],
        socketsRemoved: [],
        errors: []
      }));

      const manager = new SessionManager("agent-dispatcher-role-kill-4", {
        stateStore: harness.stateStore,
        lifecycleStore: lifecycle.store,
        killAttachedThread
      });
      await manager.initSession("dispatcher-thread-skip", harness.dispatchPlanPath);

      manager.setPaused(true, { skipPersist: true });
      await manager.awaitPendingPauseWork();

      expect(killAttachedThread).toHaveBeenCalledWith("dispatcher-thread-skip");
      expect(manager.isPaused()).toBe(true);
    });

    it("skipKill=true is the no-side-effect hydration path: flag flips, no kill, no persist", async () => {
      const harness = await createHarness();
      const lifecycle = createLifecycleStoreMock();
      const killAttachedThread = vi.fn();

      const manager = new SessionManager("agent-dispatcher-role-kill-4b", {
        stateStore: harness.stateStore,
        lifecycleStore: lifecycle.store,
        killAttachedThread
      });
      await manager.initSession("dispatcher-thread-skipkill", harness.dispatchPlanPath);

      manager.setPaused(true, { skipPersist: true, skipKill: true });
      await manager.awaitPendingPauseWork();

      expect(killAttachedThread).not.toHaveBeenCalled();
      expect(manager.isPaused()).toBe(true);
    });

    it("emits a structured summary via onPauseKillSummary", async () => {
      const harness = await createHarness();
      const lifecycle = createLifecycleStoreMock({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-sum",
          started_at: FIXED_NOW,
          status: "running"
        },
        workers: {
          "W-01": {
            thread_id: "codex_77",
            trace_id: "44444444-4444-4444-8444-444444444444",
            started_at: FIXED_NOW,
            last_seen_at: FIXED_NOW,
            status: "running",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        },
        last_reconciled_at: null
      });

      const summaries: unknown[] = [];
      const manager = new SessionManager("agent-dispatcher-role-kill-5", {
        stateStore: harness.stateStore,
        lifecycleStore: lifecycle.store,
        killAttachedThread: async (threadId) => ({
          threadId,
          pidsKilled: [1],
          pidsResistedTerm: [],
          socketsRemoved: [`/tmp/agentapi-${threadId}.sock`],
          errors: []
        }),
        onPauseKillSummary: (s) => {
          summaries.push(s);
        }
      });
      await manager.initSession("dispatcher-thread-sum", harness.dispatchPlanPath);

      manager.setPaused(true);
      await manager.awaitPendingPauseWork();

      expect(summaries).toHaveLength(1);
      const summary = summaries[0] as {
        dispatcherId: string;
        killedThreadIds: string[];
        perThreadResults: Array<{ threadId: string; pidsKilled: number[] }>;
      };
      expect(summary.dispatcherId).toBe("dispatcher-thread-sum");
      expect(summary.killedThreadIds.sort()).toEqual(["codex_77", "dispatcher-thread-sum"]);
      expect(summary.perThreadResults).toHaveLength(2);
    });

    it("isolates per-thread kill errors without breaking the chain", async () => {
      const harness = await createHarness();
      const lifecycle = createLifecycleStoreMock({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-err",
          started_at: FIXED_NOW,
          status: "running"
        },
        workers: {
          "W-01": {
            thread_id: "codex_aa",
            trace_id: "55555555-5555-4555-8555-555555555555",
            started_at: FIXED_NOW,
            last_seen_at: FIXED_NOW,
            status: "running",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        },
        last_reconciled_at: null
      });

      const killAttachedThread = vi.fn(async (threadId: string) => {
        if (threadId === "codex_aa") {
          throw new Error("ps probe segfaulted");
        }
        return {
          threadId,
          pidsKilled: [],
          pidsResistedTerm: [],
          socketsRemoved: [],
          errors: []
        };
      });

      const manager = new SessionManager("agent-dispatcher-role-kill-6", {
        stateStore: harness.stateStore,
        lifecycleStore: lifecycle.store,
        killAttachedThread
      });
      await manager.initSession("dispatcher-thread-err", harness.dispatchPlanPath);

      manager.setPaused(true);
      // Should not throw, status flag should still get written.
      await manager.awaitPendingPauseWork();
      await waitForRoleStatus(harness.stateStore, "agent-dispatcher-role-kill-6", "paused");
      expect(killAttachedThread).toHaveBeenCalledTimes(2);
    });
  });

  it("kills running lifecycle workers during restart and reconciles their status from evidence", async () => {
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
          hub_result: null,
          command_preamble: null,
          retry_count: 0
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
          },
          command_preamble: null,
          retry_count: 0
        },
        "N-03": {
          thread_id: "worker-thread-333",
          trace_id: "33333333-3333-4333-8333-333333333333",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "running",
          expected_outputs: ["log.txt"],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
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
    // onRestart must NOT mark workers abandoned — reconciliation determines final status
    expect(lifecycle.store.markAbandoned).not.toHaveBeenCalled();
    expect(killCalls).toHaveBeenCalledTimes(3);
    expect(killCalls).toHaveBeenNthCalledWith(1, MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "kill",
      "--thread-id",
      "dispatcher-thread-123"
    ]));
    expect(killCalls).toHaveBeenNthCalledWith(2, MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "kill",
      "--thread-id",
      "worker-thread-111"
    ]));
    expect(killCalls).toHaveBeenNthCalledWith(3, MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "kill",
      "--thread-id",
      "worker-thread-333"
    ]));
    expect(lifecycle.getState().dispatcher).toEqual({
      thread_id: null,
      started_at: null,
      status: "pending"
    });
    // Killed workers are reconciled based on hub_result and expected_outputs.
    // R-01: no hub_result → abandoned; N-02: already completed (not killed); N-03: no hub_result → abandoned
    expect(lifecycle.getState().workers["R-01"]?.status).toBe("abandoned");
    expect(lifecycle.getState().workers["N-02"]?.status).toBe("completed");
    expect(lifecycle.getState().workers["N-03"]?.status).toBe("abandoned");
  });

  it("marks a killed running worker blocked when its fresh output report is blocked", async () => {
    const harness = await createHarness();
    const outputPath = path.join(harness.directory, "reports", "V-01-A.md");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, [
      "# V-01-A Report",
      "",
      "**Result**: BLOCKED",
      "",
      "Verification did not pass."
    ].join("\n"), "utf8");

    const lifecycle = createLifecycleStoreMock({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: FIXED_NOW,
        status: "running"
      },
      workers: {
        "V-01-A": {
          thread_id: "worker-thread-v01a",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "running",
          expected_outputs: [outputPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    const killCalls = vi.fn().mockResolvedValue({ stdout: "{\"ok\":true}\n", stderr: "" });
    const manager = new SessionManager("agent-dispatcher-role-v01a", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store,
      execFile: killCalls
    });

    const result = await manager.onRestart();

    expect(result).toEqual({
      staleWorkersKilled: ["V-01-A"],
      dispatcherRestarted: true
    });
    expect(lifecycle.getState().workers["V-01-A"]?.status).toBe("blocked");
  });

  it("respects plan ✅ status during restart reconciliation even when hub_result is missing", async () => {
    const harness = await createHarness({
      planContent: [
        "# Dispatch Plan",
        "",
        "## Master Dispatch Table",
        "",
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ✅ | 0 | PRE-FLIGHT | Ready |",
        "| ✅ | 1 | R-01 | OAuth fix |",
        "| ✅ | 2 | R-02 | UI consolidation |",
        ""
      ].join("\n")
    });
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
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "R-02": {
          thread_id: "worker-thread-222",
          trace_id: "22222222-2222-4222-8222-222222222222",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 1
        }
      },
      last_reconciled_at: null
    });
    const killCalls = vi.fn().mockResolvedValue({ stdout: "{\"ok\":true}\n", stderr: "" });
    const manager = new SessionManager("agent-dispatcher-role-plan", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store,
      execFile: killCalls
    });

    await manager.initSession("dispatcher-thread-123", harness.dispatchPlanPath);
    const result = await manager.onRestart();

    expect(result).toEqual({
      staleWorkersKilled: ["R-01", "R-02"],
      dispatcherRestarted: true
    });
    // Both workers have no hub_result, but plan shows ✅ → completed (not abandoned)
    expect(lifecycle.getState().workers["R-01"]?.status).toBe("completed");
    expect(lifecycle.getState().workers["R-02"]?.status).toBe("completed");
    expect(lifecycle.getState().workers).not.toHaveProperty("DISPATCHER");
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

  it("prepareFreshDispatcherLaunch kills both disk and in-memory dispatcher ids before clearing state", async () => {
    const harness = await createHarness();
    const lifecycle = createLifecycleStoreMock();
    const killCalls = vi.fn().mockResolvedValue({ stdout: "{\"ok\":true}\n", stderr: "" });
    const manager = new SessionManager("agent-dispatcher-role-5", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store,
      execFile: killCalls
    });

    await manager.initSession("dispatcher-thread-memory", harness.dispatchPlanPath);
    lifecycle.store.save({
      ...lifecycle.getState(),
      dispatcher: {
        thread_id: "dispatcher-thread-disk",
        started_at: FIXED_NOW,
        status: "running"
      }
    });

    await manager.prepareFreshDispatcherLaunch();

    expect(killCalls).toHaveBeenCalledTimes(2);
    expect(killCalls).toHaveBeenNthCalledWith(1, MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "kill",
      "--thread-id",
      "dispatcher-thread-disk"
    ]));
    expect(killCalls).toHaveBeenNthCalledWith(2, MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "kill",
      "--thread-id",
      "dispatcher-thread-memory"
    ]));
    expect(lifecycle.getState().dispatcher).toEqual({
      thread_id: null,
      started_at: null,
      status: "pending"
    });
    expect(manager.getDispatcherThreadId()).toBeNull();
  });

  it("prepareFreshDispatcherLaunch clears stale dispatcher pseudo-worker state", async () => {
    const harness = await createHarness();
    const lifecycle = createLifecycleStoreMock({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-stale",
        started_at: FIXED_NOW,
        status: "abandoned"
      },
      workers: {
        DISPATCHER: {
          thread_id: "dispatcher-thread-stale",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "N-01": {
          thread_id: "worker-thread-n01",
          trace_id: "22222222-2222-4222-8222-222222222222",
          started_at: FIXED_NOW,
          last_seen_at: FIXED_NOW,
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    const manager = new SessionManager("agent-dispatcher-role-6", {
      stateStore: harness.stateStore,
      lifecycleStore: lifecycle.store
    });

    await manager.prepareFreshDispatcherLaunch();

    expect(lifecycle.getState().workers).not.toHaveProperty("DISPATCHER");
    expect(lifecycle.getState().workers).toHaveProperty("N-01");
  });
});

async function createHarness(options?: { planContent?: string }): Promise<{
  directory: string;
  dispatchPlanPath: string;
  sidecarPath: string;
  stateStore: StateStore;
}> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-session-manager-"));
  tempDirectories.add(directory);

  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  const sidecarPath = path.join(directory, "dispatch_threads.json");
  await fs.writeFile(dispatchPlanPath, options?.planContent ?? buildDispatchPlan(), "utf8");

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
      state.workers.DISPATCHER = {
        thread_id: threadId,
        trace_id: null,
        started_at: FIXED_NOW,
        last_seen_at: FIXED_NOW,
        status: "running",
        expected_outputs: [],
        hub_result: null,
        command_preamble: null,
        retry_count: 0
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
