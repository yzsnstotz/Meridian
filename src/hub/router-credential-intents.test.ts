import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDENTIAL_READ_INTENTS, CREDENTIAL_WRITE_INTENTS } from "./router";

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
