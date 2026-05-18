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

test("FAIL: codex login exits non-zero before auth.json", async () => {
  const prev = process.env.FAKE_CODEX_FAIL;
  process.env.FAKE_CODEX_FAIL = "1";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-c4-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 5_000,
      urlCaptureWindowMs: 5_000
    });
    await job.start();
    for (let i = 0; i < 100; i++) {
      if (job.status === "failed") break;
      await wait(50);
    }
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "subprocess_exit");
    // dir was cleaned up
    assert.equal(fs.readdirSync(tmpdir).length, 0);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_FAIL;
    else process.env.FAKE_CODEX_FAIL = prev;
  }
});

test("CANCEL: cancel() during awaiting_browser cleans up", async () => {
  // Force a long auth.json delay so we have time to cancel between URL print and write
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "5000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-c4-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 30_000,
      urlCaptureWindowMs: 5_000
    });
    await job.start();
    // wait for awaiting_browser
    for (let i = 0; i < 100; i++) {
      if (job.status === "awaiting_browser") break;
      await wait(50);
    }
    assert.equal(job.status, "awaiting_browser");

    await job.cancel();
    assert.equal(job.status, "cancelled");
    // dir cleaned up
    await wait(100);
    assert.equal(fs.readdirSync(tmpdir).length, 0);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});

test("URL capture window: if URL not printed within window, status flips to failed with login_url_not_captured", async () => {
  // FAKE_CODEX_NO_URL=1 + small urlCaptureWindowMs
  const prev = process.env.FAKE_CODEX_NO_URL;
  process.env.FAKE_CODEX_NO_URL = "1";
  // also delay auth.json write so the urlCaptureWindow fires first
  const prev2 = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "5000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-c4-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 30_000,
      urlCaptureWindowMs: 300
    });
    await job.start();
    for (let i = 0; i < 50; i++) {
      if (job.status === "failed") break;
      await wait(50);
    }
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "login_url_not_captured");
    assert.equal(fs.readdirSync(tmpdir).length, 0);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_NO_URL;
    else process.env.FAKE_CODEX_NO_URL = prev;
    if (prev2 === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev2;
  }
});

test("TIMEOUT: timeoutMs while awaiting_browser flips to timeout", async () => {
  // Big auth.json delay, small timeout
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "5000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-c4-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 300,
      urlCaptureWindowMs: 1000
    });
    await job.start();
    for (let i = 0; i < 100; i++) {
      if (job.status === "timeout") break;
      await wait(50);
    }
    assert.equal(job.status, "timeout");
    assert.equal(fs.readdirSync(tmpdir).length, 0);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});
