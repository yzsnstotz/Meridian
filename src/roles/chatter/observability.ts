export type ChatterReadOnlyQueryStatus = "ok" | "error" | "denied_skill";
export type ChatterBackgroundTriggerStatus = "scheduled" | "error";

export const CHATTER_SELF_INITIATED_TURN_TOTAL_METRIC = "chatter_self_initiated_turn_total";
export const CHATTER_SELF_INITIATED_TURN_ERROR_TOTAL_METRIC = "chatter_self_initiated_turn_error_total";
export const CHATTER_READ_ONLY_QUERY_TOTAL_METRIC = "chatter_read_only_query_total";
export const CHATTER_OBSERVATION_EVAL_ERROR_TOTAL_METRIC = "chatter_observation_eval_error_total";
export const CHATTER_LAST_PROVISION_ERROR_TOTAL_METRIC = "chatter_last_provision_error_total";
export const CHATTER_LAST_TURN_ERROR_TOTAL_METRIC = "chatter_last_turn_error_total";

const readOnlyQueryCounters = new Map<string, number>();
const backgroundTriggerCounters = new Map<string, number>();
const selfInitiatedTurnCounters = new Map<string, number>();
const selfInitiatedTurnErrorCounters = new Map<string, number>();
const lastProvisionErrorCounters = new Map<string, number>();
const lastTurnErrorCounters = new Map<string, number>();
let observationEvalErrorCounter = 0;

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

export function resetChatterObservabilityForTests(): void {
  resetChatterReadOnlyQueryCountersForTests();
  resetChatterBackgroundTriggerCountersForTests();
  resetChatterSelfInitiatedTurnCountersForTests();
  resetChatterObservationEvalErrorCounterForTests();
  resetChatterLastProvisionErrorCountersForTests();
  resetChatterLastTurnErrorCountersForTests();
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
    ...renderLabeledCounterMap(CHATTER_LAST_TURN_ERROR_TOTAL_METRIC, "code", lastTurnErrorCounters)
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

function escapeLabelValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');
}
