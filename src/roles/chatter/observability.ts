export type ChatterReadOnlyQueryStatus = "ok" | "error" | "denied_skill";
export type ChatterBackgroundTriggerStatus = "scheduled" | "error";
export type MumuGitCommitKind =
  | "structured_write"
  | "structured_delete"
  | "turn_write"
  | "direct_write"
  | "restore_write"
  | "mixed"
  | "none";
export type MumuGitCommitStatus = "committed" | "noop" | "error";
export type MumuGitPushStatus = "skipped" | "pushed" | "blocked" | "conflict_pending" | "failed";
export type MumuArchiveProvisionStatus = "created" | "existing" | "error";
export type MumuArchivePressureKind =
  | "repo_size"
  | "largest_tracked_file_size"
  | "turn_log_size";

export interface MumuArchivePressureSample {
  repo_size_bytes: number;
  largest_tracked_file_bytes: number;
  turn_log_bytes_total: number;
  large_file_excluded_count: number;
}

export const CHATTER_SELF_INITIATED_TURN_TOTAL_METRIC = "chatter_self_initiated_turn_total";
export const CHATTER_SELF_INITIATED_TURN_ERROR_TOTAL_METRIC = "chatter_self_initiated_turn_error_total";
export const CHATTER_READ_ONLY_QUERY_TOTAL_METRIC = "chatter_read_only_query_total";
export const CHATTER_OBSERVATION_EVAL_ERROR_TOTAL_METRIC = "chatter_observation_eval_error_total";
export const CHATTER_LAST_PROVISION_ERROR_TOTAL_METRIC = "chatter_last_provision_error_total";
export const CHATTER_LAST_TURN_ERROR_TOTAL_METRIC = "chatter_last_turn_error_total";
export const MUMU_GIT_COMMIT_TOTAL_METRIC = "mumu_git_commit_total";
export const MUMU_GIT_PUSH_TOTAL_METRIC = "mumu_git_push_total";
export const MUMU_ARCHIVE_PROVISION_TOTAL_METRIC = "mumu_archive_provision_total";
export const MUMU_ARCHIVE_REPO_SIZE_BUCKET_TOTAL_METRIC = "mumu_archive_repo_size_bucket_total";
export const MUMU_ARCHIVE_LARGEST_TRACKED_FILE_SIZE_BUCKET_TOTAL_METRIC = "mumu_archive_largest_tracked_file_size_bucket_total";
export const MUMU_ARCHIVE_TURN_LOG_SIZE_BUCKET_TOTAL_METRIC = "mumu_archive_turn_log_size_bucket_total";
export const MUMU_ARCHIVE_LARGE_FILE_EXCLUDED_TOTAL_METRIC = "mumu_archive_large_file_excluded_total";

const readOnlyQueryCounters = new Map<string, number>();
const backgroundTriggerCounters = new Map<string, number>();
const selfInitiatedTurnCounters = new Map<string, number>();
const selfInitiatedTurnErrorCounters = new Map<string, number>();
const lastProvisionErrorCounters = new Map<string, number>();
const lastTurnErrorCounters = new Map<string, number>();
const mumuGitCommitCounters = new Map<string, number>();
const mumuGitPushCounters = new Map<string, number>();
const mumuArchiveProvisionCounters = new Map<string, number>();
const mumuArchivePressureCounters = new Map<string, number>();
let observationEvalErrorCounter = 0;
let mumuArchiveLargeFileExcludedCounter = 0;

export function incrementChatterReadOnlyQueryTotal(
  skill: string,
  status: ChatterReadOnlyQueryStatus
): void {
  const key = `${skill}|${status}`;
  readOnlyQueryCounters.set(key, (readOnlyQueryCounters.get(key) ?? 0) + 1);
}

export function snapshotChatterReadOnlyQueryCounters(): Record<string, number> {
  return Object.fromEntries([...readOnlyQueryCounters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function resetChatterReadOnlyQueryCountersForTests(): void {
  readOnlyQueryCounters.clear();
}

export function incrementChatterBackgroundTriggerTotal(
  triggerName: string,
  status: ChatterBackgroundTriggerStatus
): void {
  const key = `${triggerName}|${status}`;
  backgroundTriggerCounters.set(key, (backgroundTriggerCounters.get(key) ?? 0) + 1);
}

export function snapshotChatterBackgroundTriggerCounters(): Record<string, number> {
  return Object.fromEntries([...backgroundTriggerCounters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function resetChatterBackgroundTriggerCountersForTests(): void {
  backgroundTriggerCounters.clear();
}

export function incrementChatterSelfInitiatedTurnTotal(triggerName: string): void {
  selfInitiatedTurnCounters.set(
    triggerName,
    (selfInitiatedTurnCounters.get(triggerName) ?? 0) + 1
  );
}

export function incrementChatterSelfInitiatedTurnErrorTotal(triggerName: string): void {
  selfInitiatedTurnErrorCounters.set(
    triggerName,
    (selfInitiatedTurnErrorCounters.get(triggerName) ?? 0) + 1
  );
}

export function snapshotChatterSelfInitiatedTurnCounters(): Record<string, number> {
  return Object.fromEntries([...selfInitiatedTurnCounters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function snapshotChatterSelfInitiatedTurnErrorCounters(): Record<string, number> {
  return Object.fromEntries([...selfInitiatedTurnErrorCounters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function resetChatterSelfInitiatedTurnCountersForTests(): void {
  selfInitiatedTurnCounters.clear();
  selfInitiatedTurnErrorCounters.clear();
}

export function incrementChatterObservationEvalErrorTotal(): void {
  observationEvalErrorCounter += 1;
}

export function snapshotChatterObservationEvalErrorCounter(): number {
  return observationEvalErrorCounter;
}

export function resetChatterObservationEvalErrorCounterForTests(): void {
  observationEvalErrorCounter = 0;
}

export function incrementChatterLastProvisionErrorTotal(code: string): void {
  lastProvisionErrorCounters.set(code, (lastProvisionErrorCounters.get(code) ?? 0) + 1);
}

export function snapshotChatterLastProvisionErrorCounters(): Record<string, number> {
  return Object.fromEntries([...lastProvisionErrorCounters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function resetChatterLastProvisionErrorCountersForTests(): void {
  lastProvisionErrorCounters.clear();
}

export function incrementChatterLastTurnErrorTotal(code: string): void {
  lastTurnErrorCounters.set(code, (lastTurnErrorCounters.get(code) ?? 0) + 1);
}

export function snapshotChatterLastTurnErrorCounters(): Record<string, number> {
  return Object.fromEntries([...lastTurnErrorCounters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function resetChatterLastTurnErrorCountersForTests(): void {
  lastTurnErrorCounters.clear();
}

export function incrementMumuGitCommitTotal(kind: MumuGitCommitKind, status: MumuGitCommitStatus): void {
  incrementCounter(mumuGitCommitCounters, `${kind}|${status}`);
}

export function snapshotMumuGitCommitCounters(): Record<string, number> {
  return snapshotMap(mumuGitCommitCounters);
}

export function resetMumuGitCommitCountersForTests(): void {
  mumuGitCommitCounters.clear();
}

export function incrementMumuGitPushTotal(status: MumuGitPushStatus): void {
  incrementCounter(mumuGitPushCounters, status);
}

export function snapshotMumuGitPushCounters(): Record<string, number> {
  return snapshotMap(mumuGitPushCounters);
}

export function resetMumuGitPushCountersForTests(): void {
  mumuGitPushCounters.clear();
}

export function incrementMumuArchiveProvisionTotal(status: MumuArchiveProvisionStatus): void {
  incrementCounter(mumuArchiveProvisionCounters, status);
}

export function snapshotMumuArchiveProvisionCounters(): Record<string, number> {
  return snapshotMap(mumuArchiveProvisionCounters);
}

export function resetMumuArchiveProvisionCountersForTests(): void {
  mumuArchiveProvisionCounters.clear();
}

export function observeMumuArchivePressure(sample: MumuArchivePressureSample): void {
  incrementMumuArchivePressureBucket("repo_size", sample.repo_size_bytes);
  incrementMumuArchivePressureBucket("largest_tracked_file_size", sample.largest_tracked_file_bytes);
  incrementMumuArchivePressureBucket("turn_log_size", sample.turn_log_bytes_total);
  mumuArchiveLargeFileExcludedCounter += sample.large_file_excluded_count;
}

export function snapshotMumuArchivePressureCounters(): Record<string, number> {
  return {
    ...snapshotMap(mumuArchivePressureCounters),
    large_file_excluded_total: mumuArchiveLargeFileExcludedCounter
  };
}

export function resetMumuArchivePressureCountersForTests(): void {
  mumuArchivePressureCounters.clear();
  mumuArchiveLargeFileExcludedCounter = 0;
}

export function resetChatterObservabilityForTests(): void {
  resetChatterReadOnlyQueryCountersForTests();
  resetChatterBackgroundTriggerCountersForTests();
  resetChatterSelfInitiatedTurnCountersForTests();
  resetChatterObservationEvalErrorCounterForTests();
  resetChatterLastProvisionErrorCountersForTests();
  resetChatterLastTurnErrorCountersForTests();
  resetMumuGitCommitCountersForTests();
  resetMumuGitPushCountersForTests();
  resetMumuArchiveProvisionCountersForTests();
  resetMumuArchivePressureCountersForTests();
}

export function renderChatterPrometheusMetrics(): string {
  const lines: string[] = [
    "# TYPE chatter_self_initiated_turn_total counter",
    ...renderLabeledCounterMap(CHATTER_SELF_INITIATED_TURN_TOTAL_METRIC, "trigger_name", selfInitiatedTurnCounters),
    "# TYPE chatter_self_initiated_turn_error_total counter",
    ...renderLabeledCounterMap(CHATTER_SELF_INITIATED_TURN_ERROR_TOTAL_METRIC, "trigger_name", selfInitiatedTurnErrorCounters),
    "# TYPE chatter_read_only_query_total counter",
    ...renderReadOnlyQueryCounters(),
    "# TYPE chatter_observation_eval_error_total counter",
    `${CHATTER_OBSERVATION_EVAL_ERROR_TOTAL_METRIC} ${observationEvalErrorCounter}`,
    "# TYPE chatter_last_provision_error_total counter",
    ...renderLabeledCounterMap(CHATTER_LAST_PROVISION_ERROR_TOTAL_METRIC, "code", lastProvisionErrorCounters),
    "# TYPE chatter_last_turn_error_total counter",
    ...renderLabeledCounterMap(CHATTER_LAST_TURN_ERROR_TOTAL_METRIC, "code", lastTurnErrorCounters),
    "# TYPE mumu_git_commit_total counter",
    ...renderMumuGitCommitCounters(),
    "# TYPE mumu_git_push_total counter",
    ...renderLabeledCounterMap(MUMU_GIT_PUSH_TOTAL_METRIC, "status", mumuGitPushCounters),
    "# TYPE mumu_archive_provision_total counter",
    ...renderLabeledCounterMap(MUMU_ARCHIVE_PROVISION_TOTAL_METRIC, "status", mumuArchiveProvisionCounters),
    "# TYPE mumu_archive_repo_size_bucket_total counter",
    ...renderMumuArchivePressureCounters("repo_size", MUMU_ARCHIVE_REPO_SIZE_BUCKET_TOTAL_METRIC),
    "# TYPE mumu_archive_largest_tracked_file_size_bucket_total counter",
    ...renderMumuArchivePressureCounters("largest_tracked_file_size", MUMU_ARCHIVE_LARGEST_TRACKED_FILE_SIZE_BUCKET_TOTAL_METRIC),
    "# TYPE mumu_archive_turn_log_size_bucket_total counter",
    ...renderMumuArchivePressureCounters("turn_log_size", MUMU_ARCHIVE_TURN_LOG_SIZE_BUCKET_TOTAL_METRIC),
    "# TYPE mumu_archive_large_file_excluded_total counter",
    `${MUMU_ARCHIVE_LARGE_FILE_EXCLUDED_TOTAL_METRIC} ${mumuArchiveLargeFileExcludedCounter}`
  ];
  return `${lines.join("\n")}\n`;
}

function renderReadOnlyQueryCounters(): string[] {
  return [...readOnlyQueryCounters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const [skill = "", status = ""] = key.split("|");
      return `${CHATTER_READ_ONLY_QUERY_TOTAL_METRIC}{skill="${escapeLabelValue(skill)}",status="${escapeLabelValue(status)}"} ${value}`;
    });
}

function renderLabeledCounterMap(metricName: string, labelName: string, counters: ReadonlyMap<string, number>): string[] {
  return [...counters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([labelValue, value]) => `${metricName}{${labelName}="${escapeLabelValue(labelValue)}"} ${value}`);
}

function renderMumuGitCommitCounters(): string[] {
  return [...mumuGitCommitCounters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const [kind = "", status = ""] = key.split("|");
      return `${MUMU_GIT_COMMIT_TOTAL_METRIC}{kind="${escapeLabelValue(kind)}",status="${escapeLabelValue(status)}"} ${value}`;
    });
}

function renderMumuArchivePressureCounters(kind: MumuArchivePressureKind, metricName: string): string[] {
  return [...mumuArchivePressureCounters.entries()]
    .filter(([key]) => key.startsWith(`${kind}|`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const bucket = key.split("|")[1] ?? "";
      return `${metricName}{bucket="${escapeLabelValue(bucket)}"} ${value}`;
    });
}

function incrementMumuArchivePressureBucket(kind: MumuArchivePressureKind, bytes: number): void {
  incrementCounter(mumuArchivePressureCounters, `${kind}|${sizeBucket(bytes)}`);
}

function sizeBucket(bytes: number): string {
  if (bytes <= 1024) {
    return "le_1kb";
  }
  if (bytes <= 10 * 1024) {
    return "le_10kb";
  }
  if (bytes <= 100 * 1024) {
    return "le_100kb";
  }
  if (bytes <= 1024 * 1024) {
    return "le_1mb";
  }
  if (bytes <= 10 * 1024 * 1024) {
    return "le_10mb";
  }
  if (bytes <= 100 * 1024 * 1024) {
    return "le_100mb";
  }
  return "gt_100mb";
}

function incrementCounter(counters: Map<string, number>, key: string, by = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + by);
}

function snapshotMap(counters: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');
}
