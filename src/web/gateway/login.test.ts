import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  getProviderCliVersion,
  installProvider,
  logoutProvider,
  renderLoginPage,
  startLogin,
  summarizeCodexAuthJson,
  summarizeGeminiAuthJson,
  updateProviderCli
} from "./login";

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

test("renderLoginPage includes CLI version and update controls", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /\/providers\/versions/);
  assert.match(html, /\/providers\/"\s*\+\s*id\s*\+\s*"\/update/);
  assert.match(html, /function updateCli/);
  assert.match(html, /Update CLI/);
  assert.match(html, /factCli/);
});

test("renderLoginPage includes model refresh controls", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /id="refreshModelsBtn"/);
  assert.match(html, /function refreshModels/);
  assert.match(html, /fetch\(["']\/models\/refresh["'],\s*\{\s*method:\s*["']POST["']/);
  assert.match(html, /Refresh models/);
  assert.match(html, /刷新模型/);
  assert.match(html, /モデルを更新/);
});

test("renderLoginPage includes Antigravity as an independent provider", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /data-id="antigravity"/);
  assert.match(html, /class="ico antigravity">A/);
  assert.match(html, /<option value="antigravity">Antigravity<\/option>/);
  assert.match(html, /"antigravity-subscription":\s*\{\s*id:\s*"antigravity",\s*label:\s*"Antigravity"/);
  assert.match(html, /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/);
  assert.match(html, /antigravityInstallHint/);
  assert.match(html, /antigravityManualLoginHint/);
  assert.match(html, /res\.command/);
  assert.match(html, /showCommandFallback\(id,\s*localizeKnownValue/);
  assert.match(html, /--antigravity:/);
});

test("getProviderCliVersion detects installed and latest npm versions", async () => {
  const calls: string[] = [];
  const result = await getProviderCliVersion("gemini", {
    installed: () => true,
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "gemini") return { code: 0, out: "0.37.0\n" };
      if (command === "npm") return { code: 0, out: '"0.47.0"\n' };
      return { code: 1, out: "unexpected" };
    }
  });

  assert.deepEqual(calls, [
    "gemini --version",
    "npm view @google/gemini-cli version --json"
  ]);
  assert.deepEqual(result, {
    installed: true,
    command: "gemini",
    packageName: "@google/gemini-cli",
    updateCommand: "npm install -g @google/gemini-cli",
    installedVersion: "0.37.0",
    latestVersion: "0.47.0",
    updateAvailable: true
  });
});

test("getProviderCliVersion reports a broken Antigravity app shim as not usable", async () => {
  const result = await getProviderCliVersion("antigravity", {
    installed: () => true,
    run: async (command) => {
      assert.equal(command, "agy");
      return {
        code: 1,
        out: "/opt/homebrew/bin/agy: line 2: /Applications/Antigravity.app/Contents/Resources/app/bin/antigravity: No such file or directory"
      };
    }
  });

  assert.equal(result.installed, false);
  assert.equal(result.command, "agy");
  assert.equal(result.packageName, "Google Antigravity app");
  assert.equal(result.updateCommand, "curl -fsSL https://antigravity.google/cli/install.sh | bash");
  assert.match(result.error ?? "", /Antigravity app.*not available|No such file/i);
});

test("installProvider runs the official Antigravity installer and verifies agy is usable", async () => {
  const calls: string[] = [];
  const result = await installProvider("antigravity", 1000, {
    installed: (bin) => bin === "agy",
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { code: 0, out: "Antigravity CLI binary placed successfully\n" };
    }
  });

  assert.deepEqual(calls, [
    "/bin/sh -c curl -fsSL https://antigravity.google/cli/install.sh | bash"
  ]);
  assert.deepEqual(result, { installed: true });
});

test("updateProviderCli runs the Antigravity installer and returns a fresh version probe", async () => {
  const calls: string[] = [];
  const result = await updateProviderCli("antigravity", 1000, {
    installed: (bin) => bin === "agy",
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "agy") return { code: 0, out: "1.0.7\n" };
      return { code: 0, out: "updated\n" };
    }
  });

  assert.deepEqual(calls, [
    "/bin/sh -c curl -fsSL https://antigravity.google/cli/install.sh | bash",
    "agy --version"
  ]);
  assert.equal(result.installed, true);
  assert.equal(result.version?.installed, true);
  assert.equal(result.version?.installedVersion, "1.0.7");
});

test("startLogin opens a macOS Terminal session for Antigravity login", async () => {
  const calls: string[] = [];
  const result = await startLogin("antigravity", {
    platform: "darwin",
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { code: 0, out: "" };
    }
  });

  assert.equal(result.started, true);
  assert.equal(result.manual, undefined);
  assert.equal(result.command, "agy");
  assert.match(result.hint ?? "", /Antigravity/);
  assert.deepEqual(calls, [
    "osascript -e tell application \"Terminal\" to activate -e tell application \"Terminal\" to do script \"agy\""
  ]);
});

test("startLogin falls back to copyable Antigravity guidance when Terminal cannot be opened", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "meridian-gateway-agy-login-"));
  const markerPath = join(binDir, "spawned");
  const fakeAgy = join(binDir, "agy");
  writeFileSync(
    fakeAgy,
    `#!/bin/sh\nprintf spawned > '${markerPath.replace(/'/g, "'\\''")}'\necho 'https://example.test/oauth'\n`,
    "utf8"
  );
  chmodSync(fakeAgy, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  try {
    const result = await startLogin("antigravity", {
      platform: "darwin",
      run: async () => ({ code: 1, out: "not allowed" })
    });

    assert.equal(result.manual, true);
    assert.equal(result.started, undefined);
    assert.equal(result.command, "agy");
    assert.match(result.hint ?? "", /agy/);
    assert.equal(existsSync(markerPath), false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("renderLoginPage keeps provider cards equal height", () => {
  const html = renderLoginPage(8789);

  assert.match(html, /\.cards\s*\{[^}]*align-items:\s*stretch;/s);
  assert.match(html, /\.card\s*\{[^}]*grid-template-rows:\s*auto minmax\(88px, 1fr\) auto;/s);
  assert.match(html, /\.card\s*\{[^}]*min-height:\s*294px;/s);
  assert.match(html, /\.card\s*\{[^}]*min-width:\s*0;/s);
  assert.match(html, /\.card \.actions\s*\{[^}]*align-self:\s*end;/s);
  assert.match(html, /\.tabs\s*\{\s*display:\s*flex;\s*width:\s*100%;\s*max-width:\s*100%;\s*\}/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*\.cards\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
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
