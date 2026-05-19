import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CREDENTIAL_READ_INTENTS, CREDENTIAL_WRITE_INTENTS, HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";
import type { HubMessage } from "../types";
import type { WireAuth } from "../shared/caller-wire";

test("CREDENTIAL_READ_INTENTS contains list_credentials", () => {
  assert.ok(CREDENTIAL_READ_INTENTS.has("list_credentials"));
});

test("CREDENTIAL_WRITE_INTENTS contains all credential-mutating intents", () => {
  const expected = [
    "register_credential_oauth_start",
    "register_credential_oauth_poll",
    "register_credential_oauth_cancel",
    "register_credential_api_key",
    "update_credential",
    "set_default_credential",
    "revoke_credential"
  ];
  for (const intent of expected) {
    assert.ok(CREDENTIAL_WRITE_INTENTS.has(intent), `missing intent: ${intent}`);
  }
});

// ---------------------------------------------------------------------------
// Authority gate behavior tests for the credential intent sets.
// These lock in that the CREDENTIAL_*_INTENTS exports are *consulted* by
// checkCallerAuthority, not just decoratively present in the module.
// ---------------------------------------------------------------------------

type Authority = "read" | "write" | "stateless_call" | "admin";

async function setupAuthHarness(): Promise<{
  router: HubRouter;
  mintCaller: (id: string, authority: Authority) => string;
  cleanup: () => void;
}> {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-auth-gate-"));
  const credsRoot = path.join(tmpdir, "credentials");
  fs.mkdirSync(credsRoot, { recursive: true });
  const statePath = path.join(tmpdir, "state.json");
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: credsRoot });
  const router = new HubRouter(new InstanceRegistry(), {
    credentialStore: store,
    statePath
  });
  await router.initialize();
  const reg = router.getCallerRegistry();
  if (!reg) throw new Error("registry_missing");

  const mintCaller = (id: string, authority: Authority): string => {
    const minted = reg.mint({
      caller_id: id,
      caller_label: id,
      kind: "external",
      authority
    });
    return minted.cleartextKey;
  };
  return {
    router,
    mintCaller,
    cleanup: () => fs.rmSync(tmpdir, { recursive: true, force: true })
  };
}

function buildMsg(intent: string): HubMessage {
  return {
    trace_id: crypto.randomUUID(),
    thread_id: "t1",
    actor_id: "a1",
    intent: intent as any,
    target: "codex",
    payload: { content: "", attachments: [] },
    mode: "bridge",
    reply_channel: { channel: "socket", chat_id: "c1", socket_path: "/tmp/x.sock" }
  };
}

test("authority gate: read caller CAN call list_credentials (CREDENTIAL_READ_INTENTS)", async () => {
  const h = await setupAuthHarness();
  try {
    const key = h.mintCaller("read-c", "read");
    const result = await h.router.route(buildMsg("list_credentials"), {
      caller_id: "read-c",
      caller_key: key
    } as WireAuth);
    // Not authorized-for-intent error
    if (result.status === "error") {
      assert.notEqual(result.content, "caller_not_authorized_for_intent");
    }
  } finally {
    h.cleanup();
  }
});

test("authority gate: read caller CANNOT call register_credential_api_key (write intent)", async () => {
  const h = await setupAuthHarness();
  try {
    const key = h.mintCaller("read-c2", "read");
    const result = await h.router.route(buildMsg("register_credential_api_key"), {
      caller_id: "read-c2",
      caller_key: key
    } as WireAuth);
    assert.equal(result.status, "error");
    assert.equal(result.content, "caller_not_authorized_for_intent");
  } finally {
    h.cleanup();
  }
});

test("authority gate: read caller CANNOT call revoke_credential / update_credential / set_default_credential", async () => {
  const h = await setupAuthHarness();
  try {
    const key = h.mintCaller("read-c3", "read");
    for (const intent of ["revoke_credential", "update_credential", "set_default_credential"]) {
      const result = await h.router.route(buildMsg(intent), {
        caller_id: "read-c3",
        caller_key: key
      } as WireAuth);
      assert.equal(result.status, "error", `${intent} should error for read caller`);
      assert.equal(
        result.content,
        "caller_not_authorized_for_intent",
        `${intent} should be authority-gated`
      );
    }
  } finally {
    h.cleanup();
  }
});

test("authority gate: stateless_call caller CANNOT call any credential intent", async () => {
  const h = await setupAuthHarness();
  try {
    const key = h.mintCaller("sc-c", "stateless_call");
    const allCredIntents = [
      ...Array.from(CREDENTIAL_READ_INTENTS),
      ...Array.from(CREDENTIAL_WRITE_INTENTS)
    ];
    for (const intent of allCredIntents) {
      const result = await h.router.route(buildMsg(intent), {
        caller_id: "sc-c",
        caller_key: key
      } as WireAuth);
      assert.equal(result.status, "error", `stateless_call must be blocked from ${intent}`);
      assert.equal(
        result.content,
        "caller_not_authorized_for_intent",
        `${intent} should reject stateless_call`
      );
    }
  } finally {
    h.cleanup();
  }
});

test("authority gate: write caller CAN call write credential intents (passes authority gate)", async () => {
  const h = await setupAuthHarness();
  try {
    const key = h.mintCaller("write-c", "write");
    for (const intent of CREDENTIAL_WRITE_INTENTS) {
      const result = await h.router.route(buildMsg(intent), {
        caller_id: "write-c",
        caller_key: key
      } as WireAuth);
      // Either success, or a downstream error (e.g. invalid_payload), but
      // NOT the authority gate error.
      if (result.status === "error") {
        assert.notEqual(
          result.content,
          "caller_not_authorized_for_intent",
          `write caller blocked on ${intent}`
        );
      }
    }
  } finally {
    h.cleanup();
  }
});

test("Credential intents are NOT in ADMIN_ONLY_INTENTS (they use owner-or-admin per-handler)", async () => {
  // Read router.ts source and grep — credential intents must NOT appear in ADMIN_ONLY_INTENTS Set literal
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./router.ts", import.meta.url), "utf8");
  const adminBlock = src.match(/const ADMIN_ONLY_INTENTS[^]*?\]\);/)?.[0] ?? "";
  for (const intent of [
    "register_credential_oauth_start",
    "register_credential_api_key",
    "revoke_credential",
    "update_credential",
    "set_default_credential"
  ]) {
    assert.equal(adminBlock.includes(intent), false, `${intent} must not be in ADMIN_ONLY_INTENTS`);
  }
});
