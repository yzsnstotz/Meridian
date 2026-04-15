import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatcherHubSystemPromptPath,
  launchDispatcher,
  type LaunchConfig,
  type LaunchDispatcherDeps
} from "../launcher";
import {
  buildMeridianToolArgs,
  MERIDIAN_TOOL_EXECUTABLE,
  MERIDIAN_TOOL_DISPLAY_COMMAND,
  resolveMeridianToolCommand
} from "../tool-entrypoint";

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
    expect(harness.execFile).toHaveBeenCalledWith(MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "spawn",
      "--agent-type",
      "codex",
      "--spawn-dir",
      harness.planDirectory,
      "--mode",
      "bridge"
    ]));
    expect(harness.spawn).toHaveBeenCalledWith(
      MERIDIAN_TOOL_EXECUTABLE,
      buildMeridianToolArgs([
        "run",
        "--thread-id",
        "dispatcher-thread-123",
        "--command",
        harness.expectedCommandPath,
        "--worker",
        "DISPATCHER"
      ]),
      {
        detached: true,
        stdio: "ignore"
      }
    );
    expect(harness.runProcess.unref).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(harness.expectedCommandPath, "utf8")).resolves.toBe("System prompt text");
  });

  it("forwards an explicit dispatcher model_id to meridian-tool spawn", async () => {
    const harness = await createHarness();

    const result = await launchDispatcher(
      buildConfig(harness.planDirectory, "System prompt text", { agentType: "claude", modelId: "claude-opus-4-6" }),
      harness.deps
    );

    expect(result).toEqual({
      ok: true,
      threadId: "dispatcher-thread-123"
    });
    expect(harness.execFile).toHaveBeenCalledWith(MERIDIAN_TOOL_EXECUTABLE, buildMeridianToolArgs([
      "spawn",
      "--agent-type",
      "claude",
      "--spawn-dir",
      harness.planDirectory,
      "--mode",
      "bridge",
      "--model-id",
      "claude-opus-4-6"
    ]));
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

  it("prefers the structured CLI error payload when meridian-tool spawn exits non-zero", async () => {
    const cliError = new Error("Command failed: meridian-tool");
    Object.assign(cliError, {
      stdout: "{\"ok\":false,\"error\":\"Hub rejected spawn\"}\n",
      stderr: "Usage: meridian-roles\n"
    });
    const harness = await createHarness({
      execFileError: cliError
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Hub rejected spawn"
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

  it("resolves the meridian-tool command independently of process.cwd()", () => {
    expect(MERIDIAN_TOOL_DISPLAY_COMMAND).toContain("meridian-tool");
    expect(MERIDIAN_TOOL_DISPLAY_COMMAND.length).toBeGreaterThan(0);
  });

  it("prefers the compiled meridian-tool entrypoint even while meridian-roles is running from src", () => {
    const repoRoot = "/tmp/meridian-roles";
    const command = resolveMeridianToolCommand({
      repoRoot,
      runtimeTree: "src",
      nodeExecutable: "/usr/local/bin/node",
      existsSync: (filePath) =>
        filePath === path.join(repoRoot, "dist/bin/meridian-tool.js")
        || filePath === path.join(repoRoot, "src/bin/meridian-tool.ts")
        || filePath === path.join(repoRoot, "node_modules/.bin/tsx")
    });

    expect(command).toEqual({
      command: "/usr/local/bin/node",
      args: [path.join(repoRoot, "dist/bin/meridian-tool.js")],
      displayCommand: `/usr/local/bin/node ${path.join(repoRoot, "dist/bin/meridian-tool.js")}`,
      entrypointPath: path.join(repoRoot, "dist/bin/meridian-tool.js")
    });
  });

  it("keeps tsx as the development fallback when dist is absent", () => {
    const repoRoot = "/tmp/meridian-roles";
    const command = resolveMeridianToolCommand({
      repoRoot,
      runtimeTree: "src",
      existsSync: (filePath) =>
        filePath === path.join(repoRoot, "src/bin/meridian-tool.ts")
        || filePath === path.join(repoRoot, "node_modules/.bin/tsx")
    });

    expect(command.command).toBe(path.join(repoRoot, "node_modules/.bin/tsx"));
    expect(command.args).toEqual([path.join(repoRoot, "src/bin/meridian-tool.ts")]);
  });

  it("still prefers the compiled meridian-tool entrypoint when meridian-roles is running from dist", () => {
    const repoRoot = "/tmp/meridian-roles";
    const command = resolveMeridianToolCommand({
      repoRoot,
      runtimeTree: "dist",
      nodeExecutable: "/usr/local/bin/node",
      existsSync: (filePath) =>
        filePath === path.join(repoRoot, "dist/bin/meridian-tool.js")
        || filePath === path.join(repoRoot, "src/bin/meridian-tool.ts")
        || filePath === path.join(repoRoot, "node_modules/.bin/tsx")
    });

    expect(command).toEqual({
      command: "/usr/local/bin/node",
      args: [path.join(repoRoot, "dist/bin/meridian-tool.js")],
      displayCommand: `/usr/local/bin/node ${path.join(repoRoot, "dist/bin/meridian-tool.js")}`,
      entrypointPath: path.join(repoRoot, "dist/bin/meridian-tool.js")
    });
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

function buildConfig(
  planDirectory: string,
  systemPrompt: string,
  overrides: Partial<Pick<LaunchConfig, "agentType" | "modelId" | "mode">> = {}
): LaunchConfig {
  return {
    agentType: overrides.agentType ?? "codex",
    ...(overrides.modelId ? { modelId: overrides.modelId } : {}),
    mode: overrides.mode ?? "bridge",
    systemPrompt,
    dispatchRepoRoot: planDirectory,
    dispatchPlanPath: path.join(planDirectory, "dispatch_plan.md"),
    commandFilePath: path.join(planDirectory, "agent_dispatch_command.md"),
    dispatcherRoleId: "test-role",
    userReplyChannel: {
      channel: "telegram",
      chat_id: "telegram:123"
    }
  };
}
