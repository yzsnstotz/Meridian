import type { ChatterObservationProposedPatch } from "../../types";
import {
  ChatterStateStore,
  type ChatterObservationCacheEntry
} from "./chatter-state-store";

const DEFAULT_OBSERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ObservationCacheOptions {
  now?: () => Date;
  ttlMs?: number;
}

export class ObservationCache {
  private readonly entries = new Map<string, ChatterObservationCacheEntry>();
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    private readonly store: ChatterStateStore,
    options: ObservationCacheOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_OBSERVATION_TTL_MS;
    this.rehydrate();
    this.evictExpired();
  }

  put(
    observationId: string,
    proposedPatch: ChatterObservationProposedPatch
  ): ChatterObservationCacheEntry {
    const entry: ChatterObservationCacheEntry = {
      proposed_patch: proposedPatch,
      created_at: this.now().toISOString(),
      ttl_ms: this.ttlMs
    };
    this.entries.set(observationId, entry);
    this.persist();
    return entry;
  }

  get(observationId: string): ChatterObservationCacheEntry | null {
    const entry = this.entries.get(observationId);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(observationId);
      this.persist();
      return null;
    }
    return entry;
  }

  evict(observationId: string): void {
    if (this.entries.delete(observationId)) {
      this.persist();
    }
  }

  evictExpired(): void {
    let changed = false;
    for (const [observationId, entry] of this.entries.entries()) {
      if (this.isExpired(entry)) {
        this.entries.delete(observationId);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  private rehydrate(): void {
    const observations = this.store.load().observations ?? {};
    this.entries.clear();
    for (const [observationId, entry] of Object.entries(observations)) {
      this.entries.set(observationId, entry);
    }
  }

  private isExpired(entry: ChatterObservationCacheEntry): boolean {
    return this.now().getTime() - Date.parse(entry.created_at) >= entry.ttl_ms;
  }

  private persist(): void {
    const observations = Object.fromEntries(this.entries.entries());
    this.store.save({
      ...this.store.load(),
      observations: Object.keys(observations).length > 0 ? observations : undefined
    });
  }
}
