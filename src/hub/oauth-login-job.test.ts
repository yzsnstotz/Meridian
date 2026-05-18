import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { OAuthLoginJob } from "./oauth-login-job";
import { CredentialStore } from "./credential-store";

test("OAuthLoginJob: happy path → awaiting_browser → completed", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-c3-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const job = new OAuthLoginJob({
    credentialStore: store,
    owner_caller_id: "c1",
    credential_label: "work",
    codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
    codexLoginArgs: [],
    timeoutMs: 10_000,
    urlCaptureWindowMs: 5_000
  });
  await job.start();

  // poll until URL captured (fake prints URL immediately)
  for (let i = 0; i < 100; i++) {
    if (job.status === "awaiting_browser") break;
    await wait(50);
  }
  assert.equal(job.status, "awaiting_browser");
  assert.equal(job.login_url, "https://chatgpt.com/auth/test");

  // poll until completion (fake writes auth.json after 200ms default)
  for (let i = 0; i < 200; i++) {
    if (job.status === "completed") break;
    await wait(50);
  }
  assert.equal(job.status, "completed");
  assert.ok(job.credential_id);
  const rec = store.get(job.credential_id!);
  assert.equal(rec?.credential_label, "work");
  assert.equal(rec?.kind, "oauth");
});
