import { unlink as unlinkFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReplyChannel } from "../../types";
import { resolveRequiredDispatchRepoRoot } from "./dispatch-paths";
import {
  createMeridianApiClient,
  MeridianApiError,
  type MeridianApiClient
} from "./meridian-api-client";
import runTool from "../../tool-gateway/tools/run";

const DISPATCHER_WORKER_ID = "DISPATCHER";
const EMPTY_THREAD_ID = "";

export interface LaunchConfig {
  agentType: string;
  modelId?: string;
  mode: "bridge" | "pane_bridge";
  autoApprove?: boolean;
  systemPrompt: string;
  dispatchRepoRoot: string;
  /** Absolute path to dispatch_plan.md (directory is used for the Hub prompt file). */
  dispatchPlanPath: string;
  commandFilePath: string;
  /** Meridian-roles role thread_id; used for a stable on-disk prompt filename next to the plan. */
  dispatcherRoleId: string;
  userReplyChannel: ReplyChannel;
}

export interface LaunchResult {
  ok: boolean;
  threadId: string;
  error?: string;
}

export interface DispatcherRunHandoffRequest {
  threadId: string;
  commandFilePath: string;
  /** Always DISPATCHER for the dispatcher role; exposed for tests and symmetry with worker-launcher. */
  workerId: string;
}

export interface LaunchDispatcherDeps {
  meridianApi: MeridianApiClient;
  /**
   * Fire-and-forget dispatcher run handoff. Default implementation invokes the in-process
   * tool-gateway `run` tool so Meridian-roles no longer shells out to `meridian-tool run`.
   */
  dispatchRunHandoff(request: DispatcherRunHandoffRequest): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  /** Override for tests; production uses the path next to dispatch_plan.md. */
  resolveDispatcherCommandPath?: (config: LaunchConfig) => string;
  onBackgroundRunError?(error: Error, request: DispatcherRunHandoffRequest): void;
}

export function createDefaultLaunchDispatcherDeps(): LaunchDispatcherDeps {
  const meridianApi = createMeridianApiClient();
  return {
    meridianApi,
    async dispatchRunHandoff(request) {
      const result = await runTool.execute({
        thread_id: request.threadId,
        command: request.commandFilePath,
        worker: request.workerId
      });
      if (!result.ok) {
        throw new Error(result.error ?? "dispatcher run handoff failed");
      }
    },
    writeFile(filePath, contents) {
      return writeFile(filePath, contents, "utf8");
    },
    unlink(filePath) {
      return unlinkFile(filePath);
    }
  };
}

export async function launchDispatcher(
  config: LaunchConfig,
  deps: LaunchDispatcherDeps = createDefaultLaunchDispatcherDeps()
): Promise<LaunchResult> {
  let spawnDir: string;
  try {
    spawnDir = resolveSpawnDir(config);
  } catch (error) {
    return {
      ok: false,
      threadId: EMPTY_THREAD_ID,
      error: `spawn failed: ${asError(error).message}`
    };
  }

  let threadId: string;
  try {
    threadId = await spawnWithRetry(deps.meridianApi, {
      agentType: config.agentType,
      mode: config.mode,
      spawnDir,
      modelId: config.modelId?.trim() || undefined,
      autoApprove: config.autoApprove
    });
  } catch (error) {
    return {
      ok: false,
      threadId: EMPTY_THREAD_ID,
      error: formatSpawnError(error)
    };
  }

  let commandPath: string | null = null;
  let detachedRunStarted = false;

  try {
    commandPath =
      deps.resolveDispatcherCommandPath?.(config)
      ?? dispatcherHubSystemPromptPath(config.dispatchPlanPath, config.dispatcherRoleId);
    await deps.writeFile(commandPath, config.systemPrompt);

    const handoffRequest: DispatcherRunHandoffRequest = {
      threadId,
      commandFilePath: commandPath,
      workerId: DISPATCHER_WORKER_ID
    };
    const handoff = deps.dispatchRunHandoff(handoffRequest);
    detachedRunStarted = true;

    handoff.catch((error) => {
      const resolvedError = asError(error);
      if (deps.onBackgroundRunError) {
        deps.onBackgroundRunError(resolvedError, handoffRequest);
        return;
      }
      // eslint-disable-next-line no-console
      console.warn("dispatcher background run failed", {
        threadId: handoffRequest.threadId,
        error: resolvedError.message
      });
    });

    return {
      ok: true,
      threadId
    };
  } catch (error) {
    return {
      ok: false,
      threadId,
      error: `run launch failed: ${asError(error).message}`
    };
  } finally {
    if (commandPath && !detachedRunStarted) {
      await deps.unlink(commandPath).catch(() => undefined);
    }
  }
}

/**
 * Hub `run --command` must live in the same directory as `dispatch_plan.md` so the run
 * resolver (see tool-gateway/tools/run.ts) can locate `dispatch_threads.json` and the plan
 * from `path.dirname(command)`.
 */
export function dispatcherHubSystemPromptPath(dispatchPlanPath: string, dispatcherRoleId: string): string {
  const planDir = path.dirname(path.resolve(dispatchPlanPath));
  const safeId = sanitizeDispatcherRoleIdSegment(dispatcherRoleId);
  return path.join(planDir, `.meridian-roles-dispatcher-prompt-${safeId}.md`);
}

function sanitizeDispatcherRoleIdSegment(roleId: string): string {
  const trimmed = roleId.trim();
  const slug = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug.slice(0, 120) : "dispatcher";
}

const SPAWN_RETRY_DELAYS_MS = [3_000, 8_000];
const SPAWN_TRANSIENT_PATTERNS = [
  /\bfetch failed\b/i,
  /\bunreachable\b/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /timed?\s*out/i,
  /service.unavailable/i
];

async function spawnWithRetry(
  meridianApi: MeridianApiClient,
  request: import("./meridian-api-client").MeridianSpawnRequest
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= SPAWN_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await meridianApi.spawn(request);
      return result.threadId;
    } catch (error) {
      lastError = asError(error);
      if (attempt < SPAWN_RETRY_DELAYS_MS.length && isSpawnTransientError(lastError)) {
        const delayMs = SPAWN_RETRY_DELAYS_MS[attempt]!;
        // eslint-disable-next-line no-console
        console.warn("dispatcher spawn transient error, retrying", {
          attempt: attempt + 1,
          delayMs,
          error: lastError.message
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError!;
}

function isSpawnTransientError(error: Error): boolean {
  return SPAWN_TRANSIENT_PATTERNS.some((pattern) => pattern.test(error.message));
}

function resolveSpawnDir(config: LaunchConfig): string {
  return config.dispatchRepoRoot?.trim()
    || resolveRequiredDispatchRepoRoot([config.dispatchPlanPath, config.commandFilePath]);
}

function formatSpawnError(error: unknown): string {
  if (error instanceof MeridianApiError) {
    return error.message.startsWith("spawn failed:")
      ? error.message
      : `spawn failed: ${error.message}`;
  }
  return `spawn failed: ${asError(error).message}`;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
