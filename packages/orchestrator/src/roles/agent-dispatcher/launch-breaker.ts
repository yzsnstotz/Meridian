// Per-dispatcherRoleId launch budget. Sibling to circuit-breaker.ts; that one
// gates the watchdog's continueDispatcher path, this one gates EVERY dispatcher
// launch path (RoleRunner.activate, relaunchAgentDispatcherHub, the HTTP
// continue-dispatcher endpoint via reactivatePersistedAgentDispatcher).
//
// Failure mode this catches: the operator GUI / external trigger keeps hitting
// `/api/agent-dispatcher/<id>/continue` or `/start-hub-session` while the
// Meridian Hub at :3000 is overloaded or unreachable. Each request spawns a
// fresh codex_NN dispatcher thread, which then dies because its run-tool
// callback can't reach Meridian-roles, which then frees the next request to
// spawn yet another. Without this layer, 25 GUI clicks turned into ~75 codex
// spawns immediately after a rebuild-restart on agent-dispatcher-67f6a3fc &
// siblings (observed 2026-05-16).

export const DEFAULT_LAUNCH_WINDOW_MS = 60_000;  // 60 seconds
export const DEFAULT_LAUNCH_THRESHOLD = 3;       // 3 launches/min = clearly thrashing

export interface LaunchBreakerEntry {
  count: number;
  windowStartedAt: number;
  lastLaunchAt: number;
}

export interface LaunchBreakerVerdict {
  allowed: boolean;
  countAfter: number;
  windowStartedAt: number;
  reason?: "tripped";
}

export interface DispatcherLaunchBreakerOptions {
  windowMs?: number;
  threshold?: number;
}

export class DispatcherLaunchBreaker {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly state = new Map<string, LaunchBreakerEntry>();

  constructor(options: DispatcherLaunchBreakerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_LAUNCH_WINDOW_MS;
    this.threshold = options.threshold ?? DEFAULT_LAUNCH_THRESHOLD;
  }

  /**
   * Called BEFORE actually launching the dispatcher. The caller passes `now`
   * so tests don't need to fake clocks via mocks. If allowed=false, the
   * caller must abort the launch (and ideally pause the role) — DO NOT
   * launch anyway.
   */
  shouldAllow(dispatcherRoleId: string, now: number): LaunchBreakerVerdict {
    const previous = this.state.get(dispatcherRoleId);

    if (!previous || now - previous.windowStartedAt > this.windowMs) {
      const entry: LaunchBreakerEntry = {
        count: 1,
        windowStartedAt: now,
        lastLaunchAt: now
      };
      this.state.set(dispatcherRoleId, entry);
      return { allowed: true, countAfter: 1, windowStartedAt: now };
    }

    const nextCount = previous.count + 1;
    previous.count = nextCount;
    previous.lastLaunchAt = now;

    if (nextCount > this.threshold) {
      return {
        allowed: false,
        countAfter: nextCount,
        windowStartedAt: previous.windowStartedAt,
        reason: "tripped"
      };
    }

    return {
      allowed: true,
      countAfter: nextCount,
      windowStartedAt: previous.windowStartedAt
    };
  }

  /**
   * Operator unblocks the role (e.g. via resume after fixing Hub
   * connectivity) → caller clears the breaker so the next launch starts
   * fresh.
   */
  reset(dispatcherRoleId: string): void {
    this.state.delete(dispatcherRoleId);
  }

  snapshot(): Record<string, LaunchBreakerEntry> {
    const result: Record<string, LaunchBreakerEntry> = {};
    for (const [id, entry] of this.state.entries()) {
      result[id] = { ...entry };
    }
    return result;
  }
}

export class LaunchBreakerTrippedError extends Error {
  readonly dispatcherRoleId: string;
  readonly countAfter: number;
  readonly windowStartedAt: number;

  constructor(dispatcherRoleId: string, verdict: LaunchBreakerVerdict) {
    super(
      `Dispatcher launch breaker tripped for ${dispatcherRoleId}: ` +
      `${verdict.countAfter} launches since ${new Date(verdict.windowStartedAt).toISOString()} — ` +
      `Hub likely unreachable or thrashing. Role force-paused; resume after fixing.`
    );
    this.name = "LaunchBreakerTrippedError";
    this.dispatcherRoleId = dispatcherRoleId;
    this.countAfter = verdict.countAfter;
    this.windowStartedAt = verdict.windowStartedAt;
  }
}
