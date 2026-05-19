import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { CredentialRecordSchema, PersistedHubStateSchema, buildEmptyPersistedHubState, loadPersistedHubState } from "./state-store";

test("CredentialRecordSchema accepts a minimal OAuth credential", () => {
  const result = CredentialRecordSchema.safeParse({
    credential_id: "cred-1",
    credential_label: "work-account",
    provider: "codex",
    kind: "oauth",
    owner_caller_id: "caller-1",
    codex_home_path: "/home/u/.meridian/credentials/cred-1",
    created_at: "2026-05-19T00:00:00.000Z"
  });
  assert.equal(result.success, true);
});

test("CredentialRecordSchema rejects label longer than 64 chars", () => {
  const result = CredentialRecordSchema.safeParse({
    credential_id: "cred-1",
    credential_label: "x".repeat(65),
    provider: "codex",
    kind: "oauth",
    owner_caller_id: "caller-1",
    codex_home_path: "/tmp/x",
    created_at: "2026-05-19T00:00:00.000Z"
  });
  assert.equal(result.success, false);
});

test("CredentialRecordSchema accepts api_key kind with valid api_key_metadata", () => {
  const result = CredentialRecordSchema.safeParse({
    credential_id: "cred-1",
    credential_label: "openai",
    provider: "codex",
    kind: "api_key",
    owner_caller_id: "caller-1",
    codex_home_path: "/tmp/x",
    created_at: "2026-05-19T00:00:00.000Z",
    api_key_metadata: { base_url: "https://api.openai.com/v1", model_id: "gpt-4o", env_var: "OPENAI_API_KEY" }
  });
  assert.equal(result.success, true);
});

test("PersistedHubStateSchema (v4) defaults credentials to []", () => {
  const state = buildEmptyPersistedHubState("2026-05-19T00:00:00.000Z");
  assert.equal(state.version, 4);
  assert.deepEqual(state.credentials, []);
});

test("v3-shaped state should be rejected by current PersistedHubStateSchema (v4)", () => {
  const v3State = {
    version: 3,
    updated_at: "2026-05-01T00:00:00.000Z",
    instances: [], session_bindings: {}, push_subscriptions: {},
    conversation_history: {}, callers: []
  };
  const result = PersistedHubStateSchema.safeParse(v3State);
  assert.equal(result.success, false);
});

test("migrateLegacyPersistedHubState returns a valid v3 object (not v4)", async () => {
  const { PersistedHubStateV3Schema } = await import("./state-store");
  // We don't call the function directly (it's internal) — we just verify the schema is exported and validates v3 shape.
  const v3State = {
    version: 3, updated_at: "2026-05-01T00:00:00.000Z",
    instances: [], session_bindings: {}, push_subscriptions: {},
    conversation_history: {}, callers: []
  };
  const result = PersistedHubStateV3Schema.safeParse(v3State);
  assert.equal(result.success, true);
});

test("loading a v3 state file from disk upgrades it to v4 with empty credentials", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-state-mig-v3-v4-"));
  const statePath = path.join(tmpdir, "hub-state.json");
  const v3 = {
    version: 3,
    updated_at: "2026-05-01T00:00:00.000Z",
    instances: [],
    session_bindings: {},
    push_subscriptions: {},
    conversation_history: {},
    callers: [
      {
        caller_id: "c1",
        caller_label: "Caller One",
        caller_kind: "external",
        caller_authority: "write",
        key_hash: "h1",
        created_at: "2026-05-01T00:00:00.000Z",
        last_seen_at: null,
        revoked_at: null
      }
    ]
  };
  fs.writeFileSync(statePath, JSON.stringify(v3));
  const loaded = loadPersistedHubState(statePath, "2026-05-19T00:00:00.000Z");
  assert.equal(loaded.version, 4);
  assert.deepEqual(loaded.credentials, []);
  assert.equal(loaded.callers.length, 1);
  assert.equal(loaded.callers[0].caller_id, "c1");

  // Cleanup
  fs.rmSync(tmpdir, { recursive: true, force: true });
});
