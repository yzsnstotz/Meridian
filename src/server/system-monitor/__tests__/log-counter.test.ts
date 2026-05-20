import { describe, expect, it } from "vitest";

import {
  countIsNotRegisteredPostHubInit,
  countPatternsInText,
  HUB_RESTART_WINDOW_MS
} from "../log-counter";

const ONE_MIN = 60 * 1000;
const NOW = Date.parse("2026-05-18T08:00:00.000Z");

const PATTERNS = [
  { key: "kill_failed", pattern: /terminal worker cleanup kill failed/i, windowMs: 5 * ONE_MIN }
];

describe("countPatternsInText", () => {
  it("skips matching lines that have no parseable timestamp", () => {
    // Reproduces the false-positive: pino-pretty console output has no ISO
    // timestamp and no "time": JSON field, so the window filter cannot judge
    // age. Such lines must be skipped — never counted as if they were recent.
    const text = [
      "Watchdog: terminal worker cleanup kill failed {",
      "  dispatchPlanPath: '/foo/plan.md',",
      "  thread_id: 'codex_38',",
      "  error: 'kill failed: Routing failed: No registered agent instance found'",
      "}"
    ].join("\n");

    const counts = countPatternsInText(text, NOW, PATTERNS);

    expect(counts.get("kill_failed")).toBe(0);
  });

  it("counts matching lines whose ISO timestamp falls inside the window", () => {
    const recentIso = new Date(NOW - 30 * 1000).toISOString();
    const text = `${recentIso} Watchdog: terminal worker cleanup kill failed { foo: 'bar' }`;

    const counts = countPatternsInText(text, NOW, PATTERNS);

    expect(counts.get("kill_failed")).toBe(1);
  });

  it("skips matching lines whose ISO timestamp falls outside the window", () => {
    const staleIso = new Date(NOW - 10 * ONE_MIN).toISOString();
    const text = `${staleIso} Watchdog: terminal worker cleanup kill failed { foo: 'bar' }`;

    const counts = countPatternsInText(text, NOW, PATTERNS);

    expect(counts.get("kill_failed")).toBe(0);
  });
});

describe("countIsNotRegisteredPostHubInit", () => {
  // End-state indicator for the storm fix shipped by meridian-hub PR #90.
  // Counts "thread_id=X is not registered" lines whose timestamp falls
  // within HUB_RESTART_WINDOW_MS after a "Hub router state initialized"
  // line. Zero means the three-windows fix is holding in production.

  it("counts an is-not-registered line emitted within 60s after a hub-router-init", () => {
    const initIso = new Date(NOW - 30 * 1000).toISOString();
    const errIso = new Date(NOW - 10 * 1000).toISOString();
    const text = [
      `${initIso} INFO Hub router state initialized { foo: 'bar' }`,
      `${errIso} ERROR Cannot interrupt; thread_id=codex_07 is not registered`
    ].join("\n");

    expect(countIsNotRegisteredPostHubInit(text, NOW)).toBe(1);
  });

  it("does NOT count an is-not-registered line that arrived BEFORE the hub-router-init", () => {
    // The error is older than the most-recent init → it belongs to a prior
    // hub generation, not this restart, and must not flow into E7.
    const errIso = new Date(NOW - 90 * 1000).toISOString();
    const initIso = new Date(NOW - 30 * 1000).toISOString();
    const text = [
      `${errIso} ERROR Cannot kill; thread_id=codex_03 is not registered`,
      `${initIso} INFO Hub router state initialized {}`
    ].join("\n");

    expect(countIsNotRegisteredPostHubInit(text, NOW)).toBe(0);
  });

  it("does NOT count an is-not-registered line that arrived MORE than the restart window after init", () => {
    const initIso = new Date(NOW - 5 * ONE_MIN).toISOString();
    const errIso = new Date(NOW - 30 * 1000).toISOString(); // 4.5 min after init
    const text = [
      `${initIso} INFO Hub router state initialized {}`,
      `${errIso} ERROR Cannot interrupt; thread_id=codex_11 is not registered`
    ].join("\n");

    expect(countIsNotRegisteredPostHubInit(text, NOW)).toBe(0);
  });

  it("returns 0 when there is no hub-router-init line at all", () => {
    const errIso = new Date(NOW - 10 * 1000).toISOString();
    const text = `${errIso} ERROR Cannot interrupt; thread_id=codex_05 is not registered`;

    expect(countIsNotRegisteredPostHubInit(text, NOW)).toBe(0);
  });

  it("counts multiple errors attributed to a single restart (storm signature)", () => {
    const initIso = new Date(NOW - 45 * 1000).toISOString();
    const err1 = new Date(NOW - 40 * 1000).toISOString();
    const err2 = new Date(NOW - 30 * 1000).toISOString();
    const err3 = new Date(NOW - 10 * 1000).toISOString();
    const text = [
      `${initIso} INFO Hub router state initialized {}`,
      `${err1} ERROR Cannot interrupt; thread_id=codex_05 is not registered`,
      `${err2} ERROR Cannot kill; thread_id=codex_06 is not registered`,
      `${err3} ERROR Cannot send terminal input; thread_id=codex_07 is not registered`
    ].join("\n");

    expect(countIsNotRegisteredPostHubInit(text, NOW)).toBe(3);
  });

  it("honors a custom restart window", () => {
    // Init at NOW-60s, error at NOW-30s → 30s gap. A 10s window excludes
    // the error; the default 60s window includes it.
    const initIso = new Date(NOW - 60 * 1000).toISOString();
    const errIso = new Date(NOW - 30 * 1000).toISOString();
    const text = [
      `${initIso} INFO Hub router state initialized {}`,
      `${errIso} ERROR Cannot interrupt; thread_id=codex_07 is not registered`
    ].join("\n");

    expect(countIsNotRegisteredPostHubInit(text, NOW, 10_000)).toBe(0);
    expect(countIsNotRegisteredPostHubInit(text, NOW, HUB_RESTART_WINDOW_MS)).toBe(1);
  });
});
