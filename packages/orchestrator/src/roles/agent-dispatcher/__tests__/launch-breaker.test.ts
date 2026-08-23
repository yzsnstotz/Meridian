import { describe, expect, it } from "vitest";

import {
  DispatcherLaunchBreaker,
  LaunchBreakerTrippedError,
  DEFAULT_LAUNCH_THRESHOLD,
  DEFAULT_LAUNCH_WINDOW_MS
} from "../launch-breaker";

const ROLE = "agent-dispatcher-67f6a3fc";

describe("DispatcherLaunchBreaker", () => {
  it("allows launches up to threshold within window", () => {
    const b = new DispatcherLaunchBreaker({ windowMs: 60_000, threshold: 3 });
    expect(b.shouldAllow(ROLE, 0).allowed).toBe(true);
    expect(b.shouldAllow(ROLE, 1000).allowed).toBe(true);
    expect(b.shouldAllow(ROLE, 2000).allowed).toBe(true);
  });

  it("trips on the (threshold+1)-th launch", () => {
    const b = new DispatcherLaunchBreaker({ windowMs: 60_000, threshold: 3 });
    b.shouldAllow(ROLE, 0);
    b.shouldAllow(ROLE, 1000);
    b.shouldAllow(ROLE, 2000);
    const trip = b.shouldAllow(ROLE, 3000);
    expect(trip.allowed).toBe(false);
    expect(trip.reason).toBe("tripped");
    expect(trip.countAfter).toBe(4);
  });

  it("starts a fresh window after expiration", () => {
    const b = new DispatcherLaunchBreaker({ windowMs: 60_000, threshold: 3 });
    b.shouldAllow(ROLE, 0);
    b.shouldAllow(ROLE, 1000);
    b.shouldAllow(ROLE, 2000);
    const trip = b.shouldAllow(ROLE, 3000);
    expect(trip.allowed).toBe(false);

    // 70s later → window expired
    const fresh = b.shouldAllow(ROLE, 70_000);
    expect(fresh.allowed).toBe(true);
    expect(fresh.countAfter).toBe(1);
  });

  it("isolates state across roles", () => {
    const b = new DispatcherLaunchBreaker({ windowMs: 60_000, threshold: 2 });
    b.shouldAllow(ROLE, 0);
    b.shouldAllow(ROLE, 1000);
    b.shouldAllow(ROLE, 2000);
    expect(b.shouldAllow(ROLE, 3000).allowed).toBe(false);
    expect(b.shouldAllow("other-role", 3000).allowed).toBe(true);
  });

  it("reset() clears budget for the role", () => {
    const b = new DispatcherLaunchBreaker({ windowMs: 60_000, threshold: 2 });
    b.shouldAllow(ROLE, 0);
    b.shouldAllow(ROLE, 1000);
    expect(b.shouldAllow(ROLE, 2000).allowed).toBe(false);
    b.reset(ROLE);
    const after = b.shouldAllow(ROLE, 3000);
    expect(after.allowed).toBe(true);
    expect(after.countAfter).toBe(1);
  });

  it("snapshot() exposes counters", () => {
    const b = new DispatcherLaunchBreaker();
    b.shouldAllow(ROLE, 0);
    b.shouldAllow(ROLE, 1000);
    const snap = b.snapshot();
    expect(snap[ROLE]?.count).toBe(2);
    expect(snap[ROLE]?.windowStartedAt).toBe(0);
  });

  it("defaults are 3 launches / 60 seconds", () => {
    expect(DEFAULT_LAUNCH_THRESHOLD).toBe(3);
    expect(DEFAULT_LAUNCH_WINDOW_MS).toBe(60_000);
  });

  it("LaunchBreakerTrippedError carries structured context", () => {
    const err = new LaunchBreakerTrippedError(ROLE, {
      allowed: false,
      countAfter: 5,
      windowStartedAt: 100,
      reason: "tripped"
    });
    expect(err.dispatcherRoleId).toBe(ROLE);
    expect(err.countAfter).toBe(5);
    expect(err.message).toContain(ROLE);
    expect(err.message).toContain("5 launches");
  });
});
