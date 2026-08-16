import type { DispatchThreadStateV2, LifecycleStatus } from "../../types";
import { isPmResolverNoProgressStale } from "./lifecycle-store";

const DISPATCHER_WORKER_ID = "DISPATCHER";

/**
 * Lifecycle statuses that hold one of `parallel_dispatch.max_concurrency`
 * slots. This is CAPACITY accounting — "how many of the configured lanes are
 * already taken" — and it is deliberately NOT the same question as "is a
 * worker alive and making progress", which stays `status === "running"` (see
 * `resolveBlockingRunningWorkers` in watchdog.ts).
 *
 * Why each one is here:
 *
 *   - `running` — the obvious case: a live worker agent on a Hub thread.
 *
 *   - `awaiting_validation` — the row itself is parked, but a VALIDATOR agent
 *     is scoring it on its own Hub thread. That thread is recorded as
 *     `worker.validation.validator_thread_id` and is already treated as a live
 *     reservation by `isThreadIdReservedInLifecycleState` (spawn-collision) and
 *     by `collectCleanupBlockingThreadIds` (terminal-thread cleanup). Counting
 *     it as zero here is what let the sweep launch into a lane the validator
 *     was standing in.
 *
 *   - `fix_requested` — a reserved slot, not an idle one. The row auto-
 *     transitions straight back to `running` the moment validator feedback
 *     lands (validator-orchestrator.ts `setWorkerStatus(workerId, "running",
 *     "validator_feedback_delivered")`), and that delivery is server-driven on
 *     the very next continueDispatcher tick. Observed live: a row went
 *     fix_requested → running inside the same second. A slot that will be
 *     re-occupied before the next sweep is not a free slot.
 *
 * Deliberately EXCLUDED:
 *
 *   - `blocked` — a blocked worker does keep its codex process alive (see
 *     process-handlers.ts, which keeps `blocked` off the reap list), so on a
 *     pure "Hub threads alive" reading it occupies something. It is excluded
 *     anyway because a blocked row can sit wedged for hours awaiting a PM
 *     resolver or an operator, and burning a permanent slot on it would undo
 *     the deferral fix that stopped a SINGLE wedged row from freezing every
 *     unrelated row in the plan (`deferredManualInterventionResult` in
 *     role-handlers.ts; measured cost of the pre-deferral behaviour was
 *     0.86/3 mean concurrency over a 20.1h round). Its PM resolver, which is
 *     the part that actually churns Hub capacity, IS counted below.
 *
 *   - terminal statuses (`completed`, `failed`, `abandoned`, `skipped`) and
 *     `pending` — nothing is running, nothing is reserved.
 */
const SLOT_OCCUPYING_WORKER_STATUSES: ReadonlySet<LifecycleStatus> = new Set([
  "running",
  "awaiting_validation",
  "fix_requested"
]);

export function isSlotOccupyingWorkerStatus(status: LifecycleStatus): boolean {
  return SLOT_OCCUPYING_WORKER_STATUSES.has(status);
}

export interface ParallelSlotOccupancy {
  /** Worker rows holding a slot (see SLOT_OCCUPYING_WORKER_STATUSES). */
  workerIds: string[];
  /** Thread ids of PM resolvers holding a slot. */
  pmResolverThreadIds: string[];
  /** Total occupied slots — compare this against `max_concurrency`. */
  count: number;
}

/**
 * TRUE slot occupancy for a dispatch plan: everything that is holding, or has
 * reserved, one of `parallel_dispatch.max_concurrency` lanes right now.
 *
 * Use this — and only this — to answer "is there a free slot to launch into?".
 * Do NOT use it to answer "is this dispatcher idle / stalled?": those two
 * questions were the same number before this function existed, and conflating
 * them is what produced BOTH failure modes seen in production. Counting too
 * narrowly over-dispatches (measured peak concurrency 4 against
 * `max_concurrency: 3`); counting too widely re-breaks the under-dispatch fix,
 * because the `mode: "idle"` slot-fill path in watchdog.ts only exists for the
 * case where a row is parked in `awaiting_validation` with nothing running, and
 * that path must keep seeing "zero running" to be reachable at all.
 *
 * Notes on the accounting:
 *
 *   - The synthetic `DISPATCHER` row is skipped. It tracks the dispatcher's own
 *     controller turn, not a parallel worker lane, and it is `running` for most
 *     of a healthy round — counting it would silently cost every plan one slot.
 *
 *   - PM resolver threads are counted independently of workers rather than
 *     deduped against them. A PM resolver is its own codex thread on the Hub
 *     (thread-id-reservation.ts reserves it for exactly that reason — the
 *     agent-dispatcher-8eb13a31 BATCH-3-GATE → codex_19 bleed). Double counting
 *     does not arise in practice because a PM resolver's target worker is
 *     `blocked` / `failed` while the resolver runs, and neither status is
 *     slot-occupying.
 *
 *   - No-progress-stale resolvers are dropped, reusing the same predicate the
 *     watchdog uses to demote them, so a resolver the watchdog is about to
 *     write off does not keep a lane hostage.
 *
 *   - There is no `continueWorkerId` exemption here, unlike
 *     `resolveBlockingRunningWorkers`. That exemption answers "is somebody
 *     ELSE blocking the row I am about to launch"; capacity does not care who
 *     the caller had in mind. A `fix_requested` row whose thread was cleared
 *     for relaunch is still a slot spoken for.
 */
export function resolveOccupiedParallelSlots(
  state: DispatchThreadStateV2,
  nowMs: number = Date.now()
): ParallelSlotOccupancy {
  const workerIds = Object.entries(state.workers)
    .filter(([workerId]) => workerId !== DISPATCHER_WORKER_ID)
    .filter(([, worker]) => isSlotOccupyingWorkerStatus(worker.status))
    .map(([workerId]) => workerId);

  const pmResolverThreadIds = (state.pm_resolvers ?? [])
    .filter((entry) => entry.status === "running" && !isPmResolverNoProgressStale(entry, nowMs))
    .map((entry) => entry.thread_id);

  return {
    workerIds,
    pmResolverThreadIds,
    count: workerIds.length + pmResolverThreadIds.length
  };
}
