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

test("RACE: cancel during tryComplete await does not leave a viable registered credential", async () => {
  // Reproduce the race where cancel() fires during the await inside tryComplete:
  //   credential_id = await completeOAuth(...)
  // If cancel runs while completeOAuth is awaiting onChange (the moment the
  // record has been inserted into the map but completeOAuth hasn't returned),
  // cancel() rm -rf's the slot dir (via abandonOAuthSlot) and then tryComplete
  // proceeds to set credential_id + status=completed.
  // Result: a registered, non-revoked CredentialRecord pointing at a deleted
  // directory.

  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "20"; // auth.json appears fast
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-race-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });

    // Stub completeOAuth to: do the real work, but yield control mid-flight so
    // we can fire cancel() before it returns. This reproduces the "await
    // completeOAuth" window in tryComplete deterministically.
    const realCompleteOAuth = store.completeOAuth.bind(store);
    let releaseAfterRecordInsert: () => void = () => {};
    const afterRecordInsertGate = new Promise<void>((resolve) => {
      releaseAfterRecordInsert = resolve;
    });
    let entered = false;
    store.completeOAuth = async (args) => {
      entered = true;
      // Run the real implementation up to and including record insertion.
      const id = await realCompleteOAuth(args);
      // Now yield so the test can fire cancel() before tryComplete sees `id`.
      await afterRecordInsertGate;
      return id;
    };

    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "racey",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 30_000,
      urlCaptureWindowMs: 5_000
    });
    await job.start();

    // Wait for the auth.json watcher to fire tryComplete and reach our gate.
    for (let i = 0; i < 200; i++) {
      if (entered) break;
      await wait(25);
    }
    assert.equal(entered, true, "completeOAuth must have been entered by tryComplete");

    // Now cancel. cleanup({deleteDir:true}) rm -rf's the slot dir.
    await job.cancel();
    assert.equal(job.status, "cancelled");

    // Release the gate so tryComplete resumes with the awaited credentialId.
    // Without a race guard it will overwrite status back to "completed" and
    // set credential_id on a record whose codex_home_path no longer exists.
    releaseAfterRecordInsert();

    // Let the resumed tryComplete settle.
    for (let i = 0; i < 50; i++) {
      await wait(20);
    }

    // POST-CONDITION: the job must NOT expose a viable (un-revoked) credential.
    // Either credential_id stays null, OR the registered record is marked revoked.
    if (job.credential_id) {
      const rec = store.get(job.credential_id);
      assert.ok(rec, "if credential_id was set, the record must exist");
      assert.ok(
        rec!.revoked_at,
        `registered credential after cancel must be revoked. Got revoked_at=${rec!.revoked_at}`
      );
      // codex_home_path must no longer exist on disk (cancel cleaned it up).
      assert.equal(
        fs.existsSync(rec!.codex_home_path),
        false,
        "codex_home_path should be gone after cancel"
      );
    }

    // Job's terminal status must be cancelled (not silently flipped to completed).
    assert.equal(
      job.status,
      "cancelled",
      `job status should remain cancelled, got ${job.status}`
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
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
