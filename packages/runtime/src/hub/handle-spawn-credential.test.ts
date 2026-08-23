import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";
import type { CredentialRecord } from "./state-store";
import type { HubMessage } from "../types";

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

interface SpawnCall {
  type: string;
  mode: string;
  workingDirectory?: string;
  modelId?: string;
  autoApprove?: boolean;
  reasoningEffort?: unknown;
  spawnTraceId?: string | null;
  integrationProfile?: string;
  sandboxMode?: unknown;
  caller?: unknown;
  resolvedCredential?: unknown;
}

function buildFakeInstanceManager(): { spy: SpawnCall[]; fake: any } {
  const spy: SpawnCall[] = [];
  const fake: any = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({
      version: 1,
      updated_at: new Date().toISOString(),
      instances: [],
      session_bindings: {}
    }),
    list: () => [],
    attach: () => ({ session: "s", thread_id: "t-1", previous_thread_id: null }),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true,
    getAttachedThread: () => null,
    spawn: async (
      type: string,
      mode: string,
      workingDirectory?: string,
      modelId?: string,
      autoApprove?: boolean,
      reasoningEffort?: unknown,
      spawnTraceId?: string | null,
      integrationProfile?: string,
      sandboxMode?: unknown,
      caller?: unknown,
      resolvedCredential?: unknown
    ) => {
      spy.push({
        type,
        mode,
        workingDirectory,
        modelId,
        autoApprove,
        reasoningEffort,
        spawnTraceId,
        integrationProfile,
        sandboxMode,
        caller,
        resolvedCredential
      });
      return "thread-stub-1";
    }
  };
  return { spy, fake };
}

function spawnMessage(callerId: string, credential_id?: string): HubMessage {
  const payload: any = { content: "", attachments: [] };
  if (credential_id !== undefined) payload.credential_id = credential_id;
  return {
    trace_id: "00000000-0000-4000-8000-000000000001",
    thread_id: "global",
    actor_id: "a1",
    intent: "spawn",
    target: "codex",
    mode: "stateless_call",
    payload,
    reply_channel: { channel: "socket", chat_id: "c1" },
    caller: { caller_id: callerId, caller_label: callerId, caller_authority: "write" }
  } as HubMessage;
}

function parseErrorContent(content: string): { error_code?: string; error_message?: string } {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

test("spawn with credential_id=undefined: instance-manager.spawn called with resolvedCredential=null/undefined", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cred-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const { spy, fake } = buildFakeInstanceManager();
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    instanceManager: fake,
    statePath: path.join(tmpdir, "state.json")
  });

  const result = await router.route(spawnMessage("owner-1"));
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(spy.length, 1, "instance-manager.spawn should have been called once");
  // resolvedCredential should be null (or undefined) when no credential_id was supplied.
  assert.ok(
    spy[0]!.resolvedCredential === null || spy[0]!.resolvedCredential === undefined,
    `expected resolvedCredential null/undefined, got: ${JSON.stringify(spy[0]!.resolvedCredential)}`
  );
});

test("spawn with credential_id=unknown: error_code=credential_not_found and spawn NOT called", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cred-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const { spy, fake } = buildFakeInstanceManager();
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    instanceManager: fake,
    statePath: path.join(tmpdir, "state.json")
  });

  const result = await router.route(spawnMessage("owner-1", "does-not-exist"));
  assert.equal(result.status, "error", `expected error, got: ${JSON.stringify(result)}`);
  const body = parseErrorContent(result.content);
  assert.equal(body.error_code, "credential_not_found");
  assert.equal(spy.length, 0, "instance-manager.spawn must NOT be called when credential resolution fails");
});

test("spawn with credential_id=revoked: error_code=credential_revoked", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cred-"));
  const store = new CredentialStore({
    initialRecords: [makeRec("c-rev", "owner-1", { revoked_at: "2026-05-18T00:00:00.000Z" })],
    credentialsRoot: tmpdir
  });
  const { spy, fake } = buildFakeInstanceManager();
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    instanceManager: fake,
    statePath: path.join(tmpdir, "state.json")
  });

  const result = await router.route(spawnMessage("owner-1", "c-rev"));
  assert.equal(result.status, "error");
  const body = parseErrorContent(result.content);
  assert.equal(body.error_code, "credential_revoked");
  assert.equal(spy.length, 0);
});

test("spawn with credential_id owned by another caller: error_code=credential_forbidden", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cred-"));
  const store = new CredentialStore({
    initialRecords: [makeRec("c-other", "owner-other")],
    credentialsRoot: tmpdir
  });
  const { spy, fake } = buildFakeInstanceManager();
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    instanceManager: fake,
    statePath: path.join(tmpdir, "state.json")
  });

  const result = await router.route(spawnMessage("owner-1", "c-other"));
  assert.equal(result.status, "error");
  const body = parseErrorContent(result.content);
  assert.equal(body.error_code, "credential_forbidden");
  assert.equal(spy.length, 0);
});

test("spawn with credential_id owned by caller: instance-manager.spawn called with resolvedCredential", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cred-"));
  // OAuth credentials do not require env.json on disk to resolve (only api_key kind does)
  const store = new CredentialStore({
    initialRecords: [makeRec("c-mine", "owner-1", { codex_home_path: path.join(tmpdir, "c-mine") })],
    credentialsRoot: tmpdir
  });
  const { spy, fake } = buildFakeInstanceManager();
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    instanceManager: fake,
    statePath: path.join(tmpdir, "state.json")
  });

  const result = await router.route(spawnMessage("owner-1", "c-mine"));
  assert.equal(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(spy.length, 1);
  const resolved = spy[0]!.resolvedCredential as { codex_home?: string; env_overrides?: Record<string, string>; credential_id?: string } | null | undefined;
  assert.ok(resolved, `expected resolvedCredential to be non-null, got: ${JSON.stringify(resolved)}`);
  assert.equal(resolved!.credential_id, "c-mine");
  assert.equal(resolved!.codex_home, path.join(tmpdir, "c-mine"));
  assert.deepEqual(resolved!.env_overrides, {});
});
