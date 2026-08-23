import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexLoginUrl,
  CODEX_LOGIN_URL_PATTERNS,
  extractCodexDeviceCode,
  stripAnsi
} from "./oauth-url-extract";

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

test("stripAnsi removes color codes", () => {
  assert.equal(stripAnsi("\x1b[94mhello\x1b[0m world"), "hello world");
  assert.equal(stripAnsi("no ansi here"), "no ansi here");
});

test("extractCodexDeviceCode parses the real codex device-auth banner", () => {
  const text = [
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "",
    "1. Open this link in your browser and sign in to your account",
    "   https://auth.openai.com/codex/device",
    "",
    "2. Enter this one-time code (expires in 15 minutes)",
    "   R0BG-M29HP",
    "",
    "Device codes are a common phishing target. Never share this code."
  ].join("\n");
  const dc = extractCodexDeviceCode(text);
  assert.deepEqual(dc, {
    verification_uri: "https://auth.openai.com/codex/device",
    user_code: "R0BG-M29HP"
  });
});

test("extractCodexDeviceCode tolerates ANSI color codes around URL and code", () => {
  const text =
    "Open: \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\nCode: \x1b[94mQYAA-YKJ4Y\x1b[0m\n";
  const dc = extractCodexDeviceCode(text);
  assert.deepEqual(dc, {
    verification_uri: "https://auth.openai.com/codex/device",
    user_code: "QYAA-YKJ4Y"
  });
});

test("extractCodexDeviceCode returns null until both URL and code are present", () => {
  assert.equal(extractCodexDeviceCode("https://auth.openai.com/codex/device only"), null);
  assert.equal(extractCodexDeviceCode("code only ABCD-12345"), null);
  assert.equal(extractCodexDeviceCode(""), null);
});

test("extractCodexDeviceCode does not match the browser-mode chatgpt URL", () => {
  // Browser flow URLs must NOT be misread as device verification URIs.
  assert.equal(
    extractCodexDeviceCode(
      "Open this URL: https://chatgpt.com/auth/foo and code ABCD-12345"
    ),
    null
  );
});
