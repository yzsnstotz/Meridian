export type ChatterReadOnlyQueryStatus = "ok" | "error" | "denied_skill";

const readOnlyQueryCounters = new Map<string, number>();

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
