import { execFile as nodeExecFile, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

import { resolveRequiredDispatchRepoRoot } from "./dispatch-paths";
import { extractSpawnCliError, parseSpawnCliOutput } from "./meridian-tool-output";
import { buildMeridianToolArgs, MERIDIAN_TOOL_EXECUTABLE } from "./tool-entrypoint";

export interface LaunchDispatchWorkerConfig {
  agentType: string;
  mode: string;
  commandFilePath: string;
  dispatchPlanPath: string;
  workerId: string;
  modelId?: string;
}

export interface LaunchDispatchWorkerResult {
  ok: boolean;
  threadId: string;
  error?: string;
}

export interface LaunchDispatchWorkerDeps {
  execFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  spawn(command: string, args: string[], options: SpawnOptions): {
    unref(): void;
  };
}

const defaultDeps: LaunchDispatchWorkerDeps = {
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
  }
};

export async function launchDispatchWorker(
  config: LaunchDispatchWorkerConfig,
  deps: LaunchDispatchWorkerDeps = defaultDeps
): Promise<LaunchDispatchWorkerResult> {
  let spawnArgs: string[];
  try {
    spawnArgs = buildSpawnArgs(config);
  } catch (error) {
    return {
      ok: false,
      threadId: "",
      error: `spawn failed: ${asError(error).message}`
    };
  }

  let spawnStdout: string;
  try {
    ({ stdout: spawnStdout } = await deps.execFile(MERIDIAN_TOOL_EXECUTABLE, spawnArgs));
  } catch (error) {
    return {
      ok: false,
      threadId: "",
      error: `spawn failed: ${extractSpawnCliError(error) ?? asError(error).message}`
    };
  }

  const parsedSpawn = parseSpawnCliOutput(spawnStdout);
  if (parsedSpawn.error) {
    return {
      ok: false,
      threadId: "",
      error: `spawn failed: ${parsedSpawn.error}`
    };
  }

  if (!parsedSpawn.threadId) {
    return {
      ok: false,
      threadId: "",
      error: "Failed to parse spawn response"
    };
  }

  try {
    const runProcess = deps.spawn(MERIDIAN_TOOL_EXECUTABLE, buildRunArgs(parsedSpawn.threadId, config), {
      detached: true,
      stdio: "ignore"
    });
    runProcess.unref();

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
  }
}

function buildSpawnArgs(config: LaunchDispatchWorkerConfig): string[] {
  const args = [
    "spawn",
    "--agent-type",
    config.agentType,
    "--spawn-dir",
    resolveRequiredDispatchRepoRoot([config.dispatchPlanPath, config.commandFilePath]),
    "--mode",
    config.mode
  ];

  if (config.modelId?.trim()) {
    args.push("--model-id", config.modelId.trim());
  }

  return buildMeridianToolArgs(args);
}

function buildRunArgs(threadId: string, config: LaunchDispatchWorkerConfig): string[] {
  return buildMeridianToolArgs([
    "run",
    "--thread-id",
    threadId,
    "--command",
    config.commandFilePath,
    "--worker",
    config.workerId
  ]);
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
