import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import { CallerRegistry, type CallerRecord } from "./caller-registry";
import {
  buildPersistedHubState,
  loadPersistedHubState,
  savePersistedHubState
} from "./state-store";

function makeFixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function fixedRandomBytes(byte: number): (size: number) => Buffer {
  return (size: number) => Buffer.alloc(size, byte);
}

function expectedKeyHash(cleartextKey: string, callerId: string): string {
  return crypto.createHash("sha256").update(cleartextKey + callerId).digest("hex");
}

test("mint creates an external record and returns the cleartext key once", () => {
  const persisted: CallerRecord[][] = [];
  const registry = new CallerRegistry({
    persist: (records) => persisted.push(records),
    now: makeFixedNow("2026-05-05T10:00:00.000Z"),
    randomBytes: fixedRandomBytes(0xab)
  });

  const { record, cleartextKey } = registry.mint({
    caller_id: "ext-1",
    caller_label: "External 1",
    kind: "external"
  });

  assert.equal(cleartextKey.length, 64);
  assert.equal(cleartextKey, "ab".repeat(32));
  assert.equal(record.caller_kind, "external");
  assert.equal(record.caller_id, "ext-1");
  assert.equal(record.caller_label, "External 1");
  assert.equal(record.key_hash, expectedKeyHash(cleartextKey, "ext-1"));
  assert.equal(record.created_at, "2026-05-05T10:00:00.000Z");
  assert.equal(record.last_seen_at, null);
  assert.equal(record.revoked_at, null);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.[0]?.caller_id, "ext-1");
});

test("mint throws when an id already exists (regardless of kind)", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  registry.mint({ caller_id: "dup", caller_label: "Dup", kind: "external" });
  assert.throws(
    () => registry.mint({ caller_id: "dup", caller_label: "Dup Two", kind: "external" }),
    /caller_already_exists/
  );

  const builtinRegistry = new CallerRegistry({ persist: () => {} });
  builtinRegistry.ensureBuiltin({
    caller_id: "builtin-1",
    caller_label: "Builtin",
    deriveKey: () => "deadbeef"
  });
  assert.throws(
    () => builtinRegistry.mint({ caller_id: "builtin-1", caller_label: "Builtin", kind: "external" }),
    /caller_already_exists/
  );
});

test("verify returns the record on correct key, null otherwise", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  const { cleartextKey } = registry.mint({
    caller_id: "ext-2",
    caller_label: "External 2",
    kind: "external"
  });

  const ok = registry.verify("ext-2", cleartextKey);
  assert.ok(ok);
  assert.equal(ok?.caller_id, "ext-2");

  assert.equal(registry.verify("ext-2", "wrong"), null);
  assert.equal(registry.verify("unknown", cleartextKey), null);
  assert.equal(registry.verify("unknown", ""), null);
});

test("verify uses crypto.timingSafeEqual on equal-length buffers", () => {
  const original = crypto.timingSafeEqual;
  let invocations = 0;
  let observedLengths: Array<[number, number]> = [];
  (crypto as { timingSafeEqual: typeof crypto.timingSafeEqual }).timingSafeEqual = (
    a: NodeJS.ArrayBufferView,
    b: NodeJS.ArrayBufferView
  ) => {
    invocations += 1;
    observedLengths.push([a.byteLength, b.byteLength]);
    return original(a, b);
  };
  try {
    const registry = new CallerRegistry({ persist: () => {} });
    const { cleartextKey } = registry.mint({
      caller_id: "ext-time",
      caller_label: "Time",
      kind: "external"
    });
    registry.verify("ext-time", cleartextKey);
    registry.verify("ext-time", "x".repeat(1));
    registry.verify("ext-time", "x".repeat(1024));
  } finally {
    (crypto as { timingSafeEqual: typeof crypto.timingSafeEqual }).timingSafeEqual = original;
  }
  assert.equal(invocations, 3);
  for (const [a, b] of observedLengths) {
    assert.equal(a, 32);
    assert.equal(b, 32);
  }
});

test("verify returns null for revoked callers even with the original key", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  const { cleartextKey } = registry.mint({
    caller_id: "ext-rev",
    caller_label: "Rev",
    kind: "external"
  });
  registry.revoke("ext-rev");
  assert.equal(registry.verify("ext-rev", cleartextKey), null);
});

test("rotate replaces the key and invalidates the old one", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  const minted = registry.mint({
    caller_id: "ext-rot",
    caller_label: "Rot",
    kind: "external"
  });
  assert.ok(registry.verify("ext-rot", minted.cleartextKey));

  const rotated = registry.rotate("ext-rot");
  assert.notEqual(rotated.cleartextKey, minted.cleartextKey);
  assert.equal(registry.verify("ext-rot", minted.cleartextKey), null);
  assert.ok(registry.verify("ext-rot", rotated.cleartextKey));
});

test("rotate clears revoked_at so a previously revoked caller is usable again", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  registry.mint({ caller_id: "ext-resurrect", caller_label: "R", kind: "external" });
  registry.revoke("ext-resurrect");
  const { cleartextKey, record } = registry.rotate("ext-resurrect");
  assert.equal(record.revoked_at, null);
  assert.ok(registry.verify("ext-resurrect", cleartextKey));
});

test("rotate throws on unknown id", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  assert.throws(() => registry.rotate("nope"), /caller_unknown/);
});

test("revoke sets revoked_at, preserves the slot, throws on unknown id", () => {
  const registry = new CallerRegistry({
    persist: () => {},
    now: makeFixedNow("2026-05-05T11:00:00.000Z")
  });
  registry.mint({ caller_id: "ext-revoke", caller_label: "RV", kind: "external" });
  const { revoked_at } = registry.revoke("ext-revoke");
  assert.equal(revoked_at, "2026-05-05T11:00:00.000Z");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("ext-revoke")?.revoked_at, "2026-05-05T11:00:00.000Z");
  assert.throws(() => registry.revoke("missing"), /caller_unknown/);
});

test("ensureBuiltin creates a builtin record on first call, idempotent on second", () => {
  const persisted: CallerRecord[][] = [];
  const registry = new CallerRegistry({
    persist: (records) => persisted.push(records),
    now: makeFixedNow("2026-05-05T12:00:00.000Z")
  });
  const first = registry.ensureBuiltin({
    caller_id: "meridian-cli",
    caller_label: "Meridian CLI",
    deriveKey: () => "derived-1"
  });
  assert.equal(first.caller_kind, "builtin");
  assert.equal(first.key_hash, expectedKeyHash("derived-1", "meridian-cli"));
  assert.equal(persisted.length, 1);

  const second = registry.ensureBuiltin({
    caller_id: "meridian-cli",
    caller_label: "Meridian CLI",
    deriveKey: () => "derived-1"
  });
  assert.equal(second.caller_id, "meridian-cli");
  assert.equal(persisted.length, 1, "no extra persistence when nothing changed");
});

test("ensureBuiltin updates the key hash when deriveKey rotates", () => {
  const persisted: CallerRecord[][] = [];
  const registry = new CallerRegistry({ persist: (records) => persisted.push(records) });
  registry.ensureBuiltin({
    caller_id: "meridian-web",
    caller_label: "Meridian Web",
    deriveKey: () => "old-derived"
  });
  const oldHash = registry.get("meridian-web")?.key_hash;
  registry.ensureBuiltin({
    caller_id: "meridian-web",
    caller_label: "Meridian Web",
    deriveKey: () => "new-derived"
  });
  const newHash = registry.get("meridian-web")?.key_hash;
  assert.notEqual(newHash, oldHash);
  assert.equal(newHash, expectedKeyHash("new-derived", "meridian-web"));
});

test("ensureBuiltin throws on collision with an external caller of the same id", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  registry.mint({ caller_id: "shared-id", caller_label: "External", kind: "external" });
  assert.throws(
    () =>
      registry.ensureBuiltin({
        caller_id: "shared-id",
        caller_label: "Builtin",
        deriveKey: () => "k"
      }),
    /caller_kind_collision/
  );
});

test("touchLastSeen writes the timestamp and is silent on unknown ids", () => {
  const persisted: CallerRecord[][] = [];
  const registry = new CallerRegistry({
    persist: (records) => persisted.push(records),
    now: makeFixedNow("2026-05-05T13:00:00.000Z")
  });
  registry.mint({ caller_id: "ext-seen", caller_label: "S", kind: "external" });
  const beforeWrites = persisted.length;
  registry.touchLastSeen("ext-seen");
  assert.equal(registry.get("ext-seen")?.last_seen_at, "2026-05-05T13:00:00.000Z");
  registry.touchLastSeen("ext-seen", "2026-05-05T13:30:00.000Z");
  assert.equal(registry.get("ext-seen")?.last_seen_at, "2026-05-05T13:30:00.000Z");
  registry.touchLastSeen("not-here");
  // Two successful writes after the mint, no write for the unknown id.
  assert.equal(persisted.length, beforeWrites + 2);
});

test("key_hash differs across caller_ids that share a cleartext key", () => {
  const sameKey = "0123456789abcdef".repeat(4);
  const hashA = expectedKeyHash(sameKey, "id-a");
  const hashB = expectedKeyHash(sameKey, "id-b");
  assert.notEqual(hashA, hashB);
});

test("persistence round-trip: register, save, reload, instantiate fresh registry", () => {
  const statePath = `/tmp/meridian-caller-registry-${process.pid}-${Date.now()}.json`;
  try {
    const initialState = buildPersistedHubState("2026-05-05T14:00:00.000Z", [], {});
    savePersistedHubState(statePath, initialState);
    let loaded = loadPersistedHubState(statePath, "2026-05-05T14:00:00.000Z");

    const persist = (records: CallerRecord[]): void => {
      loaded = { ...loaded, callers: records, updated_at: "2026-05-05T14:00:00.000Z" };
      savePersistedHubState(statePath, loaded);
    };

    const registry = new CallerRegistry({
      initialRecords: loaded.callers ?? [],
      persist,
      now: makeFixedNow("2026-05-05T14:00:00.000Z")
    });
    const { cleartextKey } = registry.mint({
      caller_id: "round-trip",
      caller_label: "RT",
      kind: "external"
    });
    registry.touchLastSeen("round-trip", "2026-05-05T14:05:00.000Z");

    const reloaded = loadPersistedHubState(statePath, "2026-05-05T14:00:00.000Z");
    const reopened = new CallerRegistry({
      initialRecords: reloaded.callers ?? [],
      persist: () => {}
    });
    const verified = reopened.verify("round-trip", cleartextKey);
    assert.ok(verified);
    assert.equal(verified?.last_seen_at, "2026-05-05T14:05:00.000Z");
  } finally {
    try {
      fs.unlinkSync(statePath);
    } catch {
      // best-effort cleanup
    }
  }
});

test("list and get return cloned records (mutating the result does not corrupt the registry)", () => {
  const registry = new CallerRegistry({ persist: () => {} });
  registry.mint({ caller_id: "ext-clone", caller_label: "C", kind: "external" });
  const fromList = registry.list()[0];
  assert.ok(fromList);
  fromList.key_hash = "tampered";
  fromList.caller_label = "tampered";
  assert.equal(registry.get("ext-clone")?.key_hash !== "tampered", true);
  assert.equal(registry.get("ext-clone")?.caller_label, "C");
});
