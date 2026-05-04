import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import { deriveBuiltinCallerKey, BUILTIN_CALLERS } from "./caller-bootstrap";

const EXPECTED_IDS = [
  "meridian-web",
  "meridian-cli",
  "meridian-telegram",
  "meridian-monitor",
  "meridian-admin",
] as const;

let savedBootstrapKey: string | undefined;

beforeEach(() => {
  savedBootstrapKey = process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY;
  process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-seed-value";
});

afterEach(() => {
  if (savedBootstrapKey === undefined) {
    delete process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY;
  } else {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = savedBootstrapKey;
  }
});

test("deriveBuiltinCallerKey is deterministic for same seed and id", () => {
  const key1 = deriveBuiltinCallerKey("meridian-web");
  const key2 = deriveBuiltinCallerKey("meridian-web");
  assert.equal(key1, key2);
  assert.match(key1, /^[0-9a-f]{64}$/);
});

test("deriveBuiltinCallerKey produces different keys for different caller ids", () => {
  const key1 = deriveBuiltinCallerKey("meridian-web");
  const key2 = deriveBuiltinCallerKey("meridian-cli");
  assert.notEqual(key1, key2);
});

test("deriveBuiltinCallerKey throws bootstrap_key_missing when env var is absent", () => {
  delete process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY;
  assert.throws(
    () => deriveBuiltinCallerKey("meridian-web"),
    (err: unknown) => err instanceof Error && err.message === "bootstrap_key_missing"
  );
});

test("deriveBuiltinCallerKey reads env var at call time, not at module load", () => {
  delete process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY;
  assert.throws(() => deriveBuiltinCallerKey("meridian-web"), /bootstrap_key_missing/);

  process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "late-seed";
  const key = deriveBuiltinCallerKey("meridian-web");
  assert.match(key, /^[0-9a-f]{64}$/);
});

test("BUILTIN_CALLERS contains exactly five entries", () => {
  assert.equal(BUILTIN_CALLERS.length, 5);
});

test("BUILTIN_CALLERS contains exactly the expected caller ids in order", () => {
  const ids = BUILTIN_CALLERS.map((c) => c.caller_id);
  assert.deepEqual(ids, EXPECTED_IDS);
});

test("BUILTIN_CALLERS includes meridian-admin", () => {
  const adminEntry = BUILTIN_CALLERS.find((c) => c.caller_id === "meridian-admin");
  assert.ok(adminEntry, "meridian-admin must be present");
  assert.equal(adminEntry.caller_label, "Meridian Admin");
});
