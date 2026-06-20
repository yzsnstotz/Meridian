import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { logoutProvider, renderLoginPage, summarizeCodexAuthJson, summarizeGeminiAuthJson } from "./login";

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

test("renderLoginPage includes a usage tab with summary and log tables", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /data-tab="usage"/);
  assert.match(html, /id="usageSummary"/);
  assert.match(html, /id="usageLog"/);
  assert.match(html, /Token total/);
  assert.match(html, /Response time/);
  assert.match(html, /fetch\(["']\/usage["']\)/);
});

test("renderLoginPage includes connected-provider logout controls", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /\/providers\/"\s*\+\s*id\s*\+\s*"\/logout/);
  assert.match(html, /function logout/);
  assert.match(html, /Log out/);
});

test("renderLoginPage keeps provider cards equal height", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /\.cards\s*\{[^}]*align-items:\s*stretch;/s);
  assert.match(html, /\.card\s*\{[^}]*grid-template-rows:\s*auto minmax\(88px, 1fr\) auto;/s);
  assert.match(html, /\.card\s*\{[^}]*min-height:\s*294px;/s);
  assert.match(html, /\.card \.actions\s*\{[^}]*align-self:\s*end;/s);
});

test("renderLoginPage includes English, Chinese, and Japanese language options", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /id="languageSelect"/);
  assert.match(html, /value="en">English/);
  assert.match(html, /value="zh-CN">中文/);
  assert.match(html, /value="ja">日本語/);
  assert.match(html, /meridian\.gateway\.language/);
  assert.match(html, /连接你的 AI 订阅/);
  assert.match(html, /AI サブスクリプションを接続/);
});

test("logoutProvider backs up Codex auth file when CLI logout is unavailable", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "meridian-gateway-logout-"));
  const authDir = join(homeDir, ".codex");
  const authPath = join(authDir, "auth.json");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "secret" } }), "utf8");

  const result = await logoutProvider("codex", {
    homeDir,
    now: () => new Date("2026-06-20T01:02:03.456Z"),
    run: async () => ({ code: 1, out: "unknown command" }),
  });

  const backupPath = join(authDir, "auth.json.logged-out-2026-06-20T01-02-03-456Z");
  assert.equal(result.ok, true);
  assert.equal(existsSync(authPath), false);
  assert.equal(readFileSync(backupPath, "utf8"), JSON.stringify({ tokens: { refresh_token: "secret" } }));
  assert.match(result.detail ?? "", /backed up/);
  assert.doesNotMatch(result.detail ?? "", /secret/);
});

test("logoutProvider uses provider logout command when it succeeds", async () => {
  const result = await logoutProvider("claude", {
    homeDir: mkdtempSync(join(tmpdir(), "meridian-gateway-logout-")),
    run: async (command, args) => {
      assert.equal(command, "claude");
      assert.deepEqual(args, ["auth", "logout"]);
      return { code: 0, out: "logged out" };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    detail: "Signed out with Claude CLI.",
    command: "claude auth logout",
  });
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
