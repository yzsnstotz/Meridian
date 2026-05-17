import { describe, expect, it } from "vitest";

import { isMissingThreadEvidence } from "../missing-thread";

describe("isMissingThreadEvidence", () => {
  // Regression: the watchdog's previous local matcher missed this exact
  // wording, which the hub returns from kill() when the thread has been
  // recycled or never registered. Every watchdog tick re-attempted the same
  // kill against a hub that always said no, producing the 315k+ "terminal
  // worker cleanup kill failed" warnings observed on 2026-05-18.
  it("recognises the hub's 'No registered agent instance found' kill error", () => {
    expect(
      isMissingThreadEvidence(
        "kill failed: Routing failed: No registered agent instance found for thread_id=codex_19"
      )
    ).toBe(true);
  });

  it("recognises 'is not registered' from hub interrupt/attach/restart paths", () => {
    expect(
      isMissingThreadEvidence(
        "Cannot attach session; thread_id=codex_07 is not registered"
      )
    ).toBe(true);
  });

  it("recognises 'unknown thread' wording", () => {
    expect(isMissingThreadEvidence("kill failed: unknown thread codex_42")).toBe(true);
  });

  it("recognises 'no thread is attached'", () => {
    expect(isMissingThreadEvidence("hub: no thread is attached to channel")).toBe(true);
  });

  it("recognises 'not found'", () => {
    expect(isMissingThreadEvidence("thread_id=codex_99 not found")).toBe(true);
  });

  it("returns false on null/empty/whitespace input", () => {
    expect(isMissingThreadEvidence(null)).toBe(false);
    expect(isMissingThreadEvidence(undefined)).toBe(false);
    expect(isMissingThreadEvidence("")).toBe(false);
    expect(isMissingThreadEvidence("   ")).toBe(false);
  });

  it("returns false on unrelated error messages", () => {
    expect(isMissingThreadEvidence("Routing failed: timeout after 30000ms")).toBe(false);
    expect(isMissingThreadEvidence("Cannot spawn agentapi process")).toBe(false);
  });
});
