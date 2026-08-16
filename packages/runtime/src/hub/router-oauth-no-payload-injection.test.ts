import { test } from "node:test";
import assert from "node:assert/strict";
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
    trace_id: "00000000-0000-4000-8000-000000000099",
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

const FAKE = path.resolve("tests/fixtures/fake-codex-login.sh");

test("oauth-login start IGNORES codexLoginCommand in payload (security regression test)", async () => {
  const credentialsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rce-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot });
  const reg = new OAuthLoginJobRegistry();
  // Construct WITHOUT the defaultCodexLoginCommand override — production path.
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    oauthLoginRegistry: reg
  });

  // Sentinel file: if the malicious command is spawned it will write here.
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "rce-sentinel-"));
  const sentinel = path.join(sentinelDir, "PWNED");
  const evilScriptPath = path.join(sentinelDir, "evil.sh");
  fs.writeFileSync(
    evilScriptPath,
    `#!/bin/sh\ntouch "${sentinel}"\necho "if this ran we have RCE"\n`,
    { mode: 0o700 }
  );

  const result = await router.route(
    buildMessage("register_credential_oauth_start", "c1", {
      credential_label: "rce-test",
      // ATTEMPT to inject malicious command via wire payload.
      codexLoginCommand: evilScriptPath,
      codexLoginArgs: []
    })
  );

  // Either: schema rejects unknown field (strict) -> error result, OR
  // schema accepts but discards -> success with default `codex` command spawned.
  // EITHER WAY the sentinel must NOT exist.
  // Wait long enough for the evil script's `touch` to land if it actually ran.
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(
    fs.existsSync(sentinel),
    false,
    `SECURITY: wire-supplied codexLoginCommand was spawned. Result: ${JSON.stringify(result)}`
  );

  // The job (if started) must NOT carry the wire-supplied command.
  // If a job was started, find it and verify its command is the default "codex" not our evil script.
  if (result.status === "success") {
    const body = JSON.parse(result.content) as { job_id: string };
    const job = reg.get(body.job_id);
    assert.ok(job, "job should be retrievable from registry");
    // Inspect internal opts by relying on the run not having spawned the evil script.
    // (Direct opts access is impractical; absence of sentinel is the strong signal.)
  }
});

test("oauth-login start uses HubRouter defaultCodexLoginCommand when provided (test seam)", async () => {
  const credentialsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seam-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot });
  const reg = new OAuthLoginJobRegistry();
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    oauthLoginRegistry: reg,
    defaultCodexLoginCommand: FAKE
  });

  const result = await router.route(
    buildMessage("register_credential_oauth_start", "c1", {
      credential_label: "test"
    })
  );

  assert.equal(result.status, "success", `expected success: ${JSON.stringify(result)}`);
  const body = JSON.parse(result.content);
  assert.ok(body.job_id);
  assert.equal(body.status, "pending");
});
