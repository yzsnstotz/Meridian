import path from "node:path";

import type {
  DispatchThreadStateV2,
  LifecycleStatus,
  PmResolverLifecycleStatus
} from "../../types";
import { LifecycleStore } from "./lifecycle-store";
import type { MeridianApiClient } from "./meridian-api-client";

// A lifecycle status reserves its associated Meridian thread_id only while the
// underlying agent is plausibly still alive in the hub. Terminal statuses
// (completed, failed, abandoned, skipped) leave only an audit record in
// dispatch_threads.json — their thread_ids are free for Meridian's allocator
// to recycle. Pending workers haven't spawned yet, so any persisted thread_id
// at that status is stale or test-fixture data and must not block new spawns.
const ACTIVE_THREAD_RESERVATION_STATUSES: ReadonlySet<LifecycleStatus> = new Set([
  "running",
  "blocked",
  "awaiting_validation",
  "fix_requested"
]);

export function isActiveThreadReservationStatus(status: LifecycleStatus): boolean {
  return ACTIVE_THREAD_RESERVATION_STATUSES.has(status);
}

// PM resolver lifecycle has a smaller status enum (running | completed |
// failed). Only `running` keeps the underlying codex thread plausibly alive
// in the hub; the terminal statuses leave audit records whose thread_ids are
// free for the Hub allocator to recycle.
const ACTIVE_PM_RESOLVER_RESERVATION_STATUSES: ReadonlySet<PmResolverLifecycleStatus> = new Set([
  "running"
]);

export function isActivePmResolverReservationStatus(status: PmResolverLifecycleStatus): boolean {
  return ACTIVE_PM_RESOLVER_RESERVATION_STATUSES.has(status);
}

export class ThreadIdCollisionError extends Error {
  constructor(readonly threadId: string, message: string) {
    super(message);
    this.name = "ThreadIdCollisionError";
  }
}

export function createLifecycleThreadIdCollisionError(threadId: string): ThreadIdCollisionError {
  return new ThreadIdCollisionError(
    threadId,
    `spawn failed: Meridian returned reserved thread id ${threadId} already recorded in lifecycle state`
  );
}

export function isLifecycleThreadIdReserved(dispatchPlanPath: string, candidateThreadId: string): boolean {
  const normalizedCandidate = candidateThreadId.trim();
  if (!normalizedCandidate) {
    return false;
  }

  const lifecycleStore = new LifecycleStore(
    path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json"),
    { dispatchPlanPath }
  );

  return isThreadIdReservedInLifecycleState(lifecycleStore.load(), normalizedCandidate);
}

export function isLifecycleThreadIdKnown(dispatchPlanPath: string, candidateThreadId: string): boolean {
  const normalizedCandidate = candidateThreadId.trim();
  if (!normalizedCandidate) {
    return false;
  }

  const lifecycleStore = new LifecycleStore(
    path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json"),
    { dispatchPlanPath }
  );

  return isThreadIdKnownInLifecycleState(lifecycleStore.load(), normalizedCandidate);
}

export function isThreadIdReservedInLifecycleState(
  state: DispatchThreadStateV2,
  candidateThreadId: string
): boolean {
  const normalizedCandidate = candidateThreadId.trim();
  if (!normalizedCandidate) {
    return false;
  }

  if (
    state.dispatcher.thread_id === normalizedCandidate
    && isActiveThreadReservationStatus(state.dispatcher.status)
  ) {
    return true;
  }

  const workerOrValidatorReserved = Object.values(state.workers).some((worker) => {
    if (!isActiveThreadReservationStatus(worker.status)) {
      return false;
    }
    return worker.thread_id === normalizedCandidate
      || worker.validation?.validator_thread_id === normalizedCandidate;
  });
  if (workerOrValidatorReserved) {
    return true;
  }

  // PM resolver threads also occupy a Hub slot while running; without this
  // check, a stale `running` PM resolver in another plan can be silently
  // re-handed to a fresh PM/worker/validator/dispatcher spawn whose prompt
  // then lands on the stale agent's session (root cause of the
  // agent-dispatcher-8eb13a31 BATCH-3-GATE → codex_19 N-02-validator-bleed
  // incident on 2026-05-14: codex_19 was reserved as a `running` PM resolver
  // in `promotion-job/branch/hgd-growth-v1` since 2026-05-06, the Hub
  // allocator wrapped, and the BATCH-3-GATE PM prompt landed on it).
  return (state.pm_resolvers ?? []).some((entry) => (
    entry.thread_id === normalizedCandidate
    && isActivePmResolverReservationStatus(entry.status)
  ));
}

/**
 * Returns true when the candidate thread id matches a *live* worker thread
 * (`worker.thread_id` of an actively-reserved worker), as distinct from a
 * validator thread or dispatcher thread.
 *
 * Used by spawn-collision retry paths to decide whether `killCollidedSpawnedThread`
 * is safe. PR #134 introduced kill-on-collision to clear orphaned freshly-spawned
 * agents whose ids matched stale active reservations. But when the colliding id
 * is the *current* live worker thread we are about to validate or feed back into,
 * the kill terminates the worker agent itself (observed in the Hub UI as "the
 * worker had been killed before validator approval"). In that case we must skip
 * the kill and just retry the spawn — preferring an orphan leak over taking out
 * the worker.
 */
export function isLifecycleThreadIdLiveWorkerThread(
  dispatchPlanPath: string,
  candidateThreadId: string
): boolean {
  const normalizedCandidate = candidateThreadId.trim();
  if (!normalizedCandidate) {
    return false;
  }

  const lifecycleStore = new LifecycleStore(
    path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json"),
    { dispatchPlanPath }
  );
  const state = lifecycleStore.load();
  return Object.values(state.workers).some((worker) => {
    if (!isActiveThreadReservationStatus(worker.status)) {
      return false;
    }
    return worker.thread_id === normalizedCandidate;
  });
}

/**
 * Returns true when the candidate thread_id is currently reserved by a
 * *different* dispatch plan's lifecycle sidecar. The Meridian Hub allocator
 * is service-wide, not per-plan: after a Hub restart it wraps back to low
 * ids and can hand `codex_NN` to a fresh dispatcher spawn even though another
 * active plan still pins that id on disk. Without this guard the two plans'
 * `dispatch_threads.json` files converge on the same id and silently share a
 * single Hub dispatcher session across two role lifecycles (kill on settle
 * from one plan terminates the other; talk-box context injection interleaves
 * transcripts).
 *
 * Callers pass the dispatch_plan_paths of *other* dispatcher roles (their
 * own path must be excluded by the caller). Unreadable sidecars are skipped
 * — a missing/stale plan cannot block our spawn.
 */
export function isThreadIdReservedAcrossOtherDispatchPlans(
  otherDispatchPlanPaths: readonly string[],
  candidateThreadId: string
): boolean {
  const normalizedCandidate = candidateThreadId.trim();
  if (!normalizedCandidate) {
    return false;
  }

  for (const dispatchPlanPath of otherDispatchPlanPaths) {
    if (!dispatchPlanPath?.trim()) {
      continue;
    }
    try {
      const store = new LifecycleStore(
        path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json"),
        { dispatchPlanPath }
      );
      if (isThreadIdReservedInLifecycleState(store.load(), normalizedCandidate)) {
        return true;
      }
    } catch {
      // Unreadable cross-plan sidecar — cannot block our spawn.
    }
  }
  return false;
}

export function isThreadIdKnownInLifecycleState(
  state: DispatchThreadStateV2,
  candidateThreadId: string
): boolean {
  const normalizedCandidate = candidateThreadId.trim();
  if (!normalizedCandidate) {
    return false;
  }

  if (state.dispatcher.thread_id === normalizedCandidate) {
    return true;
  }

  return Object.values(state.workers).some((worker) => {
    if (worker.thread_id === normalizedCandidate || worker.validation?.validator_thread_id === normalizedCandidate) {
      return true;
    }

    return worker.validation?.history?.some((entry) => entry.validator_thread_id === normalizedCandidate) ?? false;
  });
}

// When Meridian's spawn endpoint hands back a thread_id that is already recorded as reserved
// in lifecycle state, the agent it just created is an orphan from our perspective — we will
// retry the spawn to land on a fresh id. Without killing, the orphan stays alive in the Hub
// and leaks, since the launcher's only handle to it is the rejected thread_id. Failures are
// swallowed so a kill error never aborts the retry path.
export async function killCollidedSpawnedThread(
  meridianApi: MeridianApiClient,
  threadId: string,
  context: string
): Promise<void> {
  const trimmed = threadId?.trim();
  if (!trimmed) {
    return;
  }
  try {
    await meridianApi.kill(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${context} kill-on-collision failed`, {
      thread_id: trimmed,
      error: message
    });
  }
}
