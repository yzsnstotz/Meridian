import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialStore } from "./credential-store";

test("CredentialStore.list returns empty when registry is empty", () => {
  const store = new CredentialStore({
    initialRecords: [],
    credentialsRoot: "/tmp/test-creds-b1"
  });
  assert.deepEqual(store.list(), []);
});

test("CredentialStore.get returns undefined for unknown id", () => {
  const store = new CredentialStore({
    initialRecords: [],
    credentialsRoot: "/tmp/test-creds-b1"
  });
  assert.equal(store.get("missing"), undefined);
});

test("CredentialStore.list returns the records seeded at construction", () => {
  const rec = {
    credential_id: "c-A",
    credential_label: "Test",
    provider: "codex" as const,
    kind: "oauth" as const,
    owner_caller_id: "caller-1",
    codex_home_path: "/tmp/c-A",
    is_default: false,
    created_at: "2026-05-19T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    api_key_metadata: null
  };
  const store = new CredentialStore({
    initialRecords: [rec],
    credentialsRoot: "/tmp/test-creds-b1"
  });
  assert.equal(store.list().length, 1);
  assert.equal(store.get("c-A")?.credential_id, "c-A");
});
