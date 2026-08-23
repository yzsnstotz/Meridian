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
    credential_id: "cred-1",
    provider: "codex",
    is_host_default: false
  };
  const env = buildChildEnvImpl({}, resolved);
  assert.equal(env.CODEX_HOME, "/tmp/managed-codex-home");
});

test("buildChildEnvImpl injects env_overrides on top of ambient env", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/tmp/x",
    env_overrides: { OPENAI_API_KEY: "sk-new", CUSTOM_VAR: "value" },
    credential_id: "cred-2",
    provider: "codex",
    is_host_default: false
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
    credential_id: "cred-3",
    provider: "codex",
    is_host_default: false
  };
  const env = buildChildEnvImpl(baseEnv, resolved);
  assert.equal(env.CODEX_HOME, "/tmp/winning");
});

test("buildChildEnvImpl does NOT set CODEX_HOME when provider is claude (claude reads $HOME/.claude)", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/h/.claude",
    env_overrides: {},
    credential_id: "host-default-claude",
    provider: "claude",
    is_host_default: true
  };
  const env = buildChildEnvImpl({}, resolved);
  assert.equal(env.CODEX_HOME, undefined);
});

test("buildChildEnvImpl injects a token-based git credential helper for codex (daemon Keychain bypass)", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/tmp/x",
    env_overrides: {},
    credential_id: "cred-git",
    provider: "codex",
    is_host_default: false
  };
  const env = buildChildEnvImpl({ GITHUB_TOKEN: "gho_test123" }, resolved);
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  // first helper resets any inherited helper (e.g. osxkeychain)
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  // second helper supplies the token as HTTPS basic auth
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
  assert.match(env.GIT_CONFIG_VALUE_1 ?? "", /username=x-access-token/);
  assert.match(env.GIT_CONFIG_VALUE_1 ?? "", /password=gho_test123/);
});

test("buildChildEnvImpl skips git credential injection when no github token is present", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/tmp/x",
    env_overrides: {},
    credential_id: "cred-git-none",
    provider: "codex",
    is_host_default: false
  };
  const env = buildChildEnvImpl({}, resolved);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
});

test("buildChildEnvImpl does not clobber an ambient GIT_CONFIG_COUNT", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/tmp/x",
    env_overrides: {},
    credential_id: "cred-git-ambient",
    provider: "codex",
    is_host_default: false
  };
  const env = buildChildEnvImpl({ GITHUB_TOKEN: "gho_test123", GIT_CONFIG_COUNT: "5" }, resolved);
  assert.equal(env.GIT_CONFIG_COUNT, "5");
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
});

test("buildChildEnvImpl does NOT inject git credential helper for claude", () => {
  const resolved: ResolvedCredential = {
    codex_home: "/h/.claude",
    env_overrides: {},
    credential_id: "host-default-claude",
    provider: "claude",
    is_host_default: true
  };
  const env = buildChildEnvImpl({ GITHUB_TOKEN: "gho_test123" }, resolved);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
});
