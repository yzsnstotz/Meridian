import { execFile as nodeExecFile, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink as unlinkFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReplyChannel } from "../../types";

const CLEANUP_DELAY_MS = 5_000;
const DISPATCHER_WORKER_ID = "DISPATCHER";
const MERIDIAN_TOOL_ENTRYPOINT = "src/bin/meridian-tool.ts";
const EMPTY_THREAD_ID = "";

export interface LaunchConfig {
  agentType: string;
  mode: string;
  systemPrompt: string;
  dispatchPlanPath: string;
  commandFilePath: string;
  userReplyChannel: ReplyChannel;
}

export interface LaunchResult {
  ok: boolean;
  threadId: string;
  error?: string;
}

export interface LaunchDispatcherDeps {
  execFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  spawn(command: string, args: string[], options: SpawnOptions): {
    unref(): void;
  };
  writeFile(filePath: string, contents: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  createCommandFilePath(): string;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): {
    unref?: () => void;
  };
  cleanupDelayMs: number;
}

const defaultDeps: LaunchDispatcherDeps = {
  execFile(command, args) {
    return new Promise((resolve, reject) => {
      nodeExecFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  },
  spawn(command, args, options) {
    return nodeSpawn(command, args, options);
  },
  writeFile(filePath, contents) {
    return writeFile(filePath, contents, "utf8");
  },
  unlink(filePath) {
    return unlinkFile(filePath);
  },
  createCommandFilePath() {
    return path.join(tmpdir(), `dispatcher_cmd_${randomUUID()}.md`);
  },
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cleanupDelayMs: CLEANUP_DELAY_MS
};

export async function launchDispatcher(
  config: LaunchConfig,
  deps: LaunchDispatcherDeps = defaultDeps
): Promise<LaunchResult> {
  const spawnArgs = buildSpawnArgs(config);

  let spawnStdout: string;
  try {
    ({ stdout: spawnStdout } = await deps.execFile("npx", spawnArgs));
  } catch (error) {
    return {
      ok: false,
      threadId: EMPTY_THREAD_ID,
      error: `spawn failed: ${asError(error).message}`
    };
  }

  const parsedSpawn = parseSpawnResponse(spawnStdout);
  if (parsedSpawn.error) {
    return {
      ok: false,
      threadId: EMPTY_THREAD_ID,
      error: `spawn failed: ${parsedSpawn.error}`
    };
  }

  if (!parsedSpawn.threadId) {
    return {
      ok: false,
      threadId: EMPTY_THREAD_ID,
      error: "Failed to parse spawn response"
    };
  }

  let commandPath: string | null = null;
  let runLaunched = false;

  try {
    commandPath = deps.createCommandFilePath();
    await deps.writeFile(commandPath, config.systemPrompt);

    const runProcess = deps.spawn("npx", buildRunArgs(parsedSpawn.threadId, commandPath), {
      detached: true,
      stdio: "ignore"
    });
    runProcess.unref();
    runLaunched = true;

    return {
      ok: true,
      threadId: parsedSpawn.threadId
    };
  } catch (error) {
    return {
      ok: false,
      threadId: parsedSpawn.threadId,
      error: `run launch failed: ${asError(error).message}`
    };
  } finally {
    if (!commandPath) {
      // No temp file was created, so there is nothing to clean up.
    } else if (runLaunched) {
      scheduleCleanup(commandPath, deps);
    } else {
      await deps.unlink(commandPath).catch(() => undefined);
    }
  }
}

function buildSpawnArgs(config: LaunchConfig): string[] {
  return [
    "tsx",
    MERIDIAN_TOOL_ENTRYPOINT,
    "spawn",
    "--agent-type",
    config.agentType,
    "--mode",
    config.mode
  ];
}

function buildRunArgs(threadId: string, commandPath: string): string[] {
  return [
    "tsx",
    MERIDIAN_TOOL_ENTRYPOINT,
    "run",
    "--thread-id",
    threadId,
    "--command",
    commandPath,
    "--worker",
    DISPATCHER_WORKER_ID
  ];
}

function parseSpawnResponse(stdout: string): { threadId: string | null; error: string | null } {
  try {
    const parsed = JSON.parse(stdout) as {
      ok?: unknown;
      error?: unknown;
      data?: {
        thread_id?: unknown;
      };
      thread_id?: unknown;
    };

    if (parsed.ok === false && typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return {
        threadId: null,
        error: parsed.error.trim()
      };
    }

    const candidate = typeof parsed.data?.thread_id === "string"
      ? parsed.data.thread_id
      : typeof parsed.thread_id === "string"
        ? parsed.thread_id
        : null;

    return {
      threadId: candidate?.trim() ? candidate.trim() : null,
      error: null
    };
  } catch {
    return {
      threadId: null,
      error: null
    };
  }
}

function scheduleCleanup(commandPath: string, deps: LaunchDispatcherDeps): void {
  const timer = deps.setTimeout(async () => {
    await deps.unlink(commandPath).catch(() => undefined);
  }, deps.cleanupDelayMs);

  timer.unref?.();
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
