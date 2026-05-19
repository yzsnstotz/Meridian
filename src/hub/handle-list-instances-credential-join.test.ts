import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";
import type { AgentInstance } from "../types";
import type { CredentialRecord } from "./state-store";

function makeInstance(threadId: string, credentialId: string | null): AgentInstance {
  return {
    thread_id: threadId,
    agent_type: "codex",
    mode: "stateless_call",
    pid: 1234,
    socket_path: `/tmp/${threadId}.sock`,
    status: "running",
    created_at: "2026-05-19T00:00:00.000Z",
    tmux_pane: null,
    credential_id: credentialId
  } as AgentInstance;
}

function makeCred(id: string, label: string, owner = "owner-1"): CredentialRecord {
  return {
    credential_id: id,
    credential_label: label,
    provider: "codex",
    kind: "oauth",
    owner_caller_id: owner,
    codex_home_path: `/tmp/${id}`,
    is_default: false,
    created_at: "2026-05-19T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    api_key_metadata: null
  };
}

function buildListMessage(callerId: string) {
  return {
    trace_id: "00000000-0000-4000-8000-000000000020",
    thread_id: "t1",
    actor_id: "a1",
    intent: "list" as const,
    target: "global",
    mode: "stateless_call" as const,
    payload: { content: "", attachments: [] },
    reply_channel: { channel: "socket" as const, chat_id: "c1" },
    caller: { caller_id: callerId, caller_label: callerId, caller_authority: "admin" as const }
  };
}

function parseList(content: string): any[] {
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.instances)) return parsed.instances;
  return [];
}

test("list response joins credential_label for instances with a credential_id", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "f4-"));
  const store = new CredentialStore({
    initialRecords: [makeCred("cred-A", "work-account")],
    credentialsRoot: tmpdir
  });
  const registry = new InstanceRegistry();
  registry.register(makeInstance("t1", "cred-A"));
  const router = new HubRouter(registry, { credentialStore: store });

  const result = await router.route(buildListMessage("admin-x") as any);
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  const list = parseList(result.content);
  const t1 = list.find((i: any) => i.thread_id === "t1");
  assert.ok(t1, `expected t1 in response, got: ${JSON.stringify(list)}`);
  assert.equal(t1.credential_id, "cred-A");
  assert.equal(t1.credential_label, "work-account");
});

test("list response has credential_label=null when instance has no credential_id (legacy)", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "f4-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const registry = new InstanceRegistry();
  registry.register(makeInstance("t1", null));
  const router = new HubRouter(registry, { credentialStore: store });

  const result = await router.route(buildListMessage("admin-x") as any);
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  const list = parseList(result.content);
  const t1 = list.find((i: any) => i.thread_id === "t1");
  assert.ok(t1, `expected t1 in response, got: ${JSON.stringify(list)}`);
  assert.equal(t1.credential_id, null);
  assert.equal(t1.credential_label, null);
});

test("list response has credential_label=null when credential was revoked/deleted", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "f4-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const registry = new InstanceRegistry();
  registry.register(makeInstance("t1", "cred-MISSING"));
  const router = new HubRouter(registry, { credentialStore: store });

  const result = await router.route(buildListMessage("admin-x") as any);
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  const list = parseList(result.content);
  const t1 = list.find((i: any) => i.thread_id === "t1");
  assert.ok(t1, `expected t1 in response, got: ${JSON.stringify(list)}`);
  assert.equal(t1.credential_id, "cred-MISSING");
  assert.equal(t1.credential_label, null);
});
