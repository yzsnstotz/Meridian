import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCodexLoginUrl, CODEX_LOGIN_URL_PATTERNS } from "./oauth-url-extract";

test("extracts chatgpt.com auth URL", () => {
  const line = "Open this URL: https://chatgpt.com/auth/foo?bar=1 to log in";
  assert.equal(extractCodexLoginUrl(line), "https://chatgpt.com/auth/foo?bar=1");
});

test("extracts auth.openai.com URL", () => {
  assert.equal(
    extractCodexLoginUrl("visit https://auth.openai.com/abc?xyz=1"),
    "https://auth.openai.com/abc?xyz=1"
  );
});

test("extracts generic oauth/authorize URL", () => {
  assert.equal(
    extractCodexLoginUrl("Open https://idp.example.com/oauth/authorize?client_id=x"),
    "https://idp.example.com/oauth/authorize?client_id=x"
  );
});

test("returns null when no URL matches", () => {
  assert.equal(extractCodexLoginUrl("Logged in as foo"), null);
});

test("returns first match when multiple appear", () => {
  const line = "First https://chatgpt.com/auth/x then https://auth.openai.com/y";
  assert.equal(extractCodexLoginUrl(line), "https://chatgpt.com/auth/x");
});

test("does not include trailing punctuation or closing paren", () => {
  assert.equal(
    extractCodexLoginUrl("Open (https://chatgpt.com/auth/foo) to continue."),
    "https://chatgpt.com/auth/foo"
  );
});

test("CODEX_LOGIN_URL_PATTERNS export is a non-empty array of RegExp", () => {
  assert.ok(Array.isArray(CODEX_LOGIN_URL_PATTERNS));
  assert.ok(CODEX_LOGIN_URL_PATTERNS.length >= 3);
  for (const p of CODEX_LOGIN_URL_PATTERNS) assert.ok(p instanceof RegExp);
});
