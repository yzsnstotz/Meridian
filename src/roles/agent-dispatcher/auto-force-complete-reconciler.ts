import * as fs from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../base-role";
import type { LifecycleStore } from "./lifecycle-store";
import {
  scanRecentCommitsForWorker,
  type ScanRecentCommitsOptions,
  type WorkerCommitMatch
} from "./commit-scanner";

export interface AutoForceCompleteOptions {
  baseBranch: string;
  log: Logger;
  windowDays?: number;
  now?: () => number;
  // Test seams.
  statReport?: (filePath: string) => Promise<{ mtimeMs: number } | null>;
  scanCommits?: (
    baseBranch: string,
    workerId: string,
    options: ScanRecentCommitsOptions
  ) => WorkerCommitMatch[];
}

export interface AutoForceCompletePromotion {
  workerId: string;
  commitSha: string;
  commitSubject: string;
  reportPath: string;
  reportMtimeMs: number;
  lastSeenAt: string;
}

export interface AutoForceCompleteSkip {
  workerId: string;
  reason:
    | "no_matching_commit"
    | "report_missing"
    | "report_not_after_last_seen_at"
    | "invalid_last_seen_at";
}

export interface AutoForceCompleteReport {
  promoted: AutoForceCompletePromotion[];
  skipped: AutoForceCompleteSkip[];
}

const DEFAULT_WINDOW_DAYS = 7;

export async function runAutoForceCompleteSweep(
  lifecycleStore: LifecycleStore,
  dispatchPlanPath: string,
  options: AutoForceCompleteOptions
): Promise<AutoForceCompleteReport> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? Date.now;
  const statReport = options.statReport ?? defaultStatReport;
  const scanCommits = options.scanCommits ?? scanRecentCommitsForWorker;

  const reportsDir = path.join(path.dirname(dispatchPlanPath), "reports");
  const blocked = lifecycleStore.getWorkersInState("blocked");
  const promoted: AutoForceCompletePromotion[] = [];
  const skipped: AutoForceCompleteSkip[] = [];

  if (blocked.length === 0) {
    return { promoted, skipped };
  }

  for (const worker of blocked) {
    const workerId = worker.worker_id;
    const lastSeenAtMs = Date.parse(worker.last_seen_at);
    if (!Number.isFinite(lastSeenAtMs)) {
      skipped.push({ workerId, reason: "invalid_last_seen_at" });
      continue;
    }

    const reportPath = path.join(reportsDir, `${workerId}.md`);
    const reportStat = await statReport(reportPath);
    if (!reportStat) {
      skipped.push({ workerId, reason: "report_missing" });
      continue;
    }

    if (reportStat.mtimeMs <= lastSeenAtMs) {
      skipped.push({ workerId, reason: "report_not_after_last_seen_at" });
      continue;
    }

    const matches = scanCommits(options.baseBranch, workerId, {
      windowDays,
      cwd: path.dirname(dispatchPlanPath),
      now
    });

    if (matches.length === 0) {
      skipped.push({ workerId, reason: "no_matching_commit" });
      continue;
    }

    // Use the most recent matching commit by committer date.
    const newest = matches.reduce((best, candidate) =>
      candidate.committerDateMs > best.committerDateMs ? candidate : best
    );

    lifecycleStore.setWorkerStatus(workerId, "completed", "auto_force_complete_evidence", {
      clearHubResult: true
    });

    options.log.info("Lifecycle auto force complete", {
      event: "lifecycle_auto_force_complete",
      worker_id: workerId,
      dispatch_plan_path: dispatchPlanPath,
      commit_sha: newest.sha,
      commit_subject: newest.subject,
      committer_date_ms: newest.committerDateMs,
      report_path: reportPath,
      report_mtime_ms: reportStat.mtimeMs,
      last_seen_at: worker.last_seen_at
    });

    promoted.push({
      workerId,
      commitSha: newest.sha,
      commitSubject: newest.subject,
      reportPath,
      reportMtimeMs: reportStat.mtimeMs,
      lastSeenAt: worker.last_seen_at
    });
  }

  return { promoted, skipped };
}

async function defaultStatReport(filePath: string): Promise<{ mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
