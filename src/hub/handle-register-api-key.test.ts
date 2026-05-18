import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";

function buildMessage(callerId: string, payloadContent: object) {
  return {
    trace_id: "00000000-0000-4000-8000-000000000002",
    thread_id: "t1",
    actor_id: "a1",
    intent: "register_credential_api_key" as const,
    target: "global",
    mode: "stateless_call" as const,
    payload: { content: JSON.stringify(payloadContent), attachments: [] },
    reply_channel: { channel: "socket" as const, chat_id: "c1" },
    caller: { caller_id: callerId, caller_label: callerId, caller_authority: "write" as const }
  };
}

test("register_credential_api_key creates a credential owned by the calling caller", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });

  const result = await router.route(buildMessage("c1", {
    credential_label: "openai-work",
    base_url: "https://api.openai.com/v1",
    model_id: "gpt-4o",
    env_var: "OPENAI_API_KEY",
    key_value: "sk-test"
  }));

  assert.equal(result.status, "success");
  const body = JSON.parse(result.content);
  assert.ok(body.credential_id);
  const rec = store.get(body.credential_id);
  assert.equal(rec?.owner_caller_id, "c1");
  assert.equal(rec?.credential_label, "openai-work");
  assert.equal(rec?.kind, "api_key");
});

test("register_credential_api_key ignores client-supplied owner_caller_id", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });

  const result = await router.route(buildMessage("real-caller", {
    credential_label: "evil",
    base_url: "https://x.com/v1",
    model_id: "m",
    env_var: "K",
    key_value: "v",
    owner_caller_id: "evil-spoof"
  }));

  assert.equal(result.status, "success");
  const body = JSON.parse(result.content);
  assert.equal(store.get(body.credential_id)?.owner_caller_id, "real-caller");
});

test("register_credential_api_key rejects payload missing required fields", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });

  const result = await router.route(buildMessage("c1", {
    credential_label: "only-label"
  }));
  assert.notEqual(result.status, "success");
});

test("register_credential_api_key rejects invalid base_url", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });

  const result = await router.route(buildMessage("c1", {
    credential_label: "k",
    base_url: "not-a-url",
    model_id: "m",
    env_var: "K",
    key_value: "v"
  }));
  assert.notEqual(result.status, "success");
});
