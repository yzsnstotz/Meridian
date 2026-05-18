import { describe, expect, it } from "vitest";

import { countPatternsInText } from "../log-counter";

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
