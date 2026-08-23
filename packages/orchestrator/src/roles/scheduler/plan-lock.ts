import { SchedulerStateStore } from "./scheduler-state-store";

export interface PlanLockResult {
  acquired: boolean;
  held_by?: string;
}

export function acquirePlanLock(
  stateStore: SchedulerStateStore,
  ownerThreadId: string,
  runId: string
): PlanLockResult {
  const state = stateStore.load();

  if (state.plan_lock_owner && state.plan_lock_owner !== ownerThreadId) {
    return { acquired: false, held_by: state.plan_lock_owner };
  }

  state.plan_lock_owner = ownerThreadId;
  state.current_run_id = runId;
  stateStore.save(state);
  return { acquired: true };
}

export function releasePlanLock(
  stateStore: SchedulerStateStore,
  ownerThreadId: string
): void {
  const state = stateStore.load();

  if (state.plan_lock_owner === ownerThreadId) {
    state.plan_lock_owner = null;
    stateStore.save(state);
  }
}

export function isPlanLocked(stateStore: SchedulerStateStore): boolean {
  return stateStore.load().plan_lock_owner !== null;
}
