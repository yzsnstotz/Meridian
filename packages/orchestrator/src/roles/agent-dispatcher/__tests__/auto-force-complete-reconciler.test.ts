import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runAutoForceCompleteSweep } from "../auto-force-complete-reconciler";
import { LifecycleStore } from "../lifecycle-store";
import type { DispatchThreadStateV2 } from "../../../types";
import type { WorkerCommitMatch } from "../commit-scanner";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    Array.from(tempDirectories, (dir) => fsp.rm(dir, { recursive: true, force: true }))
  );
  tempDirectories.clear();
});

describe("runAutoForceCompleteSweep", () => {
  it("promotes a blocked worker when commit + fresh report both exist", async () => {
    const { store, dispatchPlanPath } = await createHarness({
      workers: {
        "W-09": buildBlockedWorker({ last_seen_at: "2026-05-19T00:00:00.000Z" })
      }
    });

    const report = await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: silentLogger(),
      statReport: async () => ({ mtimeMs: Date.parse("2026-05-19T05:00:00.000Z") }),
      scanCommits: () => [{
        sha: "abc1234",
        subject: "[W-09] ship the thing",
        committerDateMs: Date.parse("2026-05-19T04:30:00.000Z")
      } satisfies WorkerCommitMatch]
    });

    expect(report.promoted).toEqual([
      expect.objectContaining({
        workerId: "W-09",
        commitSha: "abc1234",
        commitSubject: "[W-09] ship the thing"
      })
    ]);
    expect(report.skipped).toEqual([]);
    expect(store.load().workers["W-09"]).toMatchObject({
      status: "completed",
      hub_result: null
    });
  });

  it("skips when the report file is missing", async () => {
    const { store, dispatchPlanPath } = await createHarness({
      workers: {
        "W-09": buildBlockedWorker({ last_seen_at: "2026-05-19T00:00:00.000Z" })
      }
    });

    const report = await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: silentLogger(),
      statReport: async () => null,
      scanCommits: () => [{ sha: "abc1234", subject: "[W-09] x", committerDateMs: Date.now() }]
    });

    expect(report.promoted).toEqual([]);
    expect(report.skipped).toEqual([{ workerId: "W-09", reason: "report_missing" }]);
    expect(store.load().workers["W-09"]?.status).toBe("blocked");
  });

  it("skips when the report mtime is not strictly after last_seen_at", async () => {
    const { store, dispatchPlanPath } = await createHarness({
      workers: {
        "W-09": buildBlockedWorker({ last_seen_at: "2026-05-19T05:00:00.000Z" })
      }
    });

    const report = await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: silentLogger(),
      statReport: async () => ({ mtimeMs: Date.parse("2026-05-19T05:00:00.000Z") }),
      scanCommits: () => [{ sha: "abc1234", subject: "[W-09] x", committerDateMs: Date.now() }]
    });

    expect(report.skipped).toEqual([{ workerId: "W-09", reason: "report_not_after_last_seen_at" }]);
    expect(store.load().workers["W-09"]?.status).toBe("blocked");
  });

  it("skips when no commit matches the worker prefix", async () => {
    const { store, dispatchPlanPath } = await createHarness({
      workers: {
        "W-09": buildBlockedWorker({ last_seen_at: "2026-05-19T00:00:00.000Z" })
      }
    });

    const report = await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: silentLogger(),
      statReport: async () => ({ mtimeMs: Date.parse("2026-05-19T05:00:00.000Z") }),
      scanCommits: () => []
    });

    expect(report.skipped).toEqual([{ workerId: "W-09", reason: "no_matching_commit" }]);
    expect(store.load().workers["W-09"]?.status).toBe("blocked");
  });

  it("ignores workers that are not in `blocked` state", async () => {
    const { store, dispatchPlanPath } = await createHarness({
      workers: {
        "W-09": { ...buildBlockedWorker({ last_seen_at: "2026-05-19T00:00:00.000Z" }), status: "completed" }
      }
    });

    const scanCommits = vi.fn(() => [] as WorkerCommitMatch[]);
    const statReport = vi.fn(async () => null);

    const report = await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: silentLogger(),
      statReport,
      scanCommits
    });

    expect(report.promoted).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(scanCommits).not.toHaveBeenCalled();
    expect(statReport).not.toHaveBeenCalled();
  });

  it("picks the newest matching commit by committer date", async () => {
    const { store, dispatchPlanPath } = await createHarness({
      workers: {
        "W-09": buildBlockedWorker({ last_seen_at: "2026-05-19T00:00:00.000Z" })
      }
    });

    const report = await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: silentLogger(),
      statReport: async () => ({ mtimeMs: Date.parse("2026-05-19T10:00:00.000Z") }),
      scanCommits: () => [
        { sha: "older00", subject: "[W-09] earlier", committerDateMs: Date.parse("2026-05-19T01:00:00.000Z") },
        { sha: "newer00", subject: "[W-09] later", committerDateMs: Date.parse("2026-05-19T09:00:00.000Z") }
      ]
    });

    expect(report.promoted[0]?.commitSha).toBe("newer00");
  });

  it("emits a `lifecycle_auto_force_complete` log line on promotion", async () => {
    const { store, dispatchPlanPath } = await createHarness({
      workers: {
        "W-09": buildBlockedWorker({ last_seen_at: "2026-05-19T00:00:00.000Z" })
      }
    });
    const infoSpy = vi.fn();

    await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: { ...silentLogger(), info: infoSpy },
      statReport: async () => ({ mtimeMs: Date.parse("2026-05-19T05:00:00.000Z") }),
      scanCommits: () => [{
        sha: "abc1234",
        subject: "[W-09] ok",
        committerDateMs: Date.parse("2026-05-19T04:30:00.000Z")
      }]
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "Lifecycle auto force complete",
      expect.objectContaining({
        event: "lifecycle_auto_force_complete",
        worker_id: "W-09",
        commit_sha: "abc1234"
      })
    );
  });

  it("returns empty when no workers are blocked", async () => {
    const { store, dispatchPlanPath } = await createHarness({ workers: {} });

    const scanCommits = vi.fn(() => [] as WorkerCommitMatch[]);
    const report = await runAutoForceCompleteSweep(store, dispatchPlanPath, {
      baseBranch: "main",
      log: silentLogger(),
      statReport: async () => null,
      scanCommits
    });

    expect(report.promoted).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(scanCommits).not.toHaveBeenCalled();
  });
});

function buildBlockedWorker(overrides: { last_seen_at: string }) {
  return {
    thread_id: "worker-thread-111",
    trace_id: null,
    started_at: "2026-05-18T00:00:00.000Z",
    last_seen_at: overrides.last_seen_at,
    status: "blocked" as const,
    expected_outputs: [],
    hub_result: null,
    command_preamble: null,
    retry_count: 0
  };
}

async function createHarness(options: {
  workers: DispatchThreadStateV2["workers"];
}): Promise<{ store: LifecycleStore; dispatchPlanPath: string }> {
  const directory = await fsp.mkdtemp(path.join(tmpdir(), "auto-force-complete-"));
  tempDirectories.add(directory);
  const filePath = path.join(directory, "dispatch_threads.json");
  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");

  const state: DispatchThreadStateV2 = {
    version: 2,
    dispatcher: { thread_id: null, started_at: null, status: "pending" },
    workers: options.workers,
    last_reconciled_at: null
  };

  await fsp.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  const store = new LifecycleStore(filePath, { dispatchPlanPath });
  return { store, dispatchPlanPath };
}

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
