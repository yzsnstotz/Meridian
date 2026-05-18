import { unlink as unlinkFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReplyChannel } from "../../types";
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
  /**
   * Dispatch plan paths of OTHER active agent-dispatcher roles. Used to refuse
   * a freshly-spawned `thread_id` that another role's lifecycle sidecar still
   * reserves on disk; without this guard two dispatcher sidecars can converge
   * on the same `codex_NN` after a Meridian Hub restart and silently share one
   * Hub session across two role lifecycles.
   */
  otherDispatchPlanPaths?: readonly string[];
  /**
   * Awaited synchronously after the spawn returns a thread_id but BEFORE the
   * dispatcher run handoff fires. Used by the orchestrator to persist the
   * DISPATCHER lifecycle entry so the codex CLI's first run-tool callback
   * can find it. See launcher.ts inline comment and
   * LaunchDispatcherDeps.onBeforeRunHandoff for the failure mode this
   * prevents.
   */
  onBeforeRunHandoff?: (request: DispatcherRunHandoffRequest) => Promise<void>;
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
  /**
   * Awaited synchronously between the spawn returning a thread_id and the
   * run-handoff firing. The orchestrator (agent-dispatcher.ts) uses this to
   * record the DISPATCHER lifecycle entry so the run-tool callback from the
   * freshly-started codex CLI doesn't race past lifecycle-store initialization
   * and fail with "Worker not found in lifecycle state: DISPATCHER". Observed
   * causing a respawn loop with 50+ launches per HTTP continue-dispatcher
   * burst when the Hub was slow enough that codex got its first tool call out
   * before sessionManager.initSession persisted (logs at 2026-05-16).
   */
  onBeforeRunHandoff?(request: DispatcherRunHandoffRequest): Promise<void>;
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
      threadId: error instanceof ThreadIdCollisionError ? error.threadId : EMPTY_THREAD_ID,
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
    // Persist the DISPATCHER lifecycle entry BEFORE firing the handoff so the
    // codex CLI's first run-tool callback can find it. Without this, a fast
    // Hub + slow Meridian-roles produces "Worker not found in lifecycle state:
    // DISPATCHER" → dispatcher dies → next caller respawns it.
    // Config-level callback wins over deps-level (the orchestrator-supplied
    // initSession needs to fire here; deps is for tests).
    const beforeHandoff = config.onBeforeRunHandoff ?? deps.onBeforeRunHandoff;
    if (beforeHandoff) {
      await beforeHandoff(handoffRequest);
    }
    const handoff = deps.dispatchRunHandoff(handoffRequest);
    detachedRunStarted = true;

    handoff.catch((error) => {
      const resolvedError = asError(error);
      if (deps.onBackgroundRunError) {
        deps.onBackgroundRunError(resolvedError, handoffRequest);
        return;
      }
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
  /service.unavailable/i
];
// HTTP-spawn timeouts are NOT retried even when the wrapper "Meridian API
// unreachable" message would otherwise match the transient list. The Hub may
// have completed the spawn server-side after our client aborted; a retry then
// allocates a NEW thread_id and leaves the first agentapi+codex pair orphaned
// (managed origin, no binding) — surfaces as a Processes-tab leak. Only the
// HTTP-spawn-timeout shape skips retry; ECONNREFUSED/ECONNRESET/etc. still
// retry safely because they prove the connection never produced a request.
const SPAWN_HTTP_TIMEOUT_PATTERN = /spawn request timed out after\s+\d+\s*ms|operation was aborted due to timeout/i;

interface DispatcherSpawnRetryGuards {
  isPersistedThreadIdReserved: (threadId: string) => boolean;
  isPersistedThreadIdLiveWorker?: (threadId: string) => boolean;
  /**
   * Returns true when the candidate thread_id is currently reserved by another
   * dispatcher role's lifecycle sidecar. Cross-plan collisions skip the
   * orphan-kill branch: the colliding id belongs to the *other* plan's live
   * resource, so killing it would terminate that plan's dispatcher/worker.
   */
  isThreadIdReservedAcrossOtherPlans?: (threadId: string) => boolean;
}

async function spawnWithRetry(
  meridianApi: MeridianApiClient,
  request: import("./meridian-api-client").MeridianSpawnRequest,
  guards: DispatcherSpawnRetryGuards | ((threadId: string) => boolean) = { isPersistedThreadIdReserved: () => false }
): Promise<string> {
  const resolvedGuards: DispatcherSpawnRetryGuards = typeof guards === "function"
    ? { isPersistedThreadIdReserved: guards }
    : guards;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= SPAWN_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await meridianApi.spawn(request);
      const reservedHere = resolvedGuards.isPersistedThreadIdReserved(result.threadId);
      const reservedCrossPlan = resolvedGuards.isThreadIdReservedAcrossOtherPlans?.(result.threadId) ?? false;
      if (reservedHere || reservedCrossPlan) {
        // Skip the orphan-kill when the colliding id is currently a live worker
        // thread on our own plan (killing terminates the live worker that the
        // lifecycle store still has in awaiting_validation/fix_requested/running)
        // OR when the id is reserved by ANOTHER dispatcher's lifecycle (killing
        // would terminate that plan's dispatcher/worker — the colliding agent is
        // theirs, not an orphan from our perspective).
        const collidesWithLiveWorker = resolvedGuards.isPersistedThreadIdLiveWorker?.(result.threadId) ?? false;
        const skipKill = collidesWithLiveWorker || reservedCrossPlan;
        if (!skipKill) {
          await killCollidedSpawnedThread(meridianApi, result.threadId, "dispatcher spawn");
        }
        lastError = createLifecycleThreadIdCollisionError(result.threadId);
        if (attempt < SPAWN_RETRY_DELAYS_MS.length) {
          console.warn("dispatcher spawn returned reserved lifecycle thread id, retrying", {
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
  if (SPAWN_HTTP_TIMEOUT_PATTERN.test(error.message)) {
    return false;
  }
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
