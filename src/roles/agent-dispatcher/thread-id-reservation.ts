import path from "node:path";

import type { DispatchThreadStateV2, LifecycleStatus } from "../../types";
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

  return Object.values(state.workers).some((worker) => {
    if (!isActiveThreadReservationStatus(worker.status)) {
      return false;
    }
    return worker.thread_id === normalizedCandidate
      || worker.validation?.validator_thread_id === normalizedCandidate;
  });
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
