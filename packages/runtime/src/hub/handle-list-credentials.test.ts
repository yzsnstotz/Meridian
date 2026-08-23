import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";
import type { CredentialRecord } from "./state-store";

function makeRec(credential_id: string, owner: string, opts: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    credential_id,
    credential_label: credential_id,
    provider: "codex",
    kind: "oauth",
    owner_caller_id: owner,
    codex_home_path: `/tmp/${credential_id}`,
    is_default: false,
    created_at: "2026-05-19T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    api_key_metadata: null,
    ...opts
  };
}

function buildHubMessage(callerId: string, callerAuthority: "read" | "write" | "admin" = "write") {
  return {
    trace_id: "00000000-0000-4000-8000-000000000001",
    thread_id: "t1",
    actor_id: "a1",
    intent: "list_credentials" as const,
    target: "global",
    mode: "stateless_call" as const,
    payload: { content: "", attachments: [] },
    reply_channel: { channel: "socket" as const, chat_id: "c1" },
    caller: { caller_id: callerId, caller_label: callerId, caller_authority: callerAuthority }
  };
}

function extractList(result: any): any[] {
  // handleListCallers puts the JSON-serialized body in result.content;
  // handleListCredentials mirrors that contract.
  if (typeof result?.content === "string" && result.content.length > 0) {
    try {
      const parsed = JSON.parse(result.content);
      if (Array.isArray(parsed?.credentials)) return parsed.credentials;
    } catch {
      // fall through
    }
  }
  return (
    (result as any)?.credentials ??
    (result as any)?.payload?.credentials ??
    (result as any)?.data?.credentials ??
    []
  );
}

test("list_credentials returns only the calling caller's records when not admin", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "list-d2-"));
  const records: CredentialRecord[] = [
    makeRec("c-A", "owner-1"),
    makeRec("c-B", "owner-1"),
    makeRec("c-C", "owner-2")
  ];
  const store = new CredentialStore({ initialRecords: records, credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });

  const result = await router.route(buildHubMessage("owner-1"));

  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  const list = extractList(result);
  assert.ok(Array.isArray(list), `expected array in result, got: ${JSON.stringify(result)}`);
  assert.equal(list.length, 2);
  const ids = list.map((r: any) => r.credential_id).sort();
  assert.deepEqual(ids, ["c-A", "c-B"]);
});

test("list_credentials returns ALL records for admin caller", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "list-d2-"));
  const records: CredentialRecord[] = [
    makeRec("c-A", "owner-1"),
    makeRec("c-B", "owner-2"),
    makeRec("c-C", "owner-3")
  ];
  const store = new CredentialStore({ initialRecords: records, credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });

  const result = await router.route(buildHubMessage("admin-x", "admin"));
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  const list = extractList(result);
  assert.equal(list.length, 3);
});

test("list_credentials includes revoked records (with revoked_at populated)", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "list-d2-"));
  const records: CredentialRecord[] = [
    makeRec("c-rev", "owner-1", { revoked_at: "2026-05-18T00:00:00.000Z" })
  ];
  const store = new CredentialStore({ initialRecords: records, credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });
  const result = await router.route(buildHubMessage("owner-1"));
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  const list = extractList(result);
  assert.equal(list.length, 1);
  assert.ok(list[0].revoked_at);
});

test("list_credentials response strips secret material (no env.json content)", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "list-d2-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  await store.createApiKey({
    credential_label: "k",
    owner_caller_id: "owner-1",
    base_url: "https://api.x/v1",
    model_id: "m",
    env_var: "OPENAI_API_KEY",
    key_value: "sk-secret"
  });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });
  const result = await router.route(buildHubMessage("owner-1"));
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  const list = extractList(result);
  const serialized = JSON.stringify(list);
  assert.equal(serialized.includes("sk-secret"), false, "response leaked secret value");
  // Also assert against the full result content so we catch any other path that might carry the secret.
  assert.equal(
    typeof result.content === "string" ? result.content.includes("sk-secret") : false,
    false,
    "response.content leaked secret value"
  );
});
