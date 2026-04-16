import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  launchDispatchWorker,
  type DispatchRunHandoffRequest,
  type LaunchDispatchWorkerConfig,
  type LaunchDispatchWorkerDeps
} from "../worker-launcher";
import { MeridianApiError, type MeridianApiClient } from "../meridian-api-client";

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
      spawnError: new Error("connect ECONNREFUSED 127.0.0.1:3000")
    });

    const result = await launchDispatchWorker(
      buildConfig(harness.dispatchPlanPath, harness.commandFilePath, harness.expectedSpawnDir),
      harness.deps
    );

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: connect ECONNREFUSED 127.0.0.1:3000"
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
});

async function createHarness(overrides: {
  gitRoot?: boolean;
  nestedDocsBranch?: boolean;
  detachedDocsWorkspace?: boolean;
  spawnError?: unknown;
  runHandoffAsyncError?: Error;
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
