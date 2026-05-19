import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnvImpl } from "./instance-manager";
import type { ResolvedCredential } from "./credential-store";

test("buildChildEnvImpl leaves env untouched when resolved is null", () => {
  const baseEnv = { FOO: "bar" };
  const env = buildChildEnvImpl(baseEnv, null);
  assert.equal(env.FOO, "bar");
  // CODEX_HOME must NOT be set when no credential is supplied (preserves prior behavior)
  assert.equal(env.CODEX_HOME, undefined);
});

test("buildChildEnvImpl injects CODEX_HOME when resolved present", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/tmp/managed-codex-home",
    env_overrides: {},
    credential_id: "cred-1"
  };
  const env = buildChildEnvImpl({}, resolved);
  assert.equal(env.CODEX_HOME, "/tmp/managed-codex-home");
});

test("buildChildEnvImpl injects env_overrides on top of ambient env", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/tmp/x",
    env_overrides: { OPENAI_API_KEY: "sk-new", CUSTOM_VAR: "value" },
    credential_id: "cred-2"
  };
  const env = buildChildEnvImpl({}, resolved);
  assert.equal(env.OPENAI_API_KEY, "sk-new");
  assert.equal(env.CUSTOM_VAR, "value");
});

test("buildChildEnvImpl CODEX_HOME from resolved overrides ambient CODEX_HOME", () => {
  const baseEnv = { CODEX_HOME: "/should/be/overridden" };
  const resolved: ResolvedCredential = {
    codex_home: "/tmp/winning",
    env_overrides: {},
    credential_id: "cred-3"
  };
  const env = buildChildEnvImpl(baseEnv, resolved);
  assert.equal(env.CODEX_HOME, "/tmp/winning");
});
