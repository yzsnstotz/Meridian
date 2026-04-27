import path from "node:path";

import type { DispatchThreadStateV2 } from "../../types";
import { LifecycleStore } from "./lifecycle-store";

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
