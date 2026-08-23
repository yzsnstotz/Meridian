import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialStore } from "./credential-store";
import type { CredentialRecord } from "./state-store";

test("CredentialStore.setOnChange installs an onChange callback that fires on mutation", async () => {
  const calls: CredentialRecord[][] = [];
  const store = new CredentialStore({
    initialRecords: [],
    credentialsRoot: "/tmp/non-existent-test-root-setOnChange"
  });
  store.setOnChange(async (records) => {
    calls.push(records);
  });

  // Trigger a mutation that goes through onChange. revoke() on a non-existent id
  // throws synchronously before onChange — use a path that always fires:
  // touchLastUsed() is private; the public mutations that fire onChange include
  // createApiKey, createOAuthSlot+completeOAuth, revoke, update, setDefault.
  // Use a contrived "register record + setDefault" sequence by injecting initial state.
  // Easier: just verify setOnChange exists and a real mutation fires.
  // Use a tmp dir to support createApiKey.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csp-"));

  const store2 = new CredentialStore({ initialRecords: [], credentialsRoot: tmpRoot });
  const calls2: CredentialRecord[][] = [];
  store2.setOnChange(async (records) => {
    calls2.push(records);
  });

  const id = await store2.createApiKey({
    credential_label: "test",
    owner_caller_id: "c1",
    base_url: "https://example.com/v1",
    model_id: "test-model",
    env_var: "OPENAI_API_KEY",
    key_value: "sk-test"
  });

  assert.ok(calls2.length >= 1, "onChange must fire on createApiKey");
  assert.equal(calls2[calls2.length - 1].length, 1);
  assert.equal(calls2[calls2.length - 1][0].credential_id, id);

  // Mutation #2: revoke should also fire onChange.
  const prevCallCount = calls2.length;
  await store2.revoke(id);
  assert.ok(calls2.length > prevCallCount, "onChange must fire on revoke");
});

test("CredentialStore.setOnChange replaces a previously-set callback", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csp2-"));

  let first = 0;
  let second = 0;
  const store = new CredentialStore({
    initialRecords: [],
    credentialsRoot: tmpRoot,
    onChange: () => { first += 1; }
  });
  store.setOnChange(() => { second += 1; });

  await store.createApiKey({
    credential_label: "t",
    owner_caller_id: "c1",
    base_url: "https://e.x/v1",
    model_id: "m",
    env_var: "K",
    key_value: "v"
  });

  assert.equal(first, 0, "previous onChange should not fire after setOnChange");
  assert.ok(second >= 1, "new onChange should fire");
});
