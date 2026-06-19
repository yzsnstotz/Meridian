import assert from "node:assert/strict";
import { test } from "node:test";

import { renderLoginPage, summarizeCodexAuthJson, summarizeGeminiAuthJson } from "./login";

function jwtWith(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig"
  ].join(".");
}

test("renderLoginPage includes direct CLI test controls on the Gateway GUI", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /id="testProvider"/);
  assert.match(html, /id="testModel"/);
  assert.match(html, /id="testPrompt"/);
  assert.match(html, /id="runTestBtn"/);
  assert.match(html, /\/providers\//);
  assert.match(html, /provider\s*\+\s*['"]\/test/);
});

test("summarizeCodexAuthJson exposes safe account dimensions without token values", () => {
  const summary = summarizeCodexAuthJson(
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "secret-not-shown",
      tokens: {
        id_token: jwtWith({ email: "codex@example.com", sub: "subject-1" }),
        account_id: "acct-1234567890",
        access_token: "access-secret",
        refresh_token: "refresh-secret"
      }
    })
  );

  assert.deepEqual(summary, {
    account: "codex@example.com",
    auth: "ChatGPT",
    credential: "account acct-1234567890",
    limitation: "Subscription tier is not exposed by Codex CLI status."
  });
});

test("summarizeGeminiAuthJson exposes OAuth account identity and expiry without token values", () => {
  const expiry = Date.now() + 60_000;
  const summary = summarizeGeminiAuthJson(
    JSON.stringify({
      id_token: jwtWith({ email: "gemini@example.com", sub: "subject-2" }),
      expiry_date: expiry,
      refresh_token: "refresh-secret"
    })
  );

  assert.equal(summary.account, "gemini@example.com");
  assert.equal(summary.auth, "Google OAuth");
  assert.equal(summary.credential, `token valid until ${new Date(expiry).toLocaleString()}`);
  assert.equal(summary.limitation, "Subscription tier is not exposed by Gemini CLI status.");
});
