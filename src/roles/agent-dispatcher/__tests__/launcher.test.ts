import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatcherHubSystemPromptPath,
  launchDispatcher,
  type DispatcherRunHandoffRequest,
  type LaunchConfig,
  type LaunchDispatcherDeps
} from "../launcher";
import { LifecycleStore } from "../lifecycle-store";
import { MeridianApiError, type MeridianApiClient } from "../meridian-api-client";
import {
  MERIDIAN_TOOL_DISPLAY_COMMAND,
  resolveMeridianToolCommand
} from "../tool-entrypoint";

describe("launchDispatcher", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  it("spawns the dispatcher via Meridian /api/spawn, hands off the run, and writes the Hub prompt next to the plan", async () => {
    const harness = await createHarness();

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: true,
      threadId: "dispatcher-thread-123"
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.spawn).toHaveBeenCalledWith({
      agentType: "codex",
      mode: "bridge",
      spawnDir: harness.planDirectory,
      modelId: undefined,
      autoApprove: undefined
    });
    expect(harness.dispatchRunHandoff).toHaveBeenCalledTimes(1);
    expect(harness.dispatchRunHandoff).toHaveBeenCalledWith({
      threadId: "dispatcher-thread-123",
      commandFilePath: harness.expectedCommandPath,
      workerId: "DISPATCHER"
    });
    await expect(fs.readFile(harness.expectedCommandPath, "utf8")).resolves.toBe("System prompt text");
  });

  it("forwards an explicit dispatcher model_id and autoApprove to /api/spawn", async () => {
    const harness = await createHarness();

    const result = await launchDispatcher(
      buildConfig(harness.planDirectory, "System prompt text", {
        agentType: "claude",
        modelId: "claude-opus-4-6",
        autoApprove: true
      }),
      harness.deps
    );

    expect(result).toEqual({
      ok: true,
      threadId: "dispatcher-thread-123"
    });
    expect(harness.spawn).toHaveBeenCalledWith({
      agentType: "claude",
      mode: "bridge",
      spawnDir: harness.planDirectory,
      modelId: "claude-opus-4-6",
      autoApprove: true
    });
  });

  it("returns a structured error when /api/spawn fails", async () => {
    const harness = await createHarness({
      spawnError: new MeridianApiError("spawn failed: Hub rejected spawn", 400)
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Hub rejected spawn"
    });
    expect(harness.dispatchRunHandoff).not.toHaveBeenCalled();
    await expect(fs.access(harness.expectedCommandPath)).rejects.toThrow();
  });

  it("does NOT retry when /api/spawn fails with an HTTP-spawn-timeout error", async () => {
    // The Hub may have completed the spawn server-side after our 60s HTTP
    // client aborted; a retry would allocate a NEW thread_id and leave the
    // first agentapi+codex pair as a managed leak (no binding, surfaces in
    // the Processes tab). Other transport errors (ECONNREFUSED, fetch failed
    // pre-request, etc.) still retry — those prove the connection produced no
    // request. See SPAWN_HTTP_TIMEOUT_PATTERN in launcher.ts.
    const harness = await createHarness({
      spawnError: new MeridianApiError(
        "spawn failed: Meridian API unreachable at http://127.0.0.1:3000/: spawn request timed out after 60000ms"
      )
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("spawn request timed out after 60000ms");
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("wraps unexpected (non-MeridianApiError) spawn rejections with the spawn failed prefix", async () => {
    const harness = await createHarness({
      spawnError: new Error("unexpected internal error")
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: unexpected internal error"
    });
    expect(harness.dispatchRunHandoff).not.toHaveBeenCalled();
  });

  it("returns the spawned thread id and unlinks the prompt when handoff initiation throws synchronously", async () => {
    const handoffSyncError = new Error("handoff init failed");
    const harness = await createHarness({
      runHandoffSyncError: handoffSyncError
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "dispatcher-thread-123",
      error: "run launch failed: handoff init failed"
    });
    await expect(fs.access(harness.expectedCommandPath)).rejects.toThrow();
  });

  it("reports background run rejections through onBackgroundRunError without affecting the launch result", async () => {
    const backgroundError = new Error("Hub run rejected");
    const onBackgroundRunError = vi.fn();
    const harness = await createHarness({
      runHandoffAsyncError: backgroundError,
      onBackgroundRunError
    });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: true,
      threadId: "dispatcher-thread-123"
    });
    await flushMicrotasks();
    expect(onBackgroundRunError).toHaveBeenCalledTimes(1);
    expect(onBackgroundRunError).toHaveBeenCalledWith(backgroundError, expect.objectContaining({
      threadId: "dispatcher-thread-123",
      workerId: "DISPATCHER"
    }) as DispatcherRunHandoffRequest);
  });

  it("retries when Meridian returns a thread id already recorded in lifecycle state", async () => {
    const harness = await createHarness();
    const dispatchPlanPath = path.join(harness.planDirectory, "dispatch_plan.md");
    const lifecycleStore = new LifecycleStore(path.join(harness.planDirectory, "dispatch_threads.json"), {
      dispatchPlanPath
    });
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-old",
        started_at: "2026-04-27T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-03": {
          thread_id: "worker-thread-existing",
          trace_id: null,
          started_at: "2026-04-27T00:00:00.000Z",
          last_seen_at: "2026-04-27T00:10:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    harness.spawn
      .mockResolvedValueOnce({ threadId: "worker-thread-existing" })
      .mockResolvedValueOnce({ threadId: "dispatcher-thread-fresh" });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: true,
      threadId: "dispatcher-thread-fresh"
    });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    // The colliding id `worker-thread-existing` is the *live* worker thread for
    // N-03 (status=running). Killing it would terminate the live worker, so the
    // orphan-kill branch is suppressed; the spawn just retries until it lands
    // on a non-colliding id.
    expect(harness.kill).not.toHaveBeenCalled();
    expect(harness.dispatchRunHandoff).toHaveBeenCalledWith({
      threadId: "dispatcher-thread-fresh",
      commandFilePath: harness.expectedCommandPath,
      workerId: "DISPATCHER"
    });
  });

  it("returns the reserved thread id without double-prefixing the error after retry exhaustion", async () => {
    const harness = await createHarness();
    const dispatchPlanPath = path.join(harness.planDirectory, "dispatch_plan.md");
    const lifecycleStore = new LifecycleStore(path.join(harness.planDirectory, "dispatch_threads.json"), {
      dispatchPlanPath
    });
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-old",
        started_at: "2026-04-27T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-03": {
          thread_id: "worker-thread-existing",
          trace_id: null,
          started_at: "2026-04-27T00:00:00.000Z",
          last_seen_at: "2026-04-27T00:10:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    harness.spawn.mockResolvedValue({ threadId: "worker-thread-existing" });

    const result = await launchDispatcher(buildConfig(harness.planDirectory, "System prompt text"), harness.deps);

    expect(result).toEqual({
      ok: false,
      threadId: "worker-thread-existing",
      error: "spawn failed: Meridian returned reserved thread id worker-thread-existing already recorded in lifecycle state"
    });
    expect(harness.spawn).toHaveBeenCalledTimes(3);
    // `worker-thread-existing` is N-03's live worker thread (status=running);
    // the orphan-kill branch is suppressed for live worker collisions to avoid
    // taking out the worker agent. Retry exhaustion still surfaces the
    // collision error to the caller.
    expect(harness.kill).not.toHaveBeenCalled();
    expect(harness.dispatchRunHandoff).not.toHaveBeenCalled();
  });

  it("retries (and skips orphan-kill) when Meridian returns a thread id reserved by ANOTHER dispatch plan", async () => {
    // Mirror the post-Hub-restart scenario: a sibling dispatcher role's
    // dispatch_threads.json already pins `codex_01` (status=running), the Hub
    // allocator wraps and hands the same id back to *our* spawn. Without the
    // cross-plan guard, both sidecars would converge on codex_01 and silently
    // share a single Hub session across two role lifecycles.
    const harness = await createHarness();
    const siblingDirectory = await fs.mkdtemp("/tmp/meridian-roles-launcher-sibling-");
    tempDirectories.push(siblingDirectory);
    const siblingDispatchPlanPath = path.join(siblingDirectory, "dispatch_plan.md");
    await fs.writeFile(siblingDispatchPlanPath, "# sibling plan\n", "utf8");
    const siblingStore = new LifecycleStore(
      path.join(siblingDirectory, "dispatch_threads.json"),
      { dispatchPlanPath: siblingDispatchPlanPath }
    );
    siblingStore.save({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-12T13:21:55.521Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    });
    harness.spawn
      .mockResolvedValueOnce({ threadId: "codex_01" })
      .mockResolvedValueOnce({ threadId: "codex_02" });

    const result = await launchDispatcher(
      {
        ...buildConfig(harness.planDirectory, "System prompt text"),
        otherDispatchPlanPaths: [siblingDispatchPlanPath]
      },
      harness.deps
    );

    expect(result).toEqual({
      ok: true,
      threadId: "codex_02"
    });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    // Cross-plan collisions MUST skip the orphan-kill: `codex_01` is the
    // sibling's live dispatcher session, not an orphan from our perspective.
    expect(harness.kill).not.toHaveBeenCalled();
    expect(harness.dispatchRunHandoff).toHaveBeenCalledWith({
      threadId: "codex_02",
      commandFilePath: harness.expectedCommandPath,
      workerId: "DISPATCHER"
    });
  });

  it("fails before /api/spawn when the dispatch repo root cannot be resolved", async () => {
    const spawn = vi.fn();
    const dispatchRunHandoff = vi.fn();
    const meridianApi: MeridianApiClient = {
      spawn,
      run: vi.fn(),
      kill: vi.fn()
    };

    const result = await launchDispatcher({
      agentType: "codex",
      mode: "bridge",
      systemPrompt: "prompt",
      dispatchRepoRoot: "   ",
      dispatchPlanPath: "",
      commandFilePath: "   ",
      dispatcherRoleId: "test-role",
      userReplyChannel: { channel: "telegram", chat_id: "telegram:123" }
    }, {
      meridianApi,
      dispatchRunHandoff,
      writeFile: vi.fn(),
      unlink: vi.fn()
    });

    expect(result).toEqual({
      ok: false,
      threadId: "",
      error: "spawn failed: Failed to resolve dispatch repo root from dispatch artifacts"
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(dispatchRunHandoff).not.toHaveBeenCalled();
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

  it("resolves the meridian-tool display command independently of process.cwd()", () => {
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
      displayCommand: `node ${path.join(repoRoot, "dist/bin/meridian-tool.js")}`,
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
      displayCommand: `node ${path.join(repoRoot, "dist/bin/meridian-tool.js")}`,
      entrypointPath: path.join(repoRoot, "dist/bin/meridian-tool.js")
    });
  });

  it("does not leak host-specific node toolchain paths into displayCommand", () => {
    const repoRoot = "/tmp/meridian-roles";
    const hermesNode = "/Users/yzliu/.hermes/node/bin/node";
    const command = resolveMeridianToolCommand({
      repoRoot,
      runtimeTree: "dist",
      nodeExecutable: hermesNode,
      existsSync: (filePath) => filePath === path.join(repoRoot, "dist/bin/meridian-tool.js")
    });

    expect(command.command).toBe(hermesNode);
    expect(command.displayCommand).not.toContain(hermesNode);
    expect(command.displayCommand.startsWith("node ")).toBe(true);
  });
});

const tempDirectories: string[] = [];

async function createHarness(overrides: {
  spawnError?: unknown;
  runHandoffSyncError?: Error;
  runHandoffAsyncError?: Error;
  onBackgroundRunError?: LaunchDispatcherDeps["onBackgroundRunError"];
} = {}): Promise<{
  deps: LaunchDispatcherDeps;
  spawn: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  dispatchRunHandoff: ReturnType<typeof vi.fn>;
  planDirectory: string;
  expectedCommandPath: string;
}> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-launcher-");
  tempDirectories.push(directory);
  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");
  const expectedCommandPath = dispatcherHubSystemPromptPath(dispatchPlanPath, "test-role");

  const spawn = overrides.spawnError
    ? vi.fn().mockRejectedValue(overrides.spawnError)
    : vi.fn().mockResolvedValue({ threadId: "dispatcher-thread-123" });
  const kill = vi.fn().mockResolvedValue({ threadId: "", status: "killed", raw: {} });
  const meridianApi: MeridianApiClient = {
    spawn,
    run: vi.fn(),
    kill
  };

  const dispatchRunHandoff = vi.fn().mockImplementation(async () => {
    if (overrides.runHandoffAsyncError) {
      throw overrides.runHandoffAsyncError;
    }
  });
  if (overrides.runHandoffSyncError) {
    dispatchRunHandoff.mockImplementation(() => {
      throw overrides.runHandoffSyncError;
    });
  }

  return {
    deps: {
      meridianApi,
      dispatchRunHandoff,
      writeFile(filePath, contents) {
        return fs.writeFile(filePath, contents, "utf8");
      },
      unlink(filePath) {
        return fs.unlink(filePath);
      },
      ...(overrides.onBackgroundRunError ? { onBackgroundRunError: overrides.onBackgroundRunError } : {})
    },
    spawn,
    kill,
    dispatchRunHandoff,
    planDirectory: directory,
    expectedCommandPath
  };
}

function buildConfig(
  planDirectory: string,
  systemPrompt: string,
  overrides: Partial<Pick<LaunchConfig, "agentType" | "modelId" | "mode" | "autoApprove">> = {}
): LaunchConfig {
  return {
    agentType: overrides.agentType ?? "codex",
    ...(overrides.modelId ? { modelId: overrides.modelId } : {}),
    mode: overrides.mode ?? "bridge",
    ...(overrides.autoApprove !== undefined ? { autoApprove: overrides.autoApprove } : {}),
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

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}
