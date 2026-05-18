import { describe, expect, it, vi } from "vitest";

import { createTimestampedLogger } from "../timestamped-logger";

describe("createTimestampedLogger", () => {
  it("prepends an ISO timestamp as the first arg of each method", () => {
    const sink = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const fixed = new Date("2026-05-18T08:00:00.000Z");
    const log = createTimestampedLogger(sink, () => fixed);

    log.warn("Watchdog: kill failed", { thread_id: "codex_38" });
    log.info("Spawn complete");
    log.debug("snapshot", { foo: 1 });
    log.error("boom");

    expect(sink.warn).toHaveBeenCalledWith(
      "2026-05-18T08:00:00.000Z",
      "Watchdog: kill failed",
      { thread_id: "codex_38" }
    );
    expect(sink.info).toHaveBeenCalledWith("2026-05-18T08:00:00.000Z", "Spawn complete");
    expect(sink.debug).toHaveBeenCalledWith("2026-05-18T08:00:00.000Z", "snapshot", { foo: 1 });
    expect(sink.error).toHaveBeenCalledWith("2026-05-18T08:00:00.000Z", "boom");
  });

  it("uses Date.now by default and produces a parseable ISO timestamp", () => {
    const sink = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const log = createTimestampedLogger(sink);

    log.info("hello");

    const firstArg = sink.info.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe("string");
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(firstArg as string)).toBe(true);
    const parsed = Date.parse(firstArg as string);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(Math.abs(Date.now() - parsed)).toBeLessThan(2_000);
  });
});
