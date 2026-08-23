import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
process.env.ALLOWED_USER_IDS ??= "123456789";

import { HubServer } from "./server";

test("HubServer bootstrap wires a CredentialStore and OAuthLoginJobRegistry into the router", () => {
  // Constructing HubServer with no overrides exercises the bootstrap path that
  // creates a CredentialStore + OAuthLoginJobRegistry and threads them into HubRouter.
  const server = new HubServer();
  const router = server.getRouter();
  const store = router.getCredentialStore();
  const registry = router.getOAuthLoginRegistry();

  assert.ok(store, "CredentialStore should be wired into HubRouter");
  assert.ok(registry, "OAuthLoginJobRegistry should be wired into HubRouter");
  assert.equal(Array.isArray(store!.list()), true);
});

test("HubRouter wires CredentialStore.onChange to persistStateSafely (mutations land on disk immediately)", async () => {
  // Use HubRouter directly with an explicit statePath option. This avoids the
  // module-cached config.MERIDIAN_STATE_PATH problem and lets us assert the
  // wiring contract: any credential mutation must immediately flush to disk
  // via persistStateSafely.
  const { HubRouter } = await import("./router");
  const { InstanceRegistry } = await import("./registry");
  const { CredentialStore } = await import("./credential-store");

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-router-onchange-"));
  const statePath = path.join(tmpdir, "hub-state.json");
  const credentialsRoot = path.join(tmpdir, "credentials");
  fs.mkdirSync(credentialsRoot, { recursive: true });

  try {
    const store = new CredentialStore({ initialRecords: [], credentialsRoot });
    const router = new HubRouter(new InstanceRegistry(), {
      credentialStore: store,
      statePath
    });
    // initialize() writes an initial persisted state file.
    await router.initialize();

    // Drive a mutation directly through the live store. Without the onChange
    // wiring this would live only in memory and persistStateSafely (called only
    // by other intent handlers) would never see it until something unrelated
    // mutated state.
    const credId = await store.createApiKey({
      credential_label: "boot-onchange",
      owner_caller_id: "alice",
      base_url: "https://example.com/v1",
      model_id: "test-model",
      env_var: "TEST_KEY",
      key_value: "secret-xyz"
    });

    await new Promise((r) => setImmediate(r));

    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as { credentials?: Array<{ credential_id: string }> };
    const credentialsList = parsed.credentials ?? [];
    const ids = credentialsList.map((c) => c.credential_id);
    assert.ok(
      ids.includes(credId),
      `credential ${credId} should be in persisted state immediately after createApiKey. got: ${ids.join(",")}`
    );

    // And revoke should also flush.
    await store.revoke(credId);
    await new Promise((r) => setImmediate(r));
    const raw2 = fs.readFileSync(statePath, "utf8");
    const parsed2 = JSON.parse(raw2) as { credentials?: Array<{ credential_id: string; revoked_at: string | null }> };
    const found = (parsed2.credentials ?? []).find((c) => c.credential_id === credId);
    assert.ok(found, "credential should still be present after revoke");
    assert.ok(found!.revoked_at, "revoked_at must be set in persisted state");
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("HubServer bootstrap honors MERIDIAN_CREDENTIALS_ROOT override (via credentialsRoot option)", async () => {
  // The credentialsRoot option mirrors what MERIDIAN_CREDENTIALS_ROOT would
  // do at module-load time. Singleton config caching makes a direct env-var
  // test brittle; the option is the testable surface and is itself wired to
  // config.MERIDIAN_CREDENTIALS_ROOT in the no-option default path.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-creds-root-"));
  const customRoot = path.join(tmpdir, "custom-creds");
  fs.mkdirSync(customRoot, { recursive: true });
  try {
    const server = new HubServer({ credentialsRoot: customRoot });
    const router = server.getRouter();
    const store = router.getCredentialStore();
    assert.ok(store, "CredentialStore should be wired");
    // Create a credential and confirm its codex_home_path lives under customRoot.
    const id = await store!.createApiKey({
      credential_label: "k",
      owner_caller_id: "alice",
      base_url: "https://x/v1",
      model_id: "m",
      env_var: "K",
      key_value: "v"
    });
    const rec = store!.get(id);
    assert.ok(rec, "credential should be registered");
    assert.equal(
      rec!.codex_home_path.startsWith(customRoot),
      true,
      `codex_home_path must live under custom credentialsRoot. got: ${rec!.codex_home_path}`
    );
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("Credential rehydrate round-trip: createApiKey → persist via onChange → reconstruct CredentialStore from disk", async () => {
  // End-to-end test that a credential written through createApiKey survives a
  // simulated restart. Previously this test was a no-op because HubServer
  // reads its statePath from the module-cached config singleton. Drive the
  // CredentialStore + state-store layer directly — that's the actual
  // persistence contract that rehydration relies on.
  const { CredentialStore } = await import("./credential-store");
  const {
    buildPersistedHubState,
    savePersistedHubState,
    loadPersistedHubState
  } = await import("./state-store");

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-rehydrate-"));
  const statePath = path.join(tmpdir, "hub-state.json");
  const credentialsRoot = path.join(tmpdir, "credentials");
  fs.mkdirSync(credentialsRoot, { recursive: true });

  try {
    // ---- BOOT 1: empty store, wire onChange to flush hub-state.json ----
    const initialState = buildPersistedHubState(
      new Date().toISOString(),
      [],
      {},
      {},
      {},
      [],
      []
    );
    savePersistedHubState(statePath, initialState);

    const store1 = new CredentialStore({
      initialRecords: [],
      credentialsRoot,
      onChange: async (records) => {
        // Mirror what HubRouter.persistStateSafely does for the credentials slice.
        const current = loadPersistedHubState(statePath, new Date().toISOString());
        const next = buildPersistedHubState(
          new Date().toISOString(),
          current.instances ?? [],
          current.session_bindings ?? {},
          current.push_subscriptions ?? {},
          current.conversation_history ?? {},
          current.callers ?? [],
          records
        );
        savePersistedHubState(statePath, next);
      }
    });

    const idA = await store1.createApiKey({
      credential_label: "boot1-key",
      owner_caller_id: "alice",
      base_url: "https://api.example.com/v1",
      model_id: "gpt-rehydrate",
      env_var: "REHYDRATE_KEY",
      key_value: "sk-secret"
    });

    // Confirm hub-state.json on disk has the credential
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      credentials?: Array<{ credential_id: string; credential_label: string }>;
    };
    assert.ok(persisted.credentials, "credentials array must be present");
    assert.equal(persisted.credentials!.length, 1);
    assert.equal(persisted.credentials![0].credential_id, idA);
    assert.equal(persisted.credentials![0].credential_label, "boot1-key");

    // Confirm env.json was written on disk
    const credDirFromBoot1 = store1.get(idA)!.codex_home_path;
    const envOnDisk = JSON.parse(
      fs.readFileSync(path.join(credDirFromBoot1, "env.json"), "utf8")
    );
    assert.deepEqual(envOnDisk, { REHYDRATE_KEY: "sk-secret" });

    // ---- BOOT 2: simulated restart — load from disk, reconstruct store ----
    const reloaded = loadPersistedHubState(statePath, new Date().toISOString());
    const store2 = new CredentialStore({
      initialRecords: reloaded.credentials ?? [],
      credentialsRoot
    });

    // The seeded record must be present and resolvable.
    assert.equal(store2.list().length, 1);
    const rehydrated = store2.get(idA);
    assert.ok(rehydrated, "credential must rehydrate from persisted state");
    assert.equal(rehydrated!.credential_label, "boot1-key");
    assert.equal(rehydrated!.owner_caller_id, "alice");
    assert.equal(rehydrated!.kind, "api_key");
    assert.equal(rehydrated!.api_key_metadata?.model_id, "gpt-rehydrate");

    // resolve() must work end-to-end: read env.json off disk via the rehydrated record
    const resolved = store2.resolve(idA, {
      caller_id: "alice",
      caller_label: "alice",
      caller_authority: "write"
    });
    assert.ok(resolved, "resolve must return ResolvedCredential for owner");
    assert.equal(resolved!.credential_id, idA);
    assert.deepEqual(resolved!.env_overrides, { REHYDRATE_KEY: "sk-secret" });
    assert.equal(resolved!.codex_home, credDirFromBoot1);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("Credential rehydrate: ACL still enforced after rehydration (non-owner forbidden)", async () => {
  // After rehydration, the owner_caller_id field must still drive ACL.
  // Otherwise restart could silently dissolve ownership boundaries.
  const { CredentialStore, CredentialForbiddenError } = await import("./credential-store");
  const {
    buildPersistedHubState,
    savePersistedHubState,
    loadPersistedHubState
  } = await import("./state-store");

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-rehydrate-acl-"));
  const statePath = path.join(tmpdir, "hub-state.json");
  const credentialsRoot = path.join(tmpdir, "credentials");
  fs.mkdirSync(credentialsRoot, { recursive: true });
  savePersistedHubState(
    statePath,
    buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, [], [])
  );

  try {
    const store1 = new CredentialStore({
      initialRecords: [],
      credentialsRoot,
      onChange: async (records) => {
        const current = loadPersistedHubState(statePath, new Date().toISOString());
        savePersistedHubState(
          statePath,
          buildPersistedHubState(
            new Date().toISOString(),
            current.instances ?? [],
            current.session_bindings ?? {},
            current.push_subscriptions ?? {},
            current.conversation_history ?? {},
            current.callers ?? [],
            records
          )
        );
      }
    });
    const id = await store1.createApiKey({
      credential_label: "owned-by-alice",
      owner_caller_id: "alice",
      base_url: "https://x/v1",
      model_id: "m",
      env_var: "K",
      key_value: "v"
    });

    const reloaded = loadPersistedHubState(statePath, new Date().toISOString());
    const store2 = new CredentialStore({
      initialRecords: reloaded.credentials ?? [],
      credentialsRoot
    });
    assert.throws(
      () =>
        store2.resolve(id, {
          caller_id: "bob",
          caller_label: "bob",
          caller_authority: "write"
        }),
      CredentialForbiddenError
    );
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("HubServer bootstrap eagerly creates credentialsRoot directory with mode 0o700", () => {
  // Operators rely on the presence of this dir post-restart as a "the new code
  // actually shipped" signal. Without eager mkdir it only appears on first
  // credential write, which silently masked a broken rebuild on 2026-05-19.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-eager-creds-"));
  const credentialsRoot = path.join(tmpdir, "credentials-eager");
  assert.equal(fs.existsSync(credentialsRoot), false, "precondition: dir must not exist");
  try {
    const server = new HubServer({ credentialsRoot });
    // Touch the router so the bootstrap path is fully exercised (paranoia).
    server.getRouter();
    assert.equal(fs.existsSync(credentialsRoot), true, "credentialsRoot must exist post-boot");
    const st = fs.statSync(credentialsRoot);
    assert.equal(st.isDirectory(), true, "credentialsRoot must be a directory");
    // Permission bits check — only meaningful on POSIX. Skip the assertion on
    // platforms where mode bits aren't honored (e.g. Windows tests).
    if (process.platform !== "win32") {
      const mode = st.mode & 0o777;
      assert.equal(mode, 0o700, `credentialsRoot mode must be 0o700, got 0o${mode.toString(8)}`);
    }
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});
