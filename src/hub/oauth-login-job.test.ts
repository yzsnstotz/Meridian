import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { OAuthLoginJob, type OAuthLoginStatus } from "./oauth-login-job";
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
    if ((job.status as OAuthLoginStatus) === "completed") break;
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

test("POLL FALLBACK: tryComplete fires via the periodic poll even when the fs watcher is disabled", async () => {
  // fs.watch on Linux can drop events on certain kernel/fs combos. The poll
  // fallback (every pollIntervalMs while in pending/awaiting_browser) must
  // detect auth.json and drive completion to "completed" without the watcher
  // ever firing.
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "150"; // auth.json after 150ms
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-poll-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "poll-only",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 10_000,
      urlCaptureWindowMs: 5_000,
      pollIntervalMs: 100
    });
    await job.start();

    // Disable the fs watcher immediately so completion can only come from poll.
    (job as unknown as { watcher: { close: () => void } | null }).watcher?.close();
    (job as unknown as { watcher: null }).watcher = null;

    for (let i = 0; i < 100; i++) {
      if (job.status === "completed") break;
      await wait(50);
    }
    assert.equal(job.status, "completed", `expected completed via poll, got ${job.status}`);
    assert.ok(job.credential_id, "credential_id must be set");
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});

test("POLL FALLBACK: poll interval is cleared once job reaches a terminal state", async () => {
  // After completion the poll handle must be cleared so it doesn't keep the
  // process alive. We assert the handle is null/cleared after cleanup.
  const prev = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_DELAY_MS = "100";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-poll-clear-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 10_000,
      urlCaptureWindowMs: 5_000,
      pollIntervalMs: 100
    });
    await job.start();
    for (let i = 0; i < 100; i++) {
      if (job.status === "completed") break;
      await wait(50);
    }
    assert.equal(job.status, "completed");
    // pollHandle (private) must be null after cleanup.
    const handle = (job as unknown as { pollHandle: NodeJS.Timeout | null }).pollHandle;
    assert.equal(handle, null, "pollHandle must be cleared in cleanup()");
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prev;
  }
});

test("DEFAULTS: undefined codexLoginCommand/Args fall back to ['codex','login'] (not undefined)", () => {
  // Reproduces the stuck-pending bug where the hub router forwarded an unset
  // defaultCodexLoginCommand as `undefined`, and the constructor's
  // `{ ...defaults, ...opts }` spread overrode the default with `undefined`,
  // causing `spawn(undefined, ...)` to throw — which the registry's
  // fire-and-forget catch swallowed, leaving the GUI stuck on "pending".
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-defaults-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const job = new OAuthLoginJob({
    credentialStore: store,
    owner_caller_id: "c1",
    credential_label: "x",
    codexLoginCommand: undefined as unknown as string,
    codexLoginArgs: undefined as unknown as string[]
  });
  const opts = (job as unknown as { opts: { codexLoginCommand: string; codexLoginArgs: string[] } }).opts;
  assert.equal(opts.codexLoginCommand, "codex");
  assert.deepEqual(opts.codexLoginArgs, ["login"]);
});

test("RETRY: URL-capture timeout triggers respawn up to urlCaptureRetries+1 attempts", async () => {
  // codex CLI is observably flaky on stdio-piped login: occasionally produces
  // zero bytes for many seconds. The job must kill+respawn instead of failing
  // on the first window expiry. With urlCaptureRetries=2 the job should try
  // codex 3 times before giving up.
  const prevNoUrl = process.env.FAKE_CODEX_NO_URL;
  const prevDelay = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_NO_URL = "1";
  process.env.FAKE_CODEX_DELAY_MS = "10000"; // keep child alive past the window
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-retry-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 30_000,
      urlCaptureWindowMs: 200,
      urlCaptureRetries: 2
    });
    await job.start();
    for (let i = 0; i < 100; i++) {
      if (job.status === "failed") break;
      await wait(50);
    }
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "login_url_not_captured");
    assert.equal(job.attemptCount, 3, `expected 3 attempts, got ${job.attemptCount}`);
    assert.ok(
      job.error_message && /3 codex attempts/.test(job.error_message),
      `error_message should cite the attempt count, got: ${job.error_message}`
    );
  } finally {
    if (prevNoUrl === undefined) delete process.env.FAKE_CODEX_NO_URL;
    else process.env.FAKE_CODEX_NO_URL = prevNoUrl;
    if (prevDelay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prevDelay;
  }
});

test("RETRY: urlCaptureRetries=0 preserves single-attempt behavior for tests/callers that want it", async () => {
  const prevNoUrl = process.env.FAKE_CODEX_NO_URL;
  const prevDelay = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_NO_URL = "1";
  process.env.FAKE_CODEX_DELAY_MS = "10000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-noretry-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 30_000,
      urlCaptureWindowMs: 200,
      urlCaptureRetries: 0
    });
    await job.start();
    for (let i = 0; i < 50; i++) {
      if (job.status === "failed") break;
      await wait(50);
    }
    assert.equal(job.status, "failed");
    assert.equal(job.attemptCount, 1);
  } finally {
    if (prevNoUrl === undefined) delete process.env.FAKE_CODEX_NO_URL;
    else process.env.FAKE_CODEX_NO_URL = prevNoUrl;
    if (prevDelay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prevDelay;
  }
});

test("URL FRAGMENT: URL split across two stderr data events is still extracted", async () => {
  // Reproduces the prod symptom where a `data` chunk boundary fell inside
  // the URL string. The previous per-line splitter never saw a complete
  // URL on any one line and the job failed with `login_url_not_captured`
  // even though codex had emitted it. The tail-buffer-based extractor
  // must match URL across chunks.
  const prev = process.env.FAKE_CODEX_FRAGMENT_URL;
  const prevDelay = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_FRAGMENT_URL = "1";
  process.env.FAKE_CODEX_DELAY_MS = "5000"; // keep job in awaiting_browser
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-fragment-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "fragmented",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 30_000,
      urlCaptureWindowMs: 2_000
    });
    await job.start();
    for (let i = 0; i < 100; i++) {
      if (job.status === "awaiting_browser") break;
      await wait(50);
    }
    assert.equal(job.status, "awaiting_browser", `status=${job.status} error=${job.error_message}`);
    assert.equal(job.login_url, "https://chatgpt.com/auth/test");
    await job.cancel();
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_FRAGMENT_URL;
    else process.env.FAKE_CODEX_FRAGMENT_URL = prev;
    if (prevDelay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prevDelay;
  }
});

test("URL CAPTURE FAILURE: error_message includes recent codex output (self-diagnostic)", async () => {
  // When the URL-capture window expires, the failure message must surface
  // what codex actually printed so the operator can see the mismatch
  // without expanding the GUI <details> block.
  const prevNoUrl = process.env.FAKE_CODEX_NO_URL;
  const prevDelay = process.env.FAKE_CODEX_DELAY_MS;
  process.env.FAKE_CODEX_NO_URL = "1";
  process.env.FAKE_CODEX_DELAY_MS = "5000";
  try {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-snippet-"));
    const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
    const job = new OAuthLoginJob({
      credentialStore: store,
      owner_caller_id: "c1",
      credential_label: "x",
      codexLoginCommand: path.resolve("tests/fixtures/fake-codex-login.sh"),
      codexLoginArgs: [],
      timeoutMs: 30_000,
      urlCaptureWindowMs: 250
    });
    // Inject a stderr line via the fixture? The fixture currently emits no
    // output when FAKE_CODEX_NO_URL=1. Append a stderr writeable line by
    // using an env var the fixture interprets — for this test, just verify
    // the "no output captured" branch fires when codex prints nothing.
    await job.start();
    for (let i = 0; i < 100; i++) {
      if (job.status === "failed") break;
      await wait(50);
    }
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "login_url_not_captured");
    assert.ok(
      job.error_message && job.error_message.includes("no recognizable URL"),
      `error_message should mention URL capture failure, got: ${job.error_message}`
    );
    assert.ok(
      job.error_message && (job.error_message.includes("codex produced no output") || job.error_message.includes("Last codex output")),
      `error_message should be self-diagnostic, got: ${job.error_message}`
    );
  } finally {
    if (prevNoUrl === undefined) delete process.env.FAKE_CODEX_NO_URL;
    else process.env.FAKE_CODEX_NO_URL = prevNoUrl;
    if (prevDelay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = prevDelay;
  }
});

test("SPAWN ERROR: codex binary not on PATH → status=failed with subprocess_spawn_error (not stuck until url window)", async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-enoent-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const job = new OAuthLoginJob({
    credentialStore: store,
    owner_caller_id: "c1",
    credential_label: "x",
    codexLoginCommand: "/nonexistent/codex-binary-zzz-" + Date.now(),
    codexLoginArgs: ["login"],
    timeoutMs: 30_000,
    urlCaptureWindowMs: 10_000
  });
  await job.start();
  // ENOENT fires error event; must mark failed quickly, NOT wait for the
  // urlCaptureWindow.
  for (let i = 0; i < 50; i++) {
    if (job.status === "failed") break;
    await wait(20);
  }
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "subprocess_spawn_error");
  assert.ok(
    job.error_message && /ENOENT/.test(job.error_message),
    `error_message should mention ENOENT, got: ${job.error_message}`
  );
});

test("MARK STARTUP FAILURE: markStartupFailure flips a pending job to failed (so the GUI doesn't stall)", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-job-startup-fail-"));
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
  // Do NOT call start() — simulate a synchronous failure inside start().
  assert.equal(job.status, "pending");
  job.markStartupFailure("simulated spawn failure");
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "startup_failed");
  assert.equal(job.error_message, "simulated spawn failure");
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
