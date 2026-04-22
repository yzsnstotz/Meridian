import type { KillPolicy } from "../../types";
import { resolveRequiredDispatchRepoRoot } from "./dispatch-paths";
import {
  createMeridianApiClient,
  MeridianApiError,
  type MeridianApiClient
} from "./meridian-api-client";
import runTool from "../../tool-gateway/tools/run";
import { parseModelIdWithEffort } from "../../tool-gateway/tools/spawn";

export interface LaunchDispatchWorkerConfig {
  agentType: string;
  mode: "bridge" | "pane_bridge";
  killPolicy?: KillPolicy;
  autoApprove?: boolean;
  commandFilePath: string;
  dispatchPlanPath: string;
  dispatchRepoRoot: string;
  workerId: string;
  modelId?: string;
}

export interface LaunchDispatchWorkerResult {
  ok: boolean;
  threadId: string;
  error?: string;
}

export interface DispatchRunHandoffRequest {
  threadId: string;
  commandFilePath: string;
  workerId: string;
  killPolicy?: KillPolicy;
}

export interface LaunchDispatchWorkerDeps {
  /** Meridian HTTP client. The launcher only submits spawn requests through this boundary. */
  meridianApi: MeridianApiClient;
  /**
   * Fire-and-forget worker run handoff. Meridian owns the actual transport; this helper only
   * decides *what* to run (command file + worker id) and hands the result lifecycle back to
   * Meridian-roles's local reconciler. Default implementation calls the in-process
   * tool-gateway `run` tool instead of spawning a `meridian-tool run` subprocess.
   */
  dispatchRunHandoff(request: DispatchRunHandoffRequest): Promise<void>;
  /**
   * Called when dispatchRunHandoff rejects asynchronously. Defaults to console.warn so
   * background run failures are surfaced without crashing the launcher's caller.
   */
  onBackgroundRunError?(error: Error, request: DispatchRunHandoffRequest): void;
}

export function createDefaultLaunchDispatchWorkerDeps(): LaunchDispatchWorkerDeps {
  const meridianApi = createMeridianApiClient();
  return {
    meridianApi,
    async dispatchRunHandoff(request) {
      const params: Record<string, string> = {
        thread_id: request.threadId,
        command: request.commandFilePath,
        worker: request.workerId
      };
      if (request.killPolicy) {
        params.kill_policy = request.killPolicy;
      }

      const result = await runTool.execute(params);
      if (!result.ok) {
        throw new Error(result.error ?? "dispatch run handoff failed");
      }
    }
  };
}

export async function launchDispatchWorker(
  config: LaunchDispatchWorkerConfig,
  deps: LaunchDispatchWorkerDeps = createDefaultLaunchDispatchWorkerDeps()
): Promise<LaunchDispatchWorkerResult> {
  let spawnDir: string;
  try {
    spawnDir = resolveSpawnDir(config);
  } catch (error) {
    return {
      ok: false,
      threadId: "",
      error: `spawn failed: ${asError(error).message}`
    };
  }

  let threadId: string;
  try {
    const { modelId: parsedModelId, effort: parsedEffort } = parseModelIdWithEffort(config.modelId?.trim() || undefined);
    threadId = await spawnWithRetry(deps.meridianApi, {
      agentType: config.agentType,
      mode: config.mode,
      spawnDir,
      modelId: parsedModelId,
      effort: parsedEffort,
      autoApprove: config.autoApprove
    });
  } catch (error) {
    return {
      ok: false,
      threadId: "",
      error: formatSpawnError(error)
    };
  }

  // Hand off to the in-process run. This is fire-and-forget so the launcher can
  // return the spawned thread id promptly — Meridian owns the actual run transport
  // from here, and the background run updates the lifecycle store when it completes.
  const handoffRequest: DispatchRunHandoffRequest = {
    threadId,
    commandFilePath: config.commandFilePath,
    workerId: config.workerId,
    killPolicy: config.killPolicy
  };
  const handoff = deps.dispatchRunHandoff(handoffRequest);
  handoff.catch((error) => {
    const resolvedError = asError(error);
    if (deps.onBackgroundRunError) {
      deps.onBackgroundRunError(resolvedError, handoffRequest);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("dispatch worker background run failed", {
      workerId: handoffRequest.workerId,
      threadId: handoffRequest.threadId,
      error: resolvedError.message
    });
  });

  return {
    ok: true,
    threadId
  };
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
        console.warn("worker spawn transient error, retrying", {
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

function resolveSpawnDir(config: LaunchDispatchWorkerConfig): string {
  return config.dispatchRepoRoot?.trim()
    || resolveRequiredDispatchRepoRoot([config.dispatchPlanPath, config.commandFilePath]);
}

function formatSpawnError(error: unknown): string {
  if (error instanceof MeridianApiError) {
    // The client already prefixes "spawn failed: ..." for well-formed error payloads.
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
