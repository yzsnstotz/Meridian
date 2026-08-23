import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";

function buildMessage(intent: string, callerId: string, payloadContent: object, authority: "read" | "write" | "admin" = "write") {
  return {
    trace_id: "00000000-0000-4000-8000-000000000005",
    thread_id: "t1",
    actor_id: "a1",
    intent: intent as any,
    target: "global",
    mode: "stateless_call" as const,
    payload: { content: JSON.stringify(payloadContent), attachments: [] },
    reply_channel: { channel: "socket" as const, chat_id: "c1" },
    caller: { caller_id: callerId, caller_label: callerId, caller_authority: authority }
  };
}

async function setup() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "d5-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });
  const id = await store.createApiKey({
    credential_label: "k", owner_caller_id: "owner-1",
    base_url: "https://x/v1", model_id: "m", env_var: "OPENAI_API_KEY", key_value: "sk-1"
  });
  return { router, store, id };
}

test("update_credential by owner: changes label", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("update_credential", "owner-1", {
    credential_id: id, credential_label: "new-label"
  }));
  assert.equal(result.status, "success");
  assert.equal(store.get(id)?.credential_label, "new-label");
});

test("update_credential by non-owner non-admin: credential_forbidden", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("update_credential", "other", {
    credential_id: id, credential_label: "evil"
  }));
  assert.notEqual(result.status, "success");
  assert.equal(JSON.parse(result.content).error_code, "credential_forbidden");
  assert.equal(store.get(id)?.credential_label, "k"); // unchanged
});

test("update_credential by admin (not owner): allowed", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("update_credential", "admin-x", {
    credential_id: id, credential_label: "admin-set"
  }, "admin"));
  assert.equal(result.status, "success");
  assert.equal(store.get(id)?.credential_label, "admin-set");
});

test("update_credential with unknown id: credential_not_found", async () => {
  const { router } = await setup();
  const result = await router.route(buildMessage("update_credential", "owner-1", {
    credential_id: "does-not-exist", credential_label: "x"
  }));
  assert.notEqual(result.status, "success");
  assert.equal(JSON.parse(result.content).error_code, "credential_not_found");
});

test("set_default_credential by owner", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("set_default_credential", "owner-1", { credential_id: id }));
  assert.equal(result.status, "success");
  assert.equal(store.get(id)?.is_default, true);
});

test("set_default_credential by non-owner: forbidden", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("set_default_credential", "other", { credential_id: id }));
  assert.notEqual(result.status, "success");
  assert.equal(store.get(id)?.is_default, false);
});

test("revoke_credential by owner", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("revoke_credential", "owner-1", { credential_id: id }));
  assert.equal(result.status, "success");
  assert.ok(store.get(id)?.revoked_at);
});

test("revoke_credential by non-owner: forbidden", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("revoke_credential", "other", { credential_id: id }));
  assert.notEqual(result.status, "success");
  assert.equal(store.get(id)?.revoked_at, null);
});

test("revoke_credential by admin: allowed", async () => {
  const { router, store, id } = await setup();
  const result = await router.route(buildMessage("revoke_credential", "admin-x", { credential_id: id }, "admin"));
  assert.equal(result.status, "success");
  assert.ok(store.get(id)?.revoked_at);
});
