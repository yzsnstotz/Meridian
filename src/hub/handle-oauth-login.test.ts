import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";
import { OAuthLoginJobRegistry } from "./oauth-login-registry";

function buildMessage(
  intent: string,
  callerId: string,
  payloadContent: object,
  authority: "read" | "write" | "admin" = "write"
) {
  return {
    trace_id: "00000000-0000-4000-8000-000000000004",
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

function makeRouter(credentialsRoot: string) {
  const store = new CredentialStore({ initialRecords: [], credentialsRoot });
  const reg = new OAuthLoginJobRegistry();
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    oauthLoginRegistry: reg
  });
  return { router, store, reg };
}

const FAKE = path.resolve("tests/fixtures/fake-codex-login.sh");

test("oauth_start returns job_id and registers an in-flight job", async () => {
  const { router } = makeRouter(fs.mkdtempSync(path.join(os.tmpdir(), "d4-")));
  const result = await router.route(
    buildMessage("register_credential_oauth_start", "c1", {
      credential_label: "work",
      codexLoginCommand: FAKE
    })
  );
  assert.equal(result.status, "success");
  const body = JSON.parse(result.content);
  assert.ok(body.job_id);
  assert.equal(body.status, "pending");
});

test("oauth_poll returns awaiting_browser with login_url after subprocess prints it", async () => {
  const { router } = makeRouter(fs.mkdtempSync(path.join(os.tmpdir(), "d4-")));
  const start = await router.route(
    buildMessage("register_credential_oauth_start", "c1", {
      credential_label: "work",
      codexLoginCommand: FAKE
    })
  );
  const { job_id } = JSON.parse(start.content);
  let polled: any;
  for (let i = 0; i < 100; i++) {
    const r = await router.route(
      buildMessage("register_credential_oauth_poll", "c1", { job_id })
    );
    polled = JSON.parse(r.content);
    if (polled.status === "awaiting_browser" || polled.status === "completed") break;
    await wait(50);
  }
  assert.ok(polled.login_url || polled.status === "completed");
});

test("oauth_poll rejects with credential_forbidden when caller is not job owner", async () => {
  const { router } = makeRouter(fs.mkdtempSync(path.join(os.tmpdir(), "d4-")));
  const start = await router.route(
    buildMessage("register_credential_oauth_start", "c1", {
      credential_label: "work",
      codexLoginCommand: FAKE
    })
  );
  const { job_id } = JSON.parse(start.content);
  const polled = await router.route(
    buildMessage("register_credential_oauth_poll", "c2", { job_id })
  );
  assert.notEqual(polled.status, "success");
  const body = JSON.parse(polled.content);
  assert.equal(body.error_code, "credential_forbidden");
});

test("oauth_poll allows admin even if not owner", async () => {
  const { router } = makeRouter(fs.mkdtempSync(path.join(os.tmpdir(), "d4-")));
  const start = await router.route(
    buildMessage("register_credential_oauth_start", "c1", {
      credential_label: "work",
      codexLoginCommand: FAKE
    })
  );
  const { job_id } = JSON.parse(start.content);
  const polled = await router.route(
    buildMessage("register_credential_oauth_poll", "admin-x", { job_id }, "admin")
  );
  assert.equal(polled.status, "success");
});

test("oauth_cancel cancels the job for owner", async () => {
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "30000";
  try {
    const { router, reg } = makeRouter(fs.mkdtempSync(path.join(os.tmpdir(), "d4-")));
    const start = await router.route(
      buildMessage("register_credential_oauth_start", "c1", {
        credential_label: "work",
        codexLoginCommand: FAKE
      })
    );
    const { job_id } = JSON.parse(start.content);
    for (let i = 0; i < 100; i++) {
      if (reg.get(job_id)?.status === "awaiting_browser") break;
      await wait(50);
    }
    const cancel = await router.route(
      buildMessage("register_credential_oauth_cancel", "c1", { job_id })
    );
    assert.equal(cancel.status, "success");
    assert.equal(reg.get(job_id)?.status, "cancelled");
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});

test("oauth_start returns 429-equivalent error when per-caller cap exceeded", async () => {
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "30000";
  try {
    const { router } = makeRouter(fs.mkdtempSync(path.join(os.tmpdir(), "d4-")));
    for (let i = 0; i < 3; i++) {
      await router.route(
        buildMessage("register_credential_oauth_start", "c1", {
          credential_label: `work-${i}`,
          codexLoginCommand: FAKE
        })
      );
    }
    const fourth = await router.route(
      buildMessage("register_credential_oauth_start", "c1", {
        credential_label: "work-4",
        codexLoginCommand: FAKE
      })
    );
    assert.notEqual(fourth.status, "success");
    const body = JSON.parse(fourth.content);
    assert.equal(body.error_code, "oauth_login_cap_exceeded");
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});
