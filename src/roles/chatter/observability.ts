export type ChatterReadOnlyQueryStatus = "ok" | "error" | "denied_skill";
export type ChatterBackgroundTriggerStatus = "scheduled" | "error";

const readOnlyQueryCounters = new Map<string, number>();
const backgroundTriggerCounters = new Map<string, number>();
const selfInitiatedTurnCounters = new Map<string, number>();
const selfInitiatedTurnErrorCounters = new Map<string, number>();

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
