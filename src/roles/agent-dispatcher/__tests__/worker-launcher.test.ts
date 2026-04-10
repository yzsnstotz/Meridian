import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  launchDispatchWorker,
  type LaunchDispatchWorkerConfig,
  type LaunchDispatchWorkerDeps
} from "../worker-launcher";
import { buildMeridianToolArgs, MERIDIAN_TOOL_EXECUTABLE } from "../tool-entrypoint";

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
  it("spawns a worker from the enclosing git repo root and detaches meridian-tool run", async () => {
    const harness = await createHarness({
      gitRoot: true,
      nestedDocsBranch: true
    });

    const result = await launchDispatchWorker(buildConfig(harness.dispatchPlanPath, harness.commandFilePath), harness.deps);

    expect(result).toEqual({
      ok: true,
      threadId: "worker-thread-123"
    });
    expect(harness.execFile).toHaveBeenCalledWith(MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "spawn",
      "--agent-type",
      "codex",
      "--spawn-dir",
      harness.expectedSpawnDir,
      "--mode",
      "pane_bridge",
      "--model-id",
      "gpt-5.4"
    ]));
    expect(harness.spawn).toHaveBeenCalledWith(
      MERIDIAN_TOOL_EXECUTABLE,
      buildMeridianToolArgs([
        "run",
        "--thread-id",
        "worker-thread-123",
        "--command",
        harness.commandFilePath,
        "--worker",
        "N-01"
      ]),
      {
        detached: true,
        stdio: "ignore"
      }
    );
    expect(harness.runProcess.unref).toHaveBeenCalledTimes(1);
  });

  it("falls back to the docs branch root when no git metadata is present", async () => {
    const harness = await createHarness({
      gitRoot: false,
      nestedDocsBranch: true
    });

    await launchDispatchWorker(buildConfig(harness.dispatchPlanPath, harness.commandFilePath), harness.deps);

    expect(harness.execFile).toHaveBeenCalledWith(MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "spawn",
      "--agent-type",
      "codex",
      "--spawn-dir",
      harness.expectedSpawnDir,
      "--mode",
      "pane_bridge",
      "--model-id",
      "gpt-5.4"
    ]));
  });

  it("returns a structured error when meridian-tool spawn fails", async () => {
    const harness = await createHarness({
      execFileError: new Error("Command failed: spawn")
    });

    const result = await launchDispatchWorker(buildConfig(harness.dispatchPlanPath, harness.commandFilePath), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Command failed: spawn"
    });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("fails before spawn when the dispatch repo root cannot be resolved from artifacts", async () => {
    const execFile = vi.fn();
    const spawn = vi.fn();

    const result = await launchDispatchWorker({
      agentType: "codex",
      mode: "pane_bridge",
      commandFilePath: "   ",
      dispatchPlanPath: "",
      workerId: "N-01",
      modelId: "gpt-5.4"
    }, {
      execFile,
      spawn
    });

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Failed to resolve dispatch repo root from dispatch artifacts"
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns the spawned thread id when detached run launch fails", async () => {
    const harness = await createHarness({
      spawnError: new Error("ENOENT")
    });

    const result = await launchDispatchWorker(buildConfig(harness.dispatchPlanPath, harness.commandFilePath), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "worker-thread-123",
      error: "run launch failed: ENOENT"
    });
  });
});

async function createHarness(overrides: {
  gitRoot?: boolean;
  nestedDocsBranch?: boolean;
  stdout?: string;
  execFileError?: Error;
  spawnError?: Error;
} = {}): Promise<{
  deps: LaunchDispatchWorkerDeps;
  execFile: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  runProcess: { unref: ReturnType<typeof vi.fn> };
  dispatchPlanPath: string;
  commandFilePath: string;
  expectedSpawnDir: string;
}> {
  const repoRoot = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-worker-launcher-"));
  tempDirectories.add(repoRoot);

  if (overrides.gitRoot) {
    await fs.mkdir(path.join(repoRoot, ".git"));
  }

  const dispatchDirectory = overrides.nestedDocsBranch
    ? path.join(repoRoot, "docs/branch/feat-test")
    : repoRoot;
  await fs.mkdir(dispatchDirectory, { recursive: true });

  const dispatchPlanPath = path.join(dispatchDirectory, "dispatch_plan.md");
  const commandFilePath = path.join(dispatchDirectory, "agent_dispatch_command.md");
  await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");
  await fs.writeFile(commandFilePath, "# command\n", "utf8");

  const expectedSpawnDir = repoRoot;
  const runProcess = {
    unref: vi.fn()
  };
  const execFile = overrides.execFileError
    ? vi.fn().mockRejectedValue(overrides.execFileError)
    : vi.fn().mockResolvedValue({
        stdout: overrides.stdout ?? "{\"ok\":true,\"data\":{\"thread_id\":\"worker-thread-123\"}}",
        stderr: ""
      });
  const spawn = overrides.spawnError
    ? vi.fn().mockImplementation(() => {
        throw overrides.spawnError;
      })
    : vi.fn().mockReturnValue(runProcess);

  return {
    deps: {
      execFile,
      spawn
    },
    execFile,
    spawn,
    runProcess,
    dispatchPlanPath,
    commandFilePath,
    expectedSpawnDir
  };
}

function buildConfig(dispatchPlanPath: string, commandFilePath: string): LaunchDispatchWorkerConfig {
  return {
    agentType: "codex",
    mode: "pane_bridge",
    commandFilePath,
    dispatchPlanPath,
    workerId: "N-01",
    modelId: "gpt-5.4"
  };
}
