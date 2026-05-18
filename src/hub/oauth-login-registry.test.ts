import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { OAuthLoginJobRegistry, OAuthLoginCapExceededError } from "./oauth-login-registry";
import { CredentialStore } from "./credential-store";

function makeJobOpts(store: CredentialStore, label: string) {
  return {
    credentialStore: store,
    owner_caller_id: "c1",
    credential_label: label,
    codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
    codexLoginArgs: [],
    timeoutMs: 30_000,
    urlCaptureWindowMs: 5_000
  };
}

test("registry.start returns {job_id, job} and registers the job", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-c5-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const registry = new OAuthLoginJobRegistry();
  const { job_id, job } = registry.start("c1", makeJobOpts(store, "a"));
  assert.ok(job_id);
  assert.equal(registry.get(job_id), job);
});

test("registry: caller c1 can start 3 concurrent jobs", () => {
  // Use a long auth.json delay so jobs stay in awaiting_browser
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "30000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-c5-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const registry = new OAuthLoginJobRegistry();
    const a = registry.start("c1", makeJobOpts(store, "a"));
    const b = registry.start("c1", makeJobOpts(store, "b"));
    const c = registry.start("c1", makeJobOpts(store, "c"));
    assert.ok(a.job_id && b.job_id && c.job_id);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});

test("registry: 4th concurrent job for same caller throws OAuthLoginCapExceededError", () => {
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "30000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-c5-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const registry = new OAuthLoginJobRegistry();
    registry.start("c1", makeJobOpts(store, "a"));
    registry.start("c1", makeJobOpts(store, "b"));
    registry.start("c1", makeJobOpts(store, "c"));
    assert.throws(() => registry.start("c1", makeJobOpts(store, "d")), OAuthLoginCapExceededError);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});

test("registry: caller c2 can start a job even when c1 is at cap", () => {
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "30000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-c5-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const registry = new OAuthLoginJobRegistry();
    registry.start("c1", makeJobOpts(store, "a"));
    registry.start("c1", makeJobOpts(store, "b"));
    registry.start("c1", makeJobOpts(store, "c"));
    const opts = { ...makeJobOpts(store, "d"), owner_caller_id: "c2" };
    const result = registry.start("c2", opts);
    assert.ok(result.job_id);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});

test("registry: completed/failed jobs don't count toward the cap (5th allowed once 1st completes)", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-c5-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const registry = new OAuthLoginJobRegistry();
  // First 3 with short delay to complete quickly
  const a = registry.start("c1", makeJobOpts(store, "a"));
  // wait for it to complete
  for (let i = 0; i < 100; i++) {
    if (a.job.status === "completed" || a.job.status === "failed") break;
    await wait(50);
  }
  assert.equal(a.job.status, "completed");

  // Now we have 1 completed, 0 in-flight. Should be able to start 3 more.
  // Use long delay so they stay awaiting_browser
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "30000";
  try {
    registry.start("c1", makeJobOpts(store, "b"));
    registry.start("c1", makeJobOpts(store, "c"));
    registry.start("c1", makeJobOpts(store, "d"));
    // 4th would be capped
    assert.throws(() => registry.start("c1", makeJobOpts(store, "e")), OAuthLoginCapExceededError);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});
