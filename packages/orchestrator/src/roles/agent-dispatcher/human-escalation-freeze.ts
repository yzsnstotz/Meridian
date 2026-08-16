import { parseMeridianStatusMarker } from "./meridian-status-marker";
import type { DispatchThreadStateV2, LifecycleStatus } from "../../types";

export type PmResolverLifecycleEntry = NonNullable<DispatchThreadStateV2["pm_resolvers"]>[number];

/**
 * The slice of lifecycle state the escalation freeze needs. Kept structural so
 * both the full `DispatchThreadStateV2` and the narrow `Pick<...>` shapes the
 * watchdog/dispatcher already pass around satisfy it.
 */
export type HumanEscalationFreezeState = Pick<DispatchThreadStateV2, "workers" | "pm_resolvers">;

export interface HumanEscalationFreeze {
  workerId: string;
  /** Thread id of the PM resolver whose marker emitted `escalate_human`. */
  pmResolverThreadId: string;
  /** `last_seen_at` of that PM entry — the instant the freeze was armed. */
  escalatedAt: string;
  /**
   * The worker's most recent `human_resolution.resolved_at`, if any. Present
   * but older than `escalatedAt` means a PREVIOUS escalation was released and
   * a new one has since been raised.
   */
  humanResolvedAt: string | null;
}

/**
 * Lifecycle statuses that CONCLUDE a row's work, so an outstanding
 * `escalate_human` on it is moot rather than parked.
 *
 * This is deliberately NOT the `isLifecycleTerminal` set in
 * src/server/role-handlers.ts (`completed`/`skipped`/`failed`/`blocked`), which
 * answers a different question — "can the dispatch plan stop waiting on this
 * row" — and gets two of the four wrong for this one:
 *
 * - `blocked` is the single MOST parked state, not a moot one. It is the exact
 *   shape `markHumanResolved` was written for ("worker is blocked, PM escalated
 *   to a human and was killed"): the row stopped without its work being done
 *   and a human owns the verdict. Suppressing it would delete precisely the
 *   signal the heartbeat exists to emit.
 * - `failed` / `abandoned` are not conclusions either — `isRetryableTerminalWorker`
 *   in ./service-continuation still admits ❌ / ⚠️ ABANDONED rows for automatic
 *   relaunch while `retry_count < MAX_AUTOMATIC_RECOVERY_RETRIES`, so the
 *   freeze's REFUSAL half is genuinely live for them and reporting them is
 *   honest.
 *
 * `completed` and `skipped` are the two statuses whose work is over by a route
 * that never needed the human: the round either landed the row or deliberately
 * dropped it. They are also the pair `isImplicitContinueRow` already singles
 * out as "terminal success state ... re-dispatching would cause an infinite
 * re-dispatch loop", i.e. the two states from which no launch path can ever
 * originate, freeze or no freeze.
 *
 * This is a READ-SIDE filter on current status, never a stamp. If an operator
 * later resets a `completed` row back to `pending` for a retry, the escalation
 * re-arms by itself — which a written "handled" marker could not do.
 */
const ESCALATION_MOOT_STATUSES: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>([
  "completed",
  "skipped"
]);

/**
 * True when the row's work is concluded, so no human verdict is outstanding on
 * it regardless of what the PM resolver entries say.
 *
 * An unknown worker id (present on a PM entry but absent from `workers`) is NOT
 * moot: absence tells us nothing was concluded.
 */
export function isHumanEscalationMoot(
  state: HumanEscalationFreezeState,
  workerId: string | null | undefined
): boolean {
  const normalizedWorkerId = workerId?.trim();
  if (!normalizedWorkerId) {
    return false;
  }
  const status = state.workers?.[normalizedWorkerId]?.status;
  return status !== undefined && ESCALATION_MOOT_STATUSES.has(status);
}

/**
 * Return the PM resolver action for a lifecycle entry, preferring the
 * persisted `marker_pm_action` field and falling back to re-parsing the
 * stored reply content. The fallback handles entries written by pre-#219
 * binaries (where the field did not exist on the schema). The re-parsed
 * marker is only honoured when its role is `pm-resolver` AND its worker_id
 * matches the entry's target — same constraint as `recordPmResolverResult`,
 * so cross-talk content from a thread-id-collision bleed cannot synthesise a
 * false escalation freeze.
 */
export function effectivePmResolverAction(
  entry: PmResolverLifecycleEntry,
  targetWorkerId: string
): string | null {
  if (entry.marker_pm_action !== null) {
    return entry.marker_pm_action;
  }
  const content = entry.result?.content;
  if (typeof content !== "string" || content.length === 0) {
    return null;
  }
  const marker = parseMeridianStatusMarker(content);
  if (!marker || marker.role !== "pm-resolver" || marker.worker_id !== targetWorkerId) {
    return null;
  }
  return marker.pm_action ?? null;
}

/**
 * The escalation freeze predicate, single-sourced.
 *
 * A worker is FROZEN when some PM resolver entry targeting it emitted
 * `pm_action: escalate_human` and no human has acknowledged since: released
 * only when `worker.human_resolution.resolved_at` is at least as new as that
 * entry's `last_seen_at`. For a row with work still outstanding that is the one
 * and only release mechanism; there is deliberately no timeout, no retry
 * budget, and no "escalation expired" path, because the whole point is that a
 * human — not the dispatcher — owns the verdict.
 *
 * Historically this gated PM RESOLVER SPAWN only (see
 * `hasPmResolverHandledCurrentWorkerIssue` in src/index.ts). That left the
 * worker LAUNCHER wide open: on round unification-layer-decoupling-2026-08-06
 * the dispatcher correctly refused a further PM for BATCH-8-GATE at 21:02:11Z
 * ("PM resolver terminal without resolve; operator action required") and in the
 * same second transitioned the row pending → running as ordinary queued work,
 * then burned 4 validator cycles and 4 worker attempts over ~2h against an
 * unsatisfiable acceptance contract while gating 25 downstream rows, with
 * `human_resolution` null throughout. Every launch/continuation entry point
 * therefore consults this predicate too.
 *
 * One thing the freeze is NOT: a permanent record that an escalation was once
 * raised. A row whose work concluded by another route — an operator retry that
 * then passed, a PM `force_complete`, a `skip` — never stamps
 * `human_resolution`, so its escalation entry stays unreleased forever. Live on
 * 2026-08-10 that left W1-03 (`completed`) re-announced as
 * `dispatcher_awaiting_human_resolution` with `parkedForMs: 204240274` (~56h)
 * and C-04b alongside it, on every watchdog sweep, permanently. The refusal
 * half was a harmless no-op for those rows, but the operator-facing half was
 * actively wrong: it told a human to `POST /worker/W1-03/human-resolve`, which
 * would have flipped a long-completed row back to `running`. So the predicate
 * asks what state the row is in NOW — see {@link isHumanEscalationMoot} — and a
 * concluded row is not frozen at all, on either half.
 *
 * That check is a filter on STATE, never on age: a genuine 56-hour park on a
 * `blocked` row still reports, every sweep, exactly as before.
 */
export function findUnreleasedHumanEscalation(
  state: HumanEscalationFreezeState,
  workerId: string | null | undefined
): HumanEscalationFreeze | null {
  const normalizedWorkerId = workerId?.trim();
  if (!normalizedWorkerId) {
    return null;
  }

  if (isHumanEscalationMoot(state, normalizedWorkerId)) {
    return null;
  }

  const worker = state.workers?.[normalizedWorkerId];
  const humanResolvedAt = worker?.human_resolution?.resolved_at ?? null;
  const humanResolvedAtMs = humanResolvedAt ? Date.parse(humanResolvedAt) : NaN;

  let latest: HumanEscalationFreeze | null = null;
  let latestEscalatedAtMs = Number.NEGATIVE_INFINITY;

  for (const entry of state.pm_resolvers ?? []) {
    if ((entry.issue?.worker_id ?? "").trim() !== normalizedWorkerId) {
      continue;
    }
    if (effectivePmResolverAction(entry, normalizedWorkerId) !== "escalate_human") {
      continue;
    }

    const entryLastSeenAtMs = Date.parse(entry.last_seen_at);
    const released = !Number.isNaN(humanResolvedAtMs)
      && !Number.isNaN(entryLastSeenAtMs)
      && humanResolvedAtMs >= entryLastSeenAtMs;
    if (released) {
      continue;
    }

    // Report the NEWEST unreleased escalation so operator-facing messages name
    // the PM thread the human should actually read.
    const sortKey = Number.isNaN(entryLastSeenAtMs) ? Number.NEGATIVE_INFINITY : entryLastSeenAtMs;
    if (latest && sortKey <= latestEscalatedAtMs) {
      continue;
    }
    latestEscalatedAtMs = sortKey;
    latest = {
      workerId: normalizedWorkerId,
      pmResolverThreadId: entry.thread_id,
      escalatedAt: entry.last_seen_at,
      humanResolvedAt
    };
  }

  return latest;
}

/** Boolean form of {@link findUnreleasedHumanEscalation}. */
export function isFrozenPendingHumanResolution(
  state: HumanEscalationFreezeState,
  workerId: string | null | undefined
): boolean {
  return findUnreleasedHumanEscalation(state, workerId) !== null;
}

/**
 * Every worker currently parked behind an unreleased `escalate_human`.
 * Used for operator-facing surfacing (continue-dispatcher responses, watchdog
 * heartbeat log) so a parked row never reads as ordinary `pending`.
 */
export function resolveHumanEscalationFrozenWorkers(
  state: HumanEscalationFreezeState
): HumanEscalationFreeze[] {
  const seen = new Set<string>();
  const frozen: HumanEscalationFreeze[] = [];
  for (const entry of state.pm_resolvers ?? []) {
    const workerId = (entry.issue?.worker_id ?? "").trim();
    if (!workerId || seen.has(workerId)) {
      continue;
    }
    seen.add(workerId);
    const freeze = findUnreleasedHumanEscalation(state, workerId);
    if (freeze) {
      frozen.push(freeze);
    }
  }
  return frozen;
}

/** Operator-facing one-liner describing why a row is parked. */
export function describeHumanEscalationFreeze(freeze: HumanEscalationFreeze): string {
  return `awaiting human resolution: ${freeze.workerId} was escalated to a human by PM resolver `
    + `${freeze.pmResolverThreadId} at ${freeze.escalatedAt} and has not been released; `
    + `POST /worker/${freeze.workerId}/human-resolve to resume it`;
}
