import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  launchDispatchWorker,
  resetActiveRunHandoffsForTest,
  type DispatchRunHandoffRequest,
  type LaunchDispatchWorkerConfig,
  type LaunchDispatchWorkerDeps
} from "../worker-launcher";
import { LifecycleStore } from "../lifecycle-store";
import { MeridianApiError, type MeridianApiClient } from "../meridian-api-client";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  resetActiveRunHandoffsForTest();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("launchDispatchWorker", () => {
  it("spawns the worker via /api/spawn from the enclosing git repo root and hands off the run", async () => {
    const harness = await createHarness({
      gitRoot: true,
      nestedDocsBranch: true
    });

    const result = await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );

    expect(result).toEqual({
      ok: true,
      threadId: "worker-thread-123"
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.spawn).toHaveBeenCalledWith({
      agentType: "codex",
      mode: "pane_bridge",
      spawnDir: harness.expectedSpawnDir,
      modelId: "gpt-5.4",
      autoApprove: undefined
    });
    expect(harness.dispatchRunHandoff).toHaveBeenCalledTimes(1);
    expect(harness.dispatchRunHandoff).toHaveBeenCalledWith({
      threadId: "worker-thread-123",
      commandFilePath: harness.commandFilePath,
      workerId: "N-01",
      killPolicy: "always"
    });
  });

  it("falls back to the docs branch root when no git metadata is present", async () => {
    const harness = await createHarness({
      gitRoot: false,
      nestedDocsBranch: true
    });

    await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );

    expect(harness.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "codex",
      mode: "pane_bridge",
      spawnDir: harness.expectedSpawnDir,
      modelId: "gpt-5.4"
    }));
  });

  it("spawns detached Docs/Projects artifacts from the real project repo root", async () => {
    const harness = await createHarness({
      gitRoot: true,
      detachedDocsWorkspace: true
    });

    await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );

    expect(harness.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "codex",
      mode: "pane_bridge",
      spawnDir: harness.expectedSpawnDir,
      modelId: "gpt-5.4"
    }));
  });

  it("forwards autoApprove to /api/spawn when set on the launch config", async () => {
    const harness = await createHarness({
      gitRoot: true,
      nestedDocsBranch: true
    });

    await launchDispatchWorker(
      { ...buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir), autoApprove: true },
      harness.deps
    );

    expect(harness.spawn).toHaveBeenCalledWith(expect.objectContaining({
      autoApprove: true
    }));
  });

  it("returns a structured spawn error when /api/spawn rejects with a MeridianApiError", async () => {
    const harness = await createHarness({
      spawnError: new MeridianApiError("spawn failed: Hub rejected spawn", 400)
    });

    const result = await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Hub rejected spawn"
    });
    expect(harness.dispatchRunHandoff).not.toHaveBeenCalled();
  });

  it("wraps unexpected (non-MeridianApiError) spawn rejections with the spawn failed prefix", async () => {
    const harness = await createHarness({
      spawnError: new Error("unexpected internal error")
    });

    const result = await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: unexpected internal error"
    });
    expect(harness.dispatchRunHandoff).not.toHaveBeenCalled();
  });

  it("fails before /api/spawn when the dispatch repo root cannot be resolved from artifacts", async () => {
    const spawn = vi.fn();
    const dispatchRunHandoff = vi.fn();
    const meridianApi: MeridianApiClient = {
      spawn,
      run: vi.fn(),
      kill: vi.fn()
    };

    const result = await launchDispatchWorker({
      agentType: "codex",
      mode: "pane_bridge",
      commandFilePath: "   ",
      dispatchPlanPath: "",
      dispatchRepoRoot: "   ",
      workerId: "N-01",
      modelId: "gpt-5.4"
    }, {
      meridianApi,
      dispatchRunHandoff
    });

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Failed to resolve dispatch repo root from dispatch artifacts"
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(dispatchRunHandoff).not.toHaveBeenCalled();
  });

  it("returns ok with the spawned thread id even when the background run handoff rejects asynchronously", async () => {
    const backgroundError = new Error("Hub run rejected");
    const onBackgroundRunError = vi.fn();
    const harness = await createHarness({
      gitRoot: true,
      nestedDocsBranch: true,
      runHandoffAsyncError: backgroundError,
      onBackgroundRunError
    });

    const result = await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );

    expect(result).toEqual({
      ok: true,
      threadId: "worker-thread-123"
    });
    await flushMicrotasks();
    expect(onBackgroundRunError).toHaveBeenCalledTimes(1);
    expect(onBackgroundRunError).toHaveBeenCalledWith(backgroundError, expect.objectContaining({
      threadId: "worker-thread-123",
      workerId: "N-01"
    }) as DispatchRunHandoffRequest);
  });

  it("refuses to hand off a second worker to the same active thread id", async () => {
    const harness = await createHarness({
      gitRoot: true,
      nestedDocsBranch: true,
      runHandoffMode: "pending"
    });
    harness.spawn.mockResolvedValue({ threadId: "worker-thread-collision" });

    const first = await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );
    const second = await launchDispatchWorker(
      {
        ...buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
        workerId: "N-02"
      },
      harness.deps
    );

    expect(first).toEqual({
      ok: true,
      threadId: "worker-thread-collision"
    });
    expect(second).toEqual({
      ok: false,
      threadId: "worker-thread-collision",
      error: "spawn failed: Meridian returned active thread id worker-thread-collision for another in-flight worker"
    });
    expect(harness.dispatchRunHandoff).toHaveBeenCalledTimes(1);
  });

  it("retries spawn when Meridian returns a thread id that already has an active handoff", async () => {
    const harness = await createHarness({
      gitRoot: true,
      nestedDocsBranch: true,
      runHandoffMode: "pending"
    });
    harness.spawn
      .mockResolvedValueOnce({ threadId: "worker-thread-collision" })
      .mockResolvedValueOnce({ threadId: "worker-thread-collision" })
      .mockResolvedValueOnce({ threadId: "worker-thread-fresh" });

    const first = await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );
    const second = await launchDispatchWorker(
      {
        ...buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
        workerId: "N-02"
      },
      harness.deps
    );

    expect(first).toEqual({
      ok: true,
      threadId: "worker-thread-collision"
    });
    expect(second).toEqual({
      ok: true,
      threadId: "worker-thread-fresh"
    });
    expect(harness.spawn).toHaveBeenCalledTimes(3);
    expect(harness.dispatchRunHandoff).toHaveBeenCalledTimes(2);
    expect(harness.dispatchRunHandoff).toHaveBeenLastCalledWith({
      threadId: "worker-thread-fresh",
      commandFilePath: harness.commandFilePath,
      workerId: "N-02",
      killPolicy: "always"
    });
  });

  it("retries spawn when Meridian returns a thread id already recorded in lifecycle state", async () => {
    const harness = await createHarness({
      gitRoot: true,
      nestedDocsBranch: true
    });
    const lifecycleStore = new LifecycleStore(path.join(path.dirname(harness.dispatchPlanPath), "dispatch_threads.json"), {
      dispatchPlanPath: harness.dispatchPlanPath
    });
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-27T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-04": {
          thread_id: "worker-thread-existing",
          trace_id: null,
          started_at: "2026-04-27T00:00:00.000Z",
          last_seen_at: "2026-04-27T00:10:00.000Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: "validator-thread-existing",
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      },
      last_reconciled_at: null
    });
    harness.spawn
      .mockResolvedValueOnce({ threadId: "validator-thread-existing" })
      .mockResolvedValueOnce({ threadId: "worker-thread-existing" })
      .mockResolvedValueOnce({ threadId: "worker-thread-fresh" });

    const result = await launchDispatchWorker(
      {
        ...buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
        workerId: "BATCH-2-GATE"
      },
      harness.deps
    );

    expect(result).toEqual({
      ok: true,
      threadId: "worker-thread-fresh"
    });
    expect(harness.spawn).toHaveBeenCalledTimes(3);
    expect(harness.dispatchRunHandoff).toHaveBeenCalledTimes(1);
    expect(harness.dispatchRunHandoff).toHaveBeenCalledWith({
      threadId: "worker-thread-fresh",
      commandFilePath: harness.commandFilePath,
      workerId: "BATCH-2-GATE",
      killPolicy: "always"
    });
  });
});

async function createHarness(overrides: {
  gitRoot?: boolean;
  nestedDocsBranch?: boolean;
  detachedDocsWorkspace?: boolean;
  spawnError?: unknown;
  runHandoffAsyncError?: Error;
  runHandoffMode?: "resolve" | "pending";
  onBackgroundRunError?: LaunchDispatchWorkerDeps["onBackgroundRunError"];
} = {}): Promise<{
  deps: LaunchDispatchWorkerDeps;
  spawn: ReturnType<typeof vi.fn>;
  dispatchRunHandoff: ReturnType<typeof vi.fn>;
  dispatchPlanPath: string;
  commandFilePath: string;
  expectedSpawnDir: string;
}> {
  const workspaceRoot = overrides.detachedDocsWorkspace
    ? await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-worker-workspace-"))
    : null;
  if (workspaceRoot) {
    tempDirectories.add(workspaceRoot);
  }

  const repoRoot = workspaceRoot
    ? path.join(workspaceRoot, "projects/clawso")
    : await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-worker-launcher-"));
  if (!workspaceRoot) {
    tempDirectories.add(repoRoot);
  }

  const dispatchDirectory = overrides.detachedDocsWorkspace
    ? path.join(workspaceRoot!, "Docs/Projects/clawso/branch/feat-test/taskspec")
    : overrides.nestedDocsBranch
      ? path.join(repoRoot, "docs/branch/feat-test")
      : repoRoot;

  if (overrides.gitRoot) {
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
  }

  await fs.mkdir(dispatchDirectory, { recursive: true });

  const dispatchPlanPath = path.join(dispatchDirectory, "dispatch_plan.md");
  const commandFilePath = path.join(dispatchDirectory, "agent_dispatch_command.md");
  await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");
  await fs.writeFile(commandFilePath, "# command\n", "utf8");

  const expectedSpawnDir = overrides.detachedDocsWorkspace ? await fs.realpath(repoRoot) : repoRoot;

  const spawn = overrides.spawnError
    ? vi.fn().mockRejectedValue(overrides.spawnError)
    : vi.fn().mockResolvedValue({ threadId: "worker-thread-123" });
  const meridianApi: MeridianApiClient = {
    spawn,
    run: vi.fn(),
    kill: vi.fn()
  };

  const dispatchRunHandoff = vi.fn().mockImplementation(async () => {
    if (overrides.runHandoffMode === "pending") {
      await new Promise(() => undefined);
    }
    if (overrides.runHandoffAsyncError) {
      throw overrides.runHandoffAsyncError;
    }
  });

  return {
    deps: {
      meridianApi,
      dispatchRunHandoff,
      ...(overrides.onBackgroundRunError ? { onBackgroundRunError: overrides.onBackgroundRunError } : {})
    },
    spawn,
    dispatchRunHandoff,
    dispatchPlanPath,
    commandFilePath,
    expectedSpawnDir
  };
}

function buildConfig(
  dispatchPlanPath: string,
  commandFilePath: string,
  dispatchRepoRoot: string
): LaunchDispatchWorkerConfig {
  return {
    agentType: "codex",
    mode: "pane_bridge",
    killPolicy: "always",
    commandFilePath,
    dispatchPlanPath,
    dispatchRepoRoot,
    workerId: "N-01",
    modelId: "gpt-5.4"
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}
