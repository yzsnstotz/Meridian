import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatcherHubSystemPromptPath,
  launchDispatcher,
  type LaunchConfig,
  type LaunchDispatcherDeps
} from "../launcher";

describe("launchDispatcher", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  it("spawns the dispatcher, detaches meridian-tool run, and keeps the Hub prompt file next to the plan", async () => {
    const harness = await createHarness();

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

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
      harness.planDirectory,
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
        harness.expectedCommandPath,
        "--worker",
        "DISPATCHER"
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    expect(harness.runProcess.unref).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(harness.expectedCommandPath, "utf8")).resolves.toBe("System prompt text");
  });

  it("returns a structured error when meridian-tool spawn fails", async () => {
    const harness = await createHarness({
      execFileError: new Error("Command failed: npx")
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Command failed: npx"
    });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("returns a parse failure when spawn output does not include a dispatcher thread id", async () => {
    const harness = await createHarness({
      stdout: "{\"ok\":true,\"data\":{}}"
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "Failed to parse spawn response"
    });
    expect(harness.spawn).not.toHaveBeenCalled();
    await expect(fs.access(harness.expectedCommandPath)).rejects.toThrow();
  });

  it("returns the spawned thread id when detached run launch fails", async () => {
    const harness = await createHarness({
      spawnError: new Error("ENOENT")
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "dispatcher-thread-123",
      error: "run launch failed: ENOENT"
    });
    await expect(fs.access(harness.expectedCommandPath)).rejects.toThrow();
  });

  it("maps a structured spawn CLI failure without throwing", async () => {
    const harness = await createHarness({
      stdout: "{\"ok\":false,\"error\":\"Hub rejected spawn\"}"
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Hub rejected spawn"
    });
    expect(harness.spawn).not.toHaveBeenCalled();
  });
});

describe("dispatcherHubSystemPromptPath", () => {
  it("places the prompt file in the dispatch plan directory with a sanitized role id", () => {
    expect(
      dispatcherHubSystemPromptPath("/Users/proj/docs/dispatch_plan.md", "feat-cli-external-integration")
    ).toBe(
      path.join("/Users/proj/docs", ".meridian-roles-dispatcher-prompt-feat-cli-external-integration.md")
    );
    expect(dispatcherHubSystemPromptPath("/abs/plan.md", "role/with:bad*chars")).toBe(
      path.join("/abs", ".meridian-roles-dispatcher-prompt-role_with_bad_chars.md")
    );
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
  planDirectory: string;
  expectedCommandPath: string;
}> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-launcher-");
  tempDirectories.push(directory);
  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");
  const expectedCommandPath = dispatcherHubSystemPromptPath(dispatchPlanPath, "test-role");

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
      }
    },
    execFile,
    spawn,
    runProcess,
    planDirectory: directory,
    expectedCommandPath
  };
}

function buildConfig(planDirectory: string, systemPrompt: string): LaunchConfig {
  return {
    agentType: "codex",
    mode: "bridge",
    systemPrompt,
    dispatchPlanPath: path.join(planDirectory, "dispatch_plan.md"),
    commandFilePath: path.join(planDirectory, "agent_dispatch_command.md"),
    dispatcherRoleId: "test-role",
    userReplyChannel: {
      channel: "telegram",
      chat_id: "telegram:123"
    }
  };
}
