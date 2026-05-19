// End-to-end credential management tests.
// Boots a real WebInterfaceServer wired to a real HubRouter + CredentialStore
// + OAuthLoginJobRegistry via the routerOverride test seam, then exercises
// real HTTP endpoints for both functional flows and security regressions.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import type { HubMessage } from "../types";

// Process-wide env: must be set before importing the web server / hub modules.
process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
process.env.ALLOWED_USER_IDS ??= "123456789";
process.env.MERIDIAN_DISABLE_WEB_AUTOSTART = "true";
process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY ??= "test-bootstrap-key";

const webServerModulePromise = import("./server");
const hubRouterModulePromise = import("../hub/router");
const registryModulePromise = import("../hub/registry");
const credentialStoreModulePromise = import("../hub/credential-store");
const oauthRegistryModulePromise = import("../hub/oauth-login-registry");
const statePathModulePromise = import("../hub/state-store");

const FAKE_CODEX = path.resolve("tests/fixtures/fake-codex-login.sh");

const TOKEN = "secret-token";

interface RealHub {
  baseUrl: string;
  stop: () => Promise<void>;
  credentialsRoot: string;
  statePath: string;
  // Underlying router so individual tests can probe internals (test 6, 8, 9).
  router: any;
  credentialStore: any;
  oauthRegistry: any;
}

async function bootRealHub(): Promise<RealHub> {
  const { WebInterfaceServer } = await webServerModulePromise;
  const { HubRouter } = await hubRouterModulePromise;
  const { InstanceRegistry } = await registryModulePromise;
  const { CredentialStore } = await credentialStoreModulePromise;
  const { OAuthLoginJobRegistry } = await oauthRegistryModulePromise;
  // We intentionally do NOT pre-seed hub-state.json; loadPersistedHubState
  // tolerates a missing file and persistStateSafely will create one on demand
  // when the credential store mutates.

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-e2e-"));
  const credentialsRoot = path.join(tmpRoot, "credentials");
  await fs.promises.mkdir(credentialsRoot, { recursive: true });
  const statePath = path.join(tmpRoot, "hub-state.json");
  const staticDir = path.join(__dirname, "public");

  const credentialStore = new CredentialStore({
    initialRecords: [],
    credentialsRoot
  });
  const oauthRegistry = new OAuthLoginJobRegistry();

  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore,
    oauthLoginRegistry: oauthRegistry,
    statePath,
    // SERVER-SIDE seam: the spawned OAuth subprocess is the fake codex script.
    // The wire payload schema NEVER lets a caller override this — see test 7.
    defaultCodexLoginCommand: FAKE_CODEX,
    defaultCodexLoginArgs: []
  });

  const server = new WebInterfaceServer({
    enabled: true,
    port: 0,
    listenHost: "127.0.0.1",
    token: TOKEN,
    staticDir,
    routerOverride: router
  });
  await server.start();
  const addr = server.address();
  if (!addr) throw new Error("server failed to bind");

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    stop: async () => {
      await server.stop();
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    },
    credentialsRoot,
    statePath,
    router,
    credentialStore,
    oauthRegistry
  };
}

function headers(callerId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "X-Meridian-Caller-Id": callerId,
    "X-Meridian-Caller-Key": `${callerId}-key`
  };
}

async function createApiKey(
  baseUrl: string,
  callerId: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${baseUrl}/api/credentials/api-key`, {
    method: "POST",
    headers: headers(callerId),
    body: JSON.stringify(body)
  });
  return { status: resp.status, json: await resp.json() };
}

async function listCredentials(baseUrl: string, callerId: string): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${baseUrl}/api/credentials`, { headers: headers(callerId) });
  return { status: resp.status, json: await resp.json() };
}

// ---- Functional tests ----

test("E2E 1: API key happy path — create, list, revoke", async () => {
  const hub = await bootRealHub();
  try {
    const create = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "openai-work",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-e2e-1-test"
    });
    assert.equal(create.status, 201);
    const credId = create.json.credential_id;
    assert.ok(credId, `missing credential_id; got ${JSON.stringify(create.json)}`);

    const list1 = await listCredentials(hub.baseUrl, "alice");
    assert.equal(list1.status, 200);
    const visible = (list1.json.credentials ?? []).find((c: any) => c.credential_id === credId);
    assert.ok(visible, "created credential should be in list");
    assert.equal(visible.revoked_at, null);

    const del = await fetch(`${hub.baseUrl}/api/credentials/${credId}`, {
      method: "DELETE",
      headers: headers("alice")
    });
    assert.equal(del.status, 200);
    const delBody = await del.json();
    assert.equal(delBody.revoked, true);

    const list2 = await listCredentials(hub.baseUrl, "alice");
    const after = (list2.json.credentials ?? []).find((c: any) => c.credential_id === credId);
    assert.ok(after, "revoked credential still listed to owner");
    assert.ok(after.revoked_at, "revoked_at should be populated after DELETE");
  } finally {
    await hub.stop();
  }
});

test("E2E 2: OAuth happy path — start, poll to awaiting_browser then completed", async () => {
  // FAKE_CODEX writes auth.json after 200ms by default. Override with shorter
  // delays to keep this test fast and predictable.
  const prevDelay = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "120";
  const hub = await bootRealHub();
  try {
    const start = await fetch(`${hub.baseUrl}/api/credentials/oauth-login`, {
      method: "POST",
      headers: headers("alice"),
      body: JSON.stringify({ credential_label: "oauth-work" })
    });
    assert.equal(start.status, 202, `expected 202 got ${start.status}`);
    const startBody = await start.json();
    const jobId = startBody.job_id;
    assert.ok(jobId, "missing job_id");

    let pollBody: any = null;
    let sawAwaiting = false;
    for (let i = 0; i < 80; i++) {
      const poll = await fetch(`${hub.baseUrl}/api/credentials/oauth-login/${jobId}`, {
        headers: headers("alice")
      });
      assert.equal(poll.status, 200);
      pollBody = await poll.json();
      if (pollBody.status === "awaiting_browser") sawAwaiting = true;
      if (pollBody.status === "completed") break;
      await wait(50);
    }
    assert.ok(sawAwaiting || pollBody.status === "completed",
      `expected awaiting_browser or completed; final: ${JSON.stringify(pollBody)}`);
    assert.equal(pollBody.status, "completed", `final status: ${pollBody.status}; log: ${pollBody.log_excerpt}`);
    assert.ok(pollBody.credential_id, "completed job should expose credential_id");

    const list = await listCredentials(hub.baseUrl, "alice");
    const found = list.json.credentials.find((c: any) => c.credential_id === pollBody.credential_id);
    assert.ok(found, "completed oauth credential must be in caller's list");
    assert.equal(found.kind, "oauth");
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prevDelay;
    await hub.stop();
  }
});

test("E2E 3: PATCH renames credential label", async () => {
  const hub = await bootRealHub();
  try {
    const create = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "old-label",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-e2e-3"
    });
    assert.equal(create.status, 201);
    const credId = create.json.credential_id;

    const patch = await fetch(`${hub.baseUrl}/api/credentials/${credId}`, {
      method: "PATCH",
      headers: headers("alice"),
      body: JSON.stringify({ credential_label: "new-label" })
    });
    assert.equal(patch.status, 200);

    const list = await listCredentials(hub.baseUrl, "alice");
    const found = list.json.credentials.find((c: any) => c.credential_id === credId);
    assert.ok(found);
    assert.equal(found.credential_label, "new-label");
  } finally {
    await hub.stop();
  }
});

test("E2E 4: set default flips is_default on target and clears others", async () => {
  const hub = await bootRealHub();
  try {
    const a = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "one",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-e2e-4-a"
    });
    const b = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "two",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-e2e-4-b"
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const setDef = await fetch(`${hub.baseUrl}/api/credentials/${a.json.credential_id}/default`, {
      method: "POST",
      headers: headers("alice")
    });
    assert.equal(setDef.status, 200);
    const setBody = await setDef.json();
    assert.equal(setBody.is_default, true);

    const list = await listCredentials(hub.baseUrl, "alice");
    const ra = list.json.credentials.find((c: any) => c.credential_id === a.json.credential_id);
    const rb = list.json.credentials.find((c: any) => c.credential_id === b.json.credential_id);
    assert.equal(ra.is_default, true, "set credential should be default");
    assert.equal(rb.is_default, false, "other owned credential should be cleared");
  } finally {
    await hub.stop();
  }
});

test("E2E 5: list filters by owner; admin sees all", async () => {
  const hub = await bootRealHub();
  try {
    const a = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "alice-only",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-e2e-5-a"
    });
    const b = await createApiKey(hub.baseUrl, "bob", {
      credential_label: "bob-only",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-e2e-5-b"
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const aliceList = await listCredentials(hub.baseUrl, "alice");
    const aliceIds = aliceList.json.credentials.map((c: any) => c.credential_id).sort();
    assert.deepEqual(aliceIds, [a.json.credential_id].sort(), `alice saw: ${JSON.stringify(aliceIds)}`);

    const bobList = await listCredentials(hub.baseUrl, "bob");
    const bobIds = bobList.json.credentials.map((c: any) => c.credential_id).sort();
    assert.deepEqual(bobIds, [b.json.credential_id].sort(), `bob saw: ${JSON.stringify(bobIds)}`);

    const adminList = await listCredentials(hub.baseUrl, "meridian-admin");
    const adminIds = new Set(adminList.json.credentials.map((c: any) => c.credential_id));
    assert.ok(adminIds.has(a.json.credential_id), "admin sees alice's cred");
    assert.ok(adminIds.has(b.json.credential_id), "admin sees bob's cred");
  } finally {
    await hub.stop();
  }
});

test("E2E 6: spawn with bogus credential_id returns credential_not_found via router", async () => {
  const hub = await bootRealHub();
  try {
    const bogus = randomUUID();
    const spawnMsg: HubMessage = {
      trace_id: randomUUID(),
      thread_id: "pending",
      actor_id: "e2e-test",
      intent: "spawn",
      target: "codex",
      mode: "bridge",
      suppress_reply: true,
      payload: {
        content: "",
        attachments: [],
        reply_to: null,
        credential_id: bogus
      },
      reply_channel: { channel: "web", chat_id: "e2e" },
      caller: { caller_id: "alice", caller_label: "alice", caller_authority: "write" }
    } as any;
    const result = await hub.router.route(spawnMsg);
    assert.equal(result.status, "error");
    const body = JSON.parse(result.content);
    assert.equal(body.error_code, "credential_not_found",
      `expected credential_not_found, got ${JSON.stringify(body)}`);
  } finally {
    await hub.stop();
  }
});

// ---- Security regression tests ----

test("E2E 7 (B1 RCE): wire-supplied codexLoginCommand is IGNORED; safe default runs", async () => {
  // Sentinel: a path that does NOT exist on disk. If the router were to honor
  // the wire override, child_process.spawn would fail with ENOENT and the job
  // log buffer would never contain the fake-codex marker. We rely on the
  // fake-codex script printing a recognizable line which proves the SAFE
  // default ran (not /tmp/this-script-should-never-be-spawned-e2e.sh).
  const evilPath = "/tmp/this-script-should-never-be-spawned-e2e.sh";
  assert.equal(fs.existsSync(evilPath), false, "evil sentinel must not exist on disk");

  const hub = await bootRealHub();
  try {
    const start = await fetch(`${hub.baseUrl}/api/credentials/oauth-login`, {
      method: "POST",
      headers: headers("alice"),
      body: JSON.stringify({
        credential_label: "rce-attempt",
        codexLoginCommand: evilPath,
        codexLoginArgs: ["pwn"]
      })
    });
    // Strict schema may reject (400) or accept and silently drop (202).
    // Either is acceptable; what matters is the spawned command.
    assert.ok([202, 400].includes(start.status),
      `unexpected start status ${start.status}; body=${await start.text().catch(() => "")}`);

    if (start.status === 400) {
      // Strict mode rejected — that's the strongest possible defense. Done.
      return;
    }

    const startBody = await start.json();
    const jobId = startBody.job_id;

    // Poll until the fake-codex marker appears in the log buffer (or timeout).
    let evidence: any = null;
    for (let i = 0; i < 120; i++) {
      const poll = await fetch(`${hub.baseUrl}/api/credentials/oauth-login/${jobId}`, {
        headers: headers("alice")
      });
      assert.equal(poll.status, 200);
      evidence = await poll.json();
      const log = String(evidence.log_excerpt ?? "");
      if (log.includes("Open this URL to sign in") || log.includes("Logged in successfully") || evidence.status === "completed") {
        break;
      }
      await wait(50);
    }
    const finalLog = String(evidence?.log_excerpt ?? "");
    assert.ok(
      finalLog.includes("Open this URL to sign in") || finalLog.includes("Logged in successfully"),
      `B1 REGRESSION: fake-codex marker missing — evil command may have run. log=${finalLog}`
    );
    // Defense in depth: status must not be subprocess_exit / login_url_not_captured.
    if (evidence?.status === "failed") {
      assert.notEqual(evidence.error_code, "subprocess_exit",
        `B1 REGRESSION: subprocess_exit suggests evil path was spawned and failed: ${JSON.stringify(evidence)}`);
    }
  } finally {
    await hub.stop();
  }
});

test("E2E 8 (B2 regression): credentials persist across an in-memory CredentialStore restart", async () => {
  const { CredentialStore } = await credentialStoreModulePromise;
  const { loadPersistedHubState } = await statePathModulePromise;

  const hub = await bootRealHub();
  let credId: string;
  try {
    const create = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "persistent",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-persistence-e2e"
    });
    assert.equal(create.status, 201);
    credId = create.json.credential_id;
  } finally {
    // We deliberately keep the on-disk state and codex_home dirs by NOT
    // running hub.stop() (which rm -rf's the tmp root). We'll stop the
    // server separately, but we'll keep the paths and rebuild.
  }
  // Tear down server only; preserve credentialsRoot + statePath.
  // (we know stop() rms tmpRoot, so we read disk state BEFORE calling stop())
  const reloaded = loadPersistedHubState(hub.statePath, new Date().toISOString());
  assert.ok(Array.isArray(reloaded.credentials), "persisted state must have credentials array");
  const persisted = reloaded.credentials.find((c: any) => c.credential_id === credId);
  assert.ok(persisted, "credential must be present in on-disk hub-state.json (B2 regression)");

  // Rebuild a fresh CredentialStore from on-disk records and verify resolve() works.
  const store2 = new CredentialStore({
    initialRecords: reloaded.credentials,
    credentialsRoot: hub.credentialsRoot
  });
  const resolved = store2.resolve(credId, {
    caller_id: "alice",
    caller_label: "alice",
    caller_authority: "write"
  } as any);
  assert.ok(resolved, "rebuilt store must resolve persisted credential");
  assert.equal(resolved.credential_id, credId);
  // env_overrides MUST contain the API key — that's the load-bearing part of B2.
  assert.equal((resolved.env_overrides as any).OPENAI_API_KEY, "sk-persistence-e2e",
    "env_overrides must round-trip the secret value from disk");

  await hub.stop();
});

test("E2E 9 (I1 race): cancel during OAuth completion does not resurrect a usable credential", async () => {
  // Use a delayed fake-codex so we can cancel between awaiting_browser and
  // auth.json write — i.e. the window where completeOAuth() could race.
  const prevDelay = process.env.FAKE_CODEX_DELAY_MS;
  const prevUrlDelay = process.env.FAKE_CODEX_URL_DELAY_MS;
  process.env.FAKE_CODEX_URL_DELAY_MS = "20";
  process.env.FAKE_CODEX_DELAY_MS = "300";
  const hub = await bootRealHub();
  try {
    const start = await fetch(`${hub.baseUrl}/api/credentials/oauth-login`, {
      method: "POST",
      headers: headers("alice"),
      body: JSON.stringify({ credential_label: "race-test" })
    });
    assert.equal(start.status, 202);
    const { job_id } = await start.json();

    // Wait until awaiting_browser before issuing cancel (worst-case race window).
    for (let i = 0; i < 100; i++) {
      const poll = await fetch(`${hub.baseUrl}/api/credentials/oauth-login/${job_id}`, {
        headers: headers("alice")
      });
      const body = await poll.json();
      if (body.status === "awaiting_browser" || body.status === "completed") break;
      await wait(20);
    }
    const cancel = await fetch(`${hub.baseUrl}/api/credentials/oauth-login/${job_id}`, {
      method: "DELETE",
      headers: headers("alice")
    });
    assert.equal(cancel.status, 204);

    // Give the race a moment to settle (the spec target window is ~300ms).
    await wait(500);

    // Inspect the final job state. Either: cancelled (no credential_id) OR
    // completed-then-revoked. The credential, if any, must NOT be resolvable
    // (resolve() throws CredentialRevokedError or CredentialNotFoundError).
    const finalPoll = await fetch(`${hub.baseUrl}/api/credentials/oauth-login/${job_id}`, {
      headers: headers("alice")
    });
    const finalBody = await finalPoll.json();
    const credId = finalBody.credential_id;

    if (credId) {
      // Race fired and the late completeOAuth inserted a record. The race-guard
      // in oauth-login-job.ts MUST have revoked it.
      const store = hub.credentialStore;
      assert.throws(() => {
        store.resolve(credId, { caller_id: "alice", caller_label: "alice", caller_authority: "write" });
      }, /CredentialRevokedError|CredentialNotFoundError|credential (revoked|not found)/i,
        `I1 REGRESSION: late-completed credential ${credId} is resolvable after cancel`);
    }
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prevDelay;
    if (prevUrlDelay === undefined) delete process.env.FAKE_CODEX_URL_DELAY_MS;
    else process.env.FAKE_CODEX_URL_DELAY_MS = prevUrlDelay;
    await hub.stop();
  }
});

test("E2E 10: cross-caller access blocked — non-owner cannot DELETE/PATCH/set-default", async () => {
  const hub = await bootRealHub();
  try {
    const a = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "alice-x",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-cross-caller"
    });
    assert.equal(a.status, 201);
    const credId = a.json.credential_id;

    const del = await fetch(`${hub.baseUrl}/api/credentials/${credId}`, {
      method: "DELETE",
      headers: headers("bob")
    });
    assert.equal(del.status, 403, `expected 403 for bob DELETE; got ${del.status}`);

    const patch = await fetch(`${hub.baseUrl}/api/credentials/${credId}`, {
      method: "PATCH",
      headers: headers("bob"),
      body: JSON.stringify({ credential_label: "stolen" })
    });
    assert.equal(patch.status, 403, `expected 403 for bob PATCH; got ${patch.status}`);

    const def = await fetch(`${hub.baseUrl}/api/credentials/${credId}/default`, {
      method: "POST",
      headers: headers("bob")
    });
    assert.equal(def.status, 403, `expected 403 for bob set-default; got ${def.status}`);
  } finally {
    await hub.stop();
  }
});

test("E2E 11: admin can DELETE a credential owned by another caller", async () => {
  const hub = await bootRealHub();
  try {
    const a = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "alice-admin-target",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-admin-override"
    });
    assert.equal(a.status, 201);
    const credId = a.json.credential_id;

    const del = await fetch(`${hub.baseUrl}/api/credentials/${credId}`, {
      method: "DELETE",
      headers: headers("meridian-admin")
    });
    // Read the body ONCE so we can include it in a failure message and parse it.
    const delText = await del.text();
    assert.equal(del.status, 200, `admin DELETE failed: ${del.status} body=${delText}`);
    const body = JSON.parse(delText);
    assert.equal(body.revoked, true);
  } finally {
    await hub.stop();
  }
});

test("E2E 12: list/create response contains NO plaintext secret value", async () => {
  const hub = await bootRealHub();
  try {
    const secret = "sk-SECRET-VALUE-12345-DO-NOT-LEAK";
    const create = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "secret-check",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: secret
    });
    assert.equal(create.status, 201);
    const createRaw = JSON.stringify(create.json);
    assert.equal(createRaw.includes(secret), false,
      `POST response leaked secret: ${createRaw}`);

    const list = await fetch(`${hub.baseUrl}/api/credentials`, { headers: headers("alice") });
    const listRaw = await list.text();
    assert.equal(listRaw.includes(secret), false,
      `LIST response leaked secret: ${listRaw}`);
  } finally {
    await hub.stop();
  }
});

test("E2E 13: on-disk credential dir is mode 0700 and env.json is 0600", async () => {
  const hub = await bootRealHub();
  try {
    const create = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "perms-check",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-perms-e2e"
    });
    assert.equal(create.status, 201);
    const credId = create.json.credential_id;
    const dir = path.join(hub.credentialsRoot, credId);
    const dirStat = fs.statSync(dir);
    // Compare low 9 bits (rwx for user/group/other).
    assert.equal(dirStat.mode & 0o777, 0o700, `dir mode want 0700 got 0${(dirStat.mode & 0o777).toString(8)}`);

    const envStat = fs.statSync(path.join(dir, "env.json"));
    assert.equal(envStat.mode & 0o777, 0o600, `env.json mode want 0600 got 0${(envStat.mode & 0o777).toString(8)}`);
  } finally {
    await hub.stop();
  }
});

test("E2E 14: error messages do not leak credentials-root absolute paths", async () => {
  const hub = await bootRealHub();
  try {
    const create = await createApiKey(hub.baseUrl, "alice", {
      credential_label: "leak-test",
      base_url: "https://api.openai.com/v1",
      model_id: "gpt-4o",
      env_var: "OPENAI_API_KEY",
      key_value: "sk-leak-test"
    });
    assert.equal(create.status, 201);
    const credId = create.json.credential_id;

    // Out-of-band: remove the credential dir from disk, then trigger an update.
    fs.rmSync(path.join(hub.credentialsRoot, credId), { recursive: true, force: true });

    const patch = await fetch(`${hub.baseUrl}/api/credentials/${credId}`, {
      method: "PATCH",
      headers: headers("alice"),
      body: JSON.stringify({ key_value: "sk-new-secret-after-rm" })
    });
    // Whatever error code the handler returns, the error_message must not
    // include the absolute credentials-root path or the credential UUID dir.
    const body = await patch.text();
    const fullPath = path.join(hub.credentialsRoot, credId);
    assert.equal(body.includes(fullPath), false,
      `error response leaked absolute credentials path: ${body}`);
    // Also: should not include the user-identifying tmpdir prefix.
    assert.equal(body.includes(hub.credentialsRoot), false,
      `error response leaked credentials root prefix: ${body}`);
  } finally {
    await hub.stop();
  }
});

// ---- GUI structural tests ----

test("E2E 15: GET /accounts.html serves HTML with expected DOM markers", async () => {
  const hub = await bootRealHub();
  try {
    const resp = await fetch(`${hub.baseUrl}/accounts.html`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(resp.status, 200);
    const ct = resp.headers.get("content-type") ?? "";
    assert.ok(ct.startsWith("text/html"), `content-type was ${ct}`);
    const body = await resp.text();
    assert.match(body, /<h1[^>]*>.*Accounts/i, "missing <h1>...Accounts marker");
    assert.match(body, /<dialog[^>]*id="oauth-dialog"/, "missing oauth-dialog");
    assert.match(body, /<dialog[^>]*id="apikey-dialog"/, "missing apikey-dialog");
    // Accounts UI uses dialogs with input fields (no <form> element by design).
    // Assert the load-bearing apikey input + the action buttons instead.
    assert.match(body, /<input[^>]*id="apikey-key-input"/, "missing apikey-key-input");
    assert.match(body, /id="btn-add-oauth"/, "missing Add OAuth button");
    assert.match(body, /id="btn-add-apikey"/, "missing Add API Key button");
  } finally {
    await hub.stop();
  }
});

test("E2E 16: GET /accounts.js serves JS with expected function names", async () => {
  const hub = await bootRealHub();
  try {
    const resp = await fetch(`${hub.baseUrl}/accounts.js`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(resp.status, 200);
    const ct = resp.headers.get("content-type") ?? "";
    assert.ok(/javascript/.test(ct), `content-type was ${ct}`);
    const body = await resp.text();
    assert.match(body, /loadCredentials/, "missing loadCredentials function");
    assert.match(body, /revokeCredential/, "missing revokeCredential function");
  } finally {
    await hub.stop();
  }
});

test("E2E 17: GET /index.html includes the spawn credential dropdown markup", async () => {
  const hub = await bootRealHub();
  try {
    const resp = await fetch(`${hub.baseUrl}/index.html`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /id="spawn-credential"/, "missing #spawn-credential markup");
  } finally {
    await hub.stop();
  }
});

test("E2E 18: src/web/public/accounts.js parses successfully with node --check", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const jsPath = path.resolve("src/web/public/accounts.js");
  // node --check parses without executing; throws on syntax errors.
  await execFileP(process.execPath, ["--check", jsPath], { timeout: 10_000 });
});
