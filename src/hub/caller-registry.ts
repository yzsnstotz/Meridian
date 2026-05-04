import crypto from "node:crypto";

import { type CallerRecord } from "./state-store";

export type { CallerRecord };

export type CallerRegistryPersist = (records: CallerRecord[]) => void;

export interface CallerRegistryOptions {
  initialRecords?: CallerRecord[];
  persist: CallerRegistryPersist;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

export interface MintResult {
  record: CallerRecord;
  cleartextKey: string;
}

export interface RevokeResult {
  revoked_at: string;
}

function computeKeyHash(cleartextKey: string, callerId: string): string {
  return crypto.createHash("sha256").update(cleartextKey + callerId).digest("hex");
}

function cloneRecord(record: CallerRecord): CallerRecord {
  return { ...record };
}

export class CallerRegistry {
  private readonly records: Map<string, CallerRecord>;
  private readonly persistFn: CallerRegistryPersist;
  private readonly nowFn: () => Date;
  private readonly randomBytesFn: (size: number) => Buffer;

  constructor(options: CallerRegistryOptions) {
    this.persistFn = options.persist;
    this.nowFn = options.now ?? (() => new Date());
    this.randomBytesFn = options.randomBytes ?? ((size: number) => crypto.randomBytes(size));
    this.records = new Map();
    for (const record of options.initialRecords ?? []) {
      this.records.set(record.caller_id, cloneRecord(record));
    }
  }

  list(): CallerRecord[] {
    return Array.from(this.records.values()).map(cloneRecord);
  }

  get(callerId: string): CallerRecord | null {
    const record = this.records.get(callerId);
    return record ? cloneRecord(record) : null;
  }

  mint(args: { caller_id: string; caller_label: string; kind: "external" }): MintResult {
    if (this.records.has(args.caller_id)) {
      throw new Error(`caller_already_exists: ${args.caller_id}`);
    }
    const cleartextKey = this.generateCleartextKey();
    const record: CallerRecord = {
      caller_id: args.caller_id,
      caller_label: args.caller_label,
      caller_kind: "external",
      key_hash: computeKeyHash(cleartextKey, args.caller_id),
      created_at: this.nowIso(),
      last_seen_at: null,
      revoked_at: null
    };
    this.records.set(record.caller_id, record);
    this.persist();
    return { record: cloneRecord(record), cleartextKey };
  }

  rotate(callerId: string): MintResult {
    const existing = this.records.get(callerId);
    if (!existing) {
      throw new Error(`caller_unknown: ${callerId}`);
    }
    const cleartextKey = this.generateCleartextKey();
    existing.key_hash = computeKeyHash(cleartextKey, callerId);
    existing.revoked_at = null;
    this.persist();
    return { record: cloneRecord(existing), cleartextKey };
  }

  revoke(callerId: string): RevokeResult {
    const existing = this.records.get(callerId);
    if (!existing) {
      throw new Error(`caller_unknown: ${callerId}`);
    }
    const revokedAt = this.nowIso();
    existing.revoked_at = revokedAt;
    this.persist();
    return { revoked_at: revokedAt };
  }

  verify(callerId: string, cleartextKey: string): CallerRecord | null {
    const record = this.records.get(callerId);
    if (!record) {
      return null;
    }
    if (record.revoked_at !== null) {
      return null;
    }
    const candidateHash = computeKeyHash(cleartextKey, callerId);
    const candidateBuffer = Buffer.from(candidateHash, "hex");
    const storedBuffer = Buffer.from(record.key_hash, "hex");
    if (candidateBuffer.length !== storedBuffer.length) {
      return null;
    }
    if (!crypto.timingSafeEqual(candidateBuffer, storedBuffer)) {
      return null;
    }
    return cloneRecord(record);
  }

  ensureBuiltin(args: {
    caller_id: string;
    caller_label: string;
    deriveKey: () => string;
  }): CallerRecord {
    const existing = this.records.get(args.caller_id);
    if (existing) {
      if (existing.caller_kind === "external") {
        throw new Error(`caller_kind_collision: ${args.caller_id} is external`);
      }
      const expectedHash = computeKeyHash(args.deriveKey(), args.caller_id);
      let mutated = false;
      if (existing.key_hash !== expectedHash) {
        existing.key_hash = expectedHash;
        mutated = true;
      }
      if (existing.caller_label !== args.caller_label) {
        existing.caller_label = args.caller_label;
        mutated = true;
      }
      if (existing.revoked_at !== null) {
        existing.revoked_at = null;
        mutated = true;
      }
      if (mutated) {
        this.persist();
      }
      return cloneRecord(existing);
    }
    const record: CallerRecord = {
      caller_id: args.caller_id,
      caller_label: args.caller_label,
      caller_kind: "builtin",
      key_hash: computeKeyHash(args.deriveKey(), args.caller_id),
      created_at: this.nowIso(),
      last_seen_at: null,
      revoked_at: null
    };
    this.records.set(record.caller_id, record);
    this.persist();
    return cloneRecord(record);
  }

  touchLastSeen(callerId: string, now?: string): void {
    const existing = this.records.get(callerId);
    if (!existing) {
      return;
    }
    existing.last_seen_at = now ?? this.nowIso();
    this.persist();
  }

  private generateCleartextKey(): string {
    return this.randomBytesFn(32).toString("hex");
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }

  private persist(): void {
    const snapshot = Array.from(this.records.values()).map(cloneRecord);
    this.persistFn(snapshot);
  }
}
