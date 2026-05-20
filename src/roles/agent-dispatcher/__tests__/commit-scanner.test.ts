import { describe, expect, it, vi } from "vitest";

import {
  scanRecentCommitsForWorker,
  subjectMatchesWorkerPrefix
} from "../commit-scanner";

describe("subjectMatchesWorkerPrefix", () => {
  it("matches the bare `[WORKER_ID]` prefix", () => {
    expect(subjectMatchesWorkerPrefix("[W-01] do thing", "W-01")).toBe(true);
  });

  it("matches the bare prefix with a colon separator", () => {
    expect(subjectMatchesWorkerPrefix("[W-01]: do thing", "W-01")).toBe(true);
  });

  it("matches the bare prefix as the entire subject", () => {
    expect(subjectMatchesWorkerPrefix("[W-01]", "W-01")).toBe(true);
  });

  it("tolerates leading whitespace before the prefix", () => {
    expect(subjectMatchesWorkerPrefix("  [W-01] do thing", "W-01")).toBe(true);
  });

  it("does not absorb `[W-1]` into `[W-10]`", () => {
    expect(subjectMatchesWorkerPrefix("[W-10] do thing", "W-1")).toBe(false);
  });

  it("rejects `[W-01]x` (no separator)", () => {
    expect(subjectMatchesWorkerPrefix("[W-01]x", "W-01")).toBe(false);
  });

  it("rejects a prefix that is not at the start", () => {
    expect(subjectMatchesWorkerPrefix("feat(W-01): [W-01] thing", "W-01")).toBe(false);
  });

  it("rejects empty subject or empty worker id", () => {
    expect(subjectMatchesWorkerPrefix("", "W-01")).toBe(false);
    expect(subjectMatchesWorkerPrefix("[W-01] thing", "")).toBe(false);
  });
});

describe("scanRecentCommitsForWorker", () => {
  it("returns matching commits, newest by committer date", () => {
    const execFile = vi.fn().mockReturnValue(
      [
        "abc1234\t1716240000\t[W-02] later commit",
        "def5678\t1716000000\t[W-02] earlier commit",
        "9999999\t1716100000\tunrelated commit"
      ].join("\n")
    );

    const matches = scanRecentCommitsForWorker("main", "W-02", { execFile });

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ sha: "abc1234", subject: "[W-02] later commit", committerDateMs: 1716240000 * 1000 });
    expect(matches[1]).toMatchObject({ sha: "def5678", subject: "[W-02] earlier commit", committerDateMs: 1716000000 * 1000 });
  });

  it("returns empty when git is unavailable", () => {
    const execFile = vi.fn().mockImplementation(() => {
      throw new Error("git not found");
    });

    expect(scanRecentCommitsForWorker("main", "W-02", { execFile })).toEqual([]);
  });

  it("returns empty when no commit matches the prefix", () => {
    const execFile = vi.fn().mockReturnValue(
      [
        "abc1234\t1716240000\t[W-99] not matching",
        "def5678\t1716000000\t[OTHER] not matching"
      ].join("\n")
    );

    expect(scanRecentCommitsForWorker("main", "W-02", { execFile })).toEqual([]);
  });

  it("filters out malformed lines (non-hex sha, non-numeric date, missing tabs)", () => {
    const execFile = vi.fn().mockReturnValue(
      [
        "NOTAHASH\t1716240000\t[W-02] thing",
        "abc1234\tNOTANUMBER\t[W-02] thing",
        "no-tabs-line",
        "abc1234\t1716240000\t[W-02] ok"
      ].join("\n")
    );

    const matches = scanRecentCommitsForWorker("main", "W-02", { execFile });
    expect(matches).toEqual([{ sha: "abc1234", subject: "[W-02] ok", committerDateMs: 1716240000 * 1000 }]);
  });

  it("refuses a base branch that starts with a dash (would be parsed as a git flag)", () => {
    const execFile = vi.fn();
    expect(scanRecentCommitsForWorker("--exec=evil", "W-02", { execFile })).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("passes git log with the since window derived from the current time", () => {
    const execFile = vi.fn().mockReturnValue("");
    const nowMs = Date.parse("2026-05-20T00:00:00.000Z");
    scanRecentCommitsForWorker("main", "W-02", { execFile, now: () => nowMs, windowDays: 7 });

    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args] = execFile.mock.calls[0]!;
    expect(command).toBe("git");
    expect(args).toEqual([
      "log",
      "main",
      `--since=${new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString()}`,
      "--format=%H%x09%ct%x09%s"
    ]);
  });
});
