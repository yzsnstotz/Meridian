import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { launchDispatcher, type LaunchConfig, type LaunchDispatcherDeps } from "../launcher";

describe("launchDispatcher", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  it("spawns the dispatcher, detaches meridian-tool run, and cleans up the temp command file", async () => {
    const harness = await createHarness();

    const result = await launchDispatcher(buildConfig("System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: true,
      threadId: "dispatcher-thread-123"
    });
    expect(harness.execFile).toHaveBeenCalledWith("npx", [
      "tsx",
      "src/bin/meridian-tool.ts",
      "spawn",
      "--agent-type",
      "codex",
      "--spawn-dir",
      process.cwd(),
      "--mode",
      "bridge"
    ]);
    expect(harness.spawn).toHaveBeenCalledWith(
      "npx",
      [
        "tsx",
        "src/bin/meridian-tool.ts",
        "run",
        "--thread-id",
        "dispatcher-thread-123",
        "--command",
        harness.commandPath,
        "--worker",
        "DISPATCHER"
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    expect(harness.runProcess.unref).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(harness.commandPath, "utf8")).resolves.toBe("System prompt text");
    expect(harness.scheduledCallbacks).toHaveLength(1);

    await harness.scheduledCallbacks[0]();
    await expect(fs.access(harness.commandPath)).rejects.toThrow();
  });

  it("returns a structured error when meridian-tool spawn fails", async () => {
    const harness = await createHarness({
      execFileError: new Error("Command failed: npx")
    });

    const result = await launchDispatcher(buildConfig("System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Command failed: npx"
    });
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.scheduledCallbacks).toHaveLength(0);
  });

  it("returns a parse failure when spawn output does not include a dispatcher thread id", async () => {
    const harness = await createHarness({
      stdout: "{\"ok\":true,\"data\":{}}"
    });

    const result = await launchDispatcher(buildConfig("System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "Failed to parse spawn response"
    });
    expect(harness.spawn).not.toHaveBeenCalled();
    await expect(fs.access(harness.commandPath)).rejects.toThrow();
  });

  it("returns the spawned thread id when detached run launch fails", async () => {
    const harness = await createHarness({
      spawnError: new Error("ENOENT")
    });

    const result = await launchDispatcher(buildConfig("System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "dispatcher-thread-123",
      error: "run launch failed: ENOENT"
    });
    expect(harness.scheduledCallbacks).toHaveLength(0);
    await expect(fs.access(harness.commandPath)).rejects.toThrow();
  });

  it("maps a structured spawn CLI failure without throwing", async () => {
    const harness = await createHarness({
      stdout: "{\"ok\":false,\"error\":\"Hub rejected spawn\"}"
    });

    const result = await launchDispatcher(buildConfig("System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Hub rejected spawn"
    });
    expect(harness.spawn).not.toHaveBeenCalled();
  });
});

const tempDirectories: string[] = [];

async function createHarness(overrides: {
  stdout?: string;
  execFileError?: Error;
  spawnError?: Error;
} = {}): Promise<{
  deps: LaunchDispatcherDeps;
  execFile: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  runProcess: { unref: ReturnType<typeof vi.fn> };
  commandPath: string;
  scheduledCallbacks: Array<() => void | Promise<void>>;
}> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-launcher-");
  tempDirectories.push(directory);

  const commandPath = path.join(directory, "dispatcher_cmd_test.md");
  const scheduledCallbacks: Array<() => void | Promise<void>> = [];
  const runProcess = {
    unref: vi.fn()
  };

  const execFile = overrides.execFileError
    ? vi.fn().mockRejectedValue(overrides.execFileError)
    : vi.fn().mockResolvedValue({
        stdout: overrides.stdout ?? "{\"ok\":true,\"data\":{\"thread_id\":\"dispatcher-thread-123\"}}",
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
      spawn,
      writeFile(filePath, contents) {
        return fs.writeFile(filePath, contents, "utf8");
      },
      unlink(filePath) {
        return fs.unlink(filePath);
      },
      createCommandFilePath() {
        return commandPath;
      },
      setTimeout(callback) {
        scheduledCallbacks.push(callback);
        return {
          unref: vi.fn()
        };
      },
      cleanupDelayMs: 5_000
    },
    execFile,
    spawn,
    runProcess,
    commandPath,
    scheduledCallbacks
  };
}

function buildConfig(systemPrompt: string): LaunchConfig {
  return {
    agentType: "codex",
    mode: "bridge",
    systemPrompt,
    dispatchPlanPath: "/tmp/dispatch_plan.md",
    commandFilePath: "/tmp/agent_dispatch_command.md",
    userReplyChannel: {
      channel: "telegram",
      chat_id: "telegram:123"
    }
  };
}
