import { describe, expect, it } from "vitest";

import { sanitizeDispatcherSessionLogLines } from "../role-handlers";

describe("sanitizeDispatcherSessionLogLines", () => {
  it("removes CCB/local handoff metadata from displayed agent-dispatcher session logs", () => {
    const lines = sanitizeDispatcherSessionLogLines([
      "primary checkout dirty: ?? .ccb/",
      "details: .ccb/history/2026-05-28-handoff-s-4-1-streaming-wiring.md",
      "I added .ccb/ to local git exclude so CCB history no longer dirties the checkout.",
      "Meridian action: continue-dispatcher --dispatcher agent-dispatcher-1"
    ]);

    const text = lines.join("\n");
    expect(text).not.toMatch(/\bccb\b|\.ccb|ccb-/i);
    expect(text).toContain("[local metadata dir]/");
    expect(text).toContain("[local handoff metadata path]");
    expect(text).toContain("local handoff metadata");
    expect(text).toContain("continue-dispatcher --dispatcher agent-dispatcher-1");
  });
});
