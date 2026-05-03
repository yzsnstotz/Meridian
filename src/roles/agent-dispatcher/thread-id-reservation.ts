import path from "node:path";

import type { DispatchThreadStateV2 } from "../../types";
import { LifecycleStore } from "./lifecycle-store";
import type { MeridianApiClient } from "./meridian-api-client";

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

export function isThreadIdReservedInLifecycleState(
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
    return worker.thread_id === normalizedCandidate
      || worker.validation?.validator_thread_id === normalizedCandidate;
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
