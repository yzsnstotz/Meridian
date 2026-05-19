import type { KillPolicy } from "../../types";
import { resolveRequiredDispatchRepoRoot } from "./dispatch-paths";
import {
  createMeridianApiClient,
  MeridianApiError,
  type MeridianApiClient
} from "./meridian-api-client";
import {
  ThreadIdCollisionError,
  createLifecycleThreadIdCollisionError,
  isLifecycleThreadIdLiveWorkerThread,
  isLifecycleThreadIdReserved,
  isThreadIdReservedAcrossOtherDispatchPlans,
  killCollidedSpawnedThread
} from "./thread-id-reservation";
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
  effort?: string;
  /**
   * Opaque credential identifier to forward onto /api/spawn so the Hub uses a
   * non-default credential set for this worker. Resolved by the caller via
   * {@link resolveCredentialForSpawn} so dispatcher → worker inheritance is
   * applied before reaching the launcher.
   */
  credentialId?: string;
  validationMaxFixCycles?: number;
  /**
   * Dispatch plan paths of OTHER active agent-dispatcher roles. Used to refuse
   * a freshly-spawned `thread_id` that another role's `dispatch_threads.json`
   * still reserves on disk. After a Meridian Hub restart wraps the allocator
   * back to low ids, a worker spawn from plan B can otherwise be handed plan
   * A's live worker thread (observed live: ranked-data-search-100k BATCH-3-GATE
   * and client-runtime-lifecycle-and-resource-fix W-09 both bound to codex_05
   * after PR #207 only fixed the dispatcher-level analogue).
   */
  otherDispatchPlanPaths?: readonly string[];
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
  validationMaxFixCycles?: number;
  /**
   * The exact `model_id` value sent to `/api/spawn`. Recording this lets the
   * dispatcher detail GUI display the same model the Hub is actually running,
   * so taskspec / dispatcher / Hub all agree.
   */
  appliedModelId?: string;
  /**
   * The exact `effort` (reasoning effort, a.k.a. thinking level) sent to
   * `/api/spawn`. Stored alongside `appliedModelId` for the same reason.
   */
  appliedReasoningEffort?: string;
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

const activeRunHandoffsByThreadId = new Map<string, DispatchRunHandoffRequest>();

export function resetActiveRunHandoffsForTest(): void {
  activeRunHandoffsByThreadId.clear();
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
      if (request.validationMaxFixCycles !== undefined) {
        params.validator_max_fix_cycles = String(request.validationMaxFixCycles);
      }
      if (request.appliedModelId) {
        params.applied_model_id = request.appliedModelId;
      }
      if (request.appliedReasoningEffort) {
        params.applied_reasoning_effort = request.appliedReasoningEffort;
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

  const parsedModel = parseModelIdWithEffort(config.modelId?.trim() || undefined);
  const explicitEffort = config.effort?.trim().toLowerCase();
  const resolvedEffort = explicitEffort ?? parsedModel.effort;

  let threadId: string;
  try {
    threadId = await spawnWithRetry(deps.meridianApi, {
      agentType: config.agentType,
      mode: config.mode,
      spawnDir,
      modelId: parsedModel.modelId,
      effort: resolvedEffort,
      autoApprove: config.autoApprove,
      ...(config.credentialId !== undefined ? { credentialId: config.credentialId } : {})
    }, {
      isPersistedThreadIdReserved: (candidateThreadId) =>
        isLifecycleThreadIdReserved(config.dispatchPlanPath, candidateThreadId),
      isPersistedThreadIdLiveWorker: (candidateThreadId) =>
        isLifecycleThreadIdLiveWorkerThread(config.dispatchPlanPath, candidateThreadId),
      isThreadIdReservedAcrossOtherPlans: (candidateThreadId) =>
        isThreadIdReservedAcrossOtherDispatchPlans(
          config.otherDispatchPlanPaths ?? [],
          candidateThreadId
        )
    });
  } catch (error) {
    return {
      ok: false,
      threadId: error instanceof ThreadIdCollisionError ? error.threadId : "",
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
    killPolicy: config.killPolicy,
    validationMaxFixCycles: config.validationMaxFixCycles,
    // Forward the *resolved* model id + reasoning effort that the Hub actually
    // received, so the dispatcher detail GUI shows the same values as the Hub
    // agent card. Passing the parsed pieces (model id without effort suffix +
    // effort separately) keeps display formatting consistent across surfaces.
    appliedModelId: parsedModel.modelId,
    appliedReasoningEffort: resolvedEffort
  };

  if (activeRunHandoffsByThreadId.has(threadId)) {
    return {
      ok: false,
      threadId,
      error: `spawn failed: Meridian returned active thread id ${threadId} for another in-flight worker`
    };
  }

  activeRunHandoffsByThreadId.set(threadId, handoffRequest);
  const handoff = Promise.resolve().then(() => deps.dispatchRunHandoff(handoffRequest));
  handoff.finally(() => {
    if (activeRunHandoffsByThreadId.get(threadId) === handoffRequest) {
      activeRunHandoffsByThreadId.delete(threadId);
    }
  }).catch((error) => {
    const resolvedError = asError(error);
    if (deps.onBackgroundRunError) {
      deps.onBackgroundRunError(resolvedError, handoffRequest);
      return;
    }
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
  /service.unavailable/i,
  // Hub IPC bridge transport drops (src/shared/ipc.ts) — same class of
  // transient as fetch failed; spawn is idempotent enough to retry safely.
  /\bIPC request completed without response body\b/i
];
// HTTP-spawn timeouts are NOT retried even when the wrapper "Meridian API
// unreachable" message would otherwise match the transient list. The Hub may
// have completed the spawn server-side after our client aborted; a retry then
// allocates a NEW thread_id and leaves the first agentapi+codex pair orphaned
// (managed origin, no binding) — surfaces as a Processes-tab leak. Only
// HTTP-spawn-timeout shapes skip retry; ECONNREFUSED/ECONNRESET/etc. still
// retry because they prove the connection never produced a request.
const SPAWN_HTTP_TIMEOUT_PATTERN = /spawn request timed out after\s+\d+\s*ms|operation was aborted due to timeout|\bIPC request timed out\b/i;

interface SpawnRetryGuards {
  isPersistedThreadIdReserved: (threadId: string) => boolean;
  isPersistedThreadIdLiveWorker?: (threadId: string) => boolean;
  /**
   * Returns true when the candidate thread_id is currently reserved by another
   * dispatcher role's lifecycle sidecar. Cross-plan collisions skip the
   * orphan-kill branch: the colliding id is the *other* plan's live resource,
   * so killing it would terminate that plan's worker/validator/dispatcher.
   */
  isThreadIdReservedAcrossOtherPlans?: (threadId: string) => boolean;
}

async function spawnWithRetry(
  meridianApi: MeridianApiClient,
  request: import("./meridian-api-client").MeridianSpawnRequest,
  guards: SpawnRetryGuards | ((threadId: string) => boolean) = { isPersistedThreadIdReserved: () => false }
): Promise<string> {
  const resolvedGuards: SpawnRetryGuards = typeof guards === "function"
    ? { isPersistedThreadIdReserved: guards }
    : guards;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= SPAWN_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await meridianApi.spawn(request);
      if (activeRunHandoffsByThreadId.has(result.threadId)) {
        lastError = new ThreadIdCollisionError(
          result.threadId,
          formatActiveThreadCollisionError(result.threadId)
        );
        if (attempt < SPAWN_RETRY_DELAYS_MS.length) {
          console.warn("worker spawn returned active thread id, retrying", {
            attempt: attempt + 1,
            threadId: result.threadId,
            error: lastError.message
          });
          continue;
        }
        throw lastError;
      }
      const reservedHere = resolvedGuards.isPersistedThreadIdReserved(result.threadId);
      const reservedCrossPlan = resolvedGuards.isThreadIdReservedAcrossOtherPlans?.(result.threadId) ?? false;
      if (reservedHere || reservedCrossPlan) {
        // Skip the orphan-kill when the colliding id is a live worker thread on
        // our own plan (PR #175 — killing terminates the live worker mid-flight)
        // OR when the id is reserved by ANOTHER plan's lifecycle (the colliding
        // agent is the other plan's live worker/validator/dispatcher, not an
        // orphan from our perspective — observed: BATCH-3-GATE in plan B and
        // W-09 in plan A both bound to codex_05 after the Hub allocator wrapped
        // post-restart, see learnings/dispatcher/cross-plan-dispatcher-thread-id-reservation-gap.md).
        const collidesWithLiveWorker = resolvedGuards.isPersistedThreadIdLiveWorker?.(result.threadId) ?? false;
        const skipKill = collidesWithLiveWorker || reservedCrossPlan;
        if (!skipKill) {
          await killCollidedSpawnedThread(meridianApi, result.threadId, "worker spawn");
        }
        lastError = createLifecycleThreadIdCollisionError(result.threadId);
        if (attempt < SPAWN_RETRY_DELAYS_MS.length) {
          console.warn("worker spawn returned reserved lifecycle thread id, retrying", {
            attempt: attempt + 1,
            threadId: result.threadId,
            skippedKill: skipKill,
            crossPlan: reservedCrossPlan,
            error: lastError.message
          });
          continue;
        }
        throw lastError;
      }
      return result.threadId;
    } catch (error) {
      lastError = asError(error);
      if (attempt < SPAWN_RETRY_DELAYS_MS.length && isSpawnTransientError(lastError)) {
        const delayMs = SPAWN_RETRY_DELAYS_MS[attempt]!;
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

function formatActiveThreadCollisionError(threadId: string): string {
  return `spawn failed: Meridian returned active thread id ${threadId} for another in-flight worker`;
}

function isSpawnTransientError(error: Error): boolean {
  if (SPAWN_HTTP_TIMEOUT_PATTERN.test(error.message)) {
    return false;
  }
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
  const message = asError(error).message;
  return message.startsWith("spawn failed:")
    ? message
    : `spawn failed: ${message}`;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
