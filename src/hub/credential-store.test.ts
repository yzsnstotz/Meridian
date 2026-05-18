import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CredentialStore,
  CredentialNotFoundError,
  CredentialRevokedError,
  CredentialForbiddenError
} from "./credential-store";
import type { CredentialRecord } from "./state-store";
import type { CallerIdentity } from "../types";

function makeCaller(
  caller_id: string,
  caller_authority: "read" | "write" | "stateless_call" | "admin" = "write"
): CallerIdentity {
  return { caller_id, caller_label: caller_id, caller_authority };
}

function makeOAuth(
  credential_id: string,
  owner_caller_id: string,
  opts: Partial<CredentialRecord> = {}
): CredentialRecord {
  return {
    credential_id,
    credential_label: credential_id,
    provider: "codex",
    kind: "oauth",
    owner_caller_id,
    codex_home_path: `/tmp/${credential_id}`,
    is_default: false,
    created_at: "2026-05-19T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    api_key_metadata: null,
    ...opts
  };
}

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

test("resolve returns null when credential_id is null/undefined", () => {
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: "/tmp" });
  assert.equal(store.resolve(null, makeCaller("c1")), null);
  assert.equal(store.resolve(undefined, makeCaller("c1")), null);
});

test("resolve throws CredentialNotFoundError for unknown id", () => {
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: "/tmp" });
  assert.throws(
    () => store.resolve("missing", makeCaller("c1")),
    CredentialNotFoundError
  );
});

test("resolve throws CredentialRevokedError for revoked credential", () => {
  const rec = makeOAuth("c-rev", "c1", { revoked_at: "2026-05-18T00:00:00.000Z" });
  const store = new CredentialStore({ initialRecords: [rec], credentialsRoot: "/tmp" });
  assert.throws(
    () => store.resolve("c-rev", makeCaller("c1")),
    CredentialRevokedError
  );
});

test("resolve throws CredentialForbiddenError for non-owner non-admin", () => {
  const rec = makeOAuth("c-A", "owner-1");
  const store = new CredentialStore({ initialRecords: [rec], credentialsRoot: "/tmp" });
  assert.throws(
    () => store.resolve("c-A", makeCaller("other")),
    CredentialForbiddenError
  );
});

test("resolve succeeds for owner; OAuth returns codex_home + empty env_overrides", () => {
  const rec = makeOAuth("c-A", "owner-1");
  const store = new CredentialStore({ initialRecords: [rec], credentialsRoot: "/tmp" });
  const resolved = store.resolve("c-A", makeCaller("owner-1"));
  assert.deepEqual(resolved, {
    codex_home: "/tmp/c-A",
    env_overrides: {},
    credential_id: "c-A"
  });
});

test("resolve succeeds for admin even if owner mismatches", () => {
  const rec = makeOAuth("c-A", "owner-1");
  const store = new CredentialStore({ initialRecords: [rec], credentialsRoot: "/tmp" });
  const resolved = store.resolve("c-A", makeCaller("admin-x", "admin"));
  assert.equal(resolved?.credential_id, "c-A");
});

test("resolve for api_key returns env_overrides from env.json", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-b2-"));
  fs.writeFileSync(path.join(tmpdir, "env.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
  const rec: CredentialRecord = {
    credential_id: "c-K",
    credential_label: "k",
    provider: "codex",
    kind: "api_key",
    owner_caller_id: "owner-1",
    codex_home_path: tmpdir,
    is_default: false,
    created_at: "2026-05-19T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    api_key_metadata: {
      base_url: "https://x/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY"
    }
  };
  const store = new CredentialStore({ initialRecords: [rec], credentialsRoot: "/tmp" });
  const resolved = store.resolve("c-K", makeCaller("owner-1"));
  assert.deepEqual(resolved?.env_overrides, { OPENAI_API_KEY: "sk-test" });
});

test("createApiKey writes config.toml + env.json with 0600 perms and registers record", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b3-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "openai",
    owner_caller_id: "caller-1",
    base_url: "https://api.openai.com/v1",
    model_id: "gpt-4o",
    env_var: "OPENAI_API_KEY",
    key_value: "sk-test"
  });
  const rec = store.get(id);
  assert.ok(rec);
  assert.equal(rec!.kind, "api_key");
  assert.equal(rec!.owner_caller_id, "caller-1");
  assert.equal(rec!.api_key_metadata?.model_id, "gpt-4o");

  const envJson = JSON.parse(fs.readFileSync(path.join(rec!.codex_home_path, "env.json"), "utf8"));
  assert.deepEqual(envJson, { OPENAI_API_KEY: "sk-test" });

  const configToml = fs.readFileSync(path.join(rec!.codex_home_path, "config.toml"), "utf8");
  assert.match(configToml, /model = "gpt-4o"/);
  assert.match(configToml, /base_url = "https:\/\/api\.openai\.com\/v1"/);
  assert.match(configToml, /env_key = "OPENAI_API_KEY"/);

  const envStat = fs.statSync(path.join(rec!.codex_home_path, "env.json"));
  assert.equal(envStat.mode & 0o777, 0o600);
});

test("createApiKey rolls back dir and record on onChange failure", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b3-fail-"));
  const store = new CredentialStore({
    initialRecords: [],
    credentialsRoot: tmpdir,
    onChange: async () => { throw new Error("simulated persist failure"); }
  });
  await assert.rejects(() => store.createApiKey({
    credential_label: "openai", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "gpt-4o",
    env_var: "OPENAI_API_KEY", key_value: "sk-1"
  }));
  assert.equal(fs.readdirSync(tmpdir).length, 0); // dir removed
  assert.equal(store.list().length, 0);            // record removed
});

test("createApiKey escapes quotes in TOML values to prevent injection", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b3-esc-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "test",
    owner_caller_id: "c1",
    base_url: "https://x/v1",
    model_id: 'gpt"injected\\quote',
    env_var: "OPENAI_API_KEY",
    key_value: "sk-x"
  });
  const configToml = fs.readFileSync(
    path.join(store.get(id)!.codex_home_path, "config.toml"), "utf8"
  );
  assert.match(configToml, /model = "gpt\\"injected\\\\quote"/);
});

test("createOAuthSlot allocates dir but registers no record yet", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b4-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const slot = store.createOAuthSlot();
  assert.ok(fs.statSync(slot.codex_home).isDirectory());
  assert.equal(slot.codex_home.startsWith(tmpdir), true);
  assert.equal(store.list().length, 0);
  const stat = fs.statSync(slot.codex_home);
  assert.equal(stat.mode & 0o777, 0o700);
});

test("completeOAuth registers a record once auth.json is present and parseable", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b4-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const slot = store.createOAuthSlot();
  fs.writeFileSync(
    path.join(slot.codex_home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "x", refresh_token: "y" }, version: "1.0" })
  );
  const id = await store.completeOAuth({
    slot,
    credential_label: "work",
    owner_caller_id: "c1"
  });
  const rec = store.get(id);
  assert.ok(rec);
  assert.equal(rec!.kind, "oauth");
  assert.equal(rec!.owner_caller_id, "c1");
  assert.equal(rec!.credential_label, "work");
  assert.equal(rec!.codex_home_path, slot.codex_home);
  assert.equal(rec!.api_key_metadata, null);
  assert.equal(id, slot.credential_id);
});

test("completeOAuth rejects if auth.json is missing", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b4-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const slot = store.createOAuthSlot();
  await assert.rejects(() =>
    store.completeOAuth({ slot, credential_label: "x", owner_caller_id: "c1" })
  );
});

test("completeOAuth rejects if auth.json is malformed JSON", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b4-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const slot = store.createOAuthSlot();
  fs.writeFileSync(path.join(slot.codex_home, "auth.json"), "{not json");
  await assert.rejects(() =>
    store.completeOAuth({ slot, credential_label: "x", owner_caller_id: "c1" })
  );
});

test("abandonOAuthSlot removes the slot dir", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b4-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const slot = store.createOAuthSlot();
  assert.equal(fs.existsSync(slot.codex_home), true);
  store.abandonOAuthSlot(slot);
  assert.equal(fs.existsSync(slot.codex_home), false);
});

test("revoke removes dir, marks record revoked, and fires onChange", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b5-"));
  let changeCount = 0;
  const store = new CredentialStore({
    initialRecords: [],
    credentialsRoot: tmpdir,
    onChange: async () => { changeCount++; }
  });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v"
  });
  const dir = store.get(id)!.codex_home_path;
  const baseline = changeCount;
  await store.revoke(id);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(store.get(id)!.revoked_at);
  assert.equal(changeCount, baseline + 1);
});

test("revoke throws CredentialNotFoundError for unknown id", async () => {
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: "/tmp" });
  await assert.rejects(() => store.revoke("missing"), CredentialNotFoundError);
});

test("revoke is safe even if codex_home_path no longer exists on disk", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b5-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v"
  });
  // user deletes dir out-of-band first
  fs.rmSync(store.get(id)!.codex_home_path, { recursive: true, force: true });
  await store.revoke(id); // should not throw
  assert.ok(store.get(id)!.revoked_at);
});

test("update changes credential_label", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "old", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v"
  });
  await store.update(id, { credential_label: "new" });
  assert.equal(store.get(id)?.credential_label, "new");
});

test("update rewrites env.json atomically when key_value changes", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "m", env_var: "OPENAI_API_KEY", key_value: "sk-old"
  });
  await store.update(id, { key_value: "sk-new" });
  const env = JSON.parse(fs.readFileSync(path.join(store.get(id)!.codex_home_path, "env.json"), "utf8"));
  assert.equal(env.OPENAI_API_KEY, "sk-new");
  // ensure tmp file cleaned up
  assert.equal(fs.existsSync(path.join(store.get(id)!.codex_home_path, "env.json.tmp")), false);
});

test("update regenerates config.toml when model_id changes", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "gpt-4o", env_var: "OPENAI_API_KEY", key_value: "sk-v"
  });
  await store.update(id, { model_id: "gpt-4o-mini" });
  const toml = fs.readFileSync(path.join(store.get(id)!.codex_home_path, "config.toml"), "utf8");
  assert.match(toml, /model = "gpt-4o-mini"/);
  assert.equal(store.get(id)?.api_key_metadata?.model_id, "gpt-4o-mini");
});

test("update throws when trying to modify env on an oauth credential", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const slot = store.createOAuthSlot();
  fs.writeFileSync(path.join(slot.codex_home, "auth.json"), JSON.stringify({ tokens: {} }));
  const id = await store.completeOAuth({ slot, credential_label: "w", owner_caller_id: "c1" });
  await assert.rejects(() => store.update(id, { key_value: "sk-x" }));
});

test("update rejects immutable fields (credential_id, owner_caller_id, kind)", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v"
  });
  // @ts-expect-error testing runtime guard
  await assert.rejects(() => store.update(id, { owner_caller_id: "evil" }));
});

test("update throws for revoked credential", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v"
  });
  await store.revoke(id);
  await assert.rejects(() => store.update(id, { credential_label: "x" }), CredentialRevokedError);
});

test("setDefault flips is_default true on named record, clears others owned by same caller", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const a = await store.createApiKey({ credential_label: "a", owner_caller_id: "c1", base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v" });
  const b = await store.createApiKey({ credential_label: "b", owner_caller_id: "c1", base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v" });
  await store.setDefault(a);
  assert.equal(store.get(a)?.is_default, true);
  assert.equal(store.get(b)?.is_default, false);
  // flip to b
  await store.setDefault(b);
  assert.equal(store.get(a)?.is_default, false);
  assert.equal(store.get(b)?.is_default, true);
});

test("setDefault does NOT affect records owned by a different caller", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b6-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const a = await store.createApiKey({ credential_label: "a", owner_caller_id: "c1", base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v" });
  const b = await store.createApiKey({ credential_label: "b", owner_caller_id: "c2", base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v" });
  await store.setDefault(b); // c2's default
  await store.setDefault(a); // c1's default — must not touch c2's
  assert.equal(store.get(b)?.is_default, true);
  assert.equal(store.get(a)?.is_default, true);
});

test("reconcile removes dirs whose UUID is not in the registry", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b7-"));
  fs.mkdirSync(path.join(tmpdir, "orphan-uuid-1"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(tmpdir, "orphan-uuid-2"), { recursive: true, mode: 0o700 });
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  store.reconcile();
  assert.equal(fs.existsSync(path.join(tmpdir, "orphan-uuid-1")), false);
  assert.equal(fs.existsSync(path.join(tmpdir, "orphan-uuid-2")), false);
});

test("reconcile keeps dirs that match registered credentials", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b7-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "c1",
    base_url: "https://x/v1", model_id: "m", env_var: "K", key_value: "v"
  });
  const dir = store.get(id)!.codex_home_path;
  // Drop an orphan alongside
  fs.mkdirSync(path.join(tmpdir, "orphan"), { recursive: true });
  store.reconcile();
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(tmpdir, "orphan")), false);
});

test("reconcile is a no-op if credentialsRoot does not exist", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-root-b7-"));
  fs.rmSync(tmpdir, { recursive: true });
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  assert.doesNotThrow(() => store.reconcile());
});
