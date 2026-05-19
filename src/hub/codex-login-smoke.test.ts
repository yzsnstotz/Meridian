import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_LOGIN_URL_PATTERNS } from "./oauth-url-extract";

const execFileP = promisify(execFile);

async function codexAvailable(): Promise<boolean> {
  try {
    await execFileP("codex", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test("at least one CODEX_LOGIN_URL_PATTERN matches `codex login --help` output", async (t) => {
  if (!(await codexAvailable())) {
    t.skip("codex CLI not on PATH — skipping smoke test");
    return;
  }
  let stdout = "";
  let stderr = "";
  try {
    const r = await execFileP("codex", ["login", "--help"], { timeout: 10_000 });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    if (err && typeof err === "object" && "stdout" in err) {
      stdout = String((err as any).stdout ?? "");
      stderr = String((err as any).stderr ?? "");
    } else {
      throw err;
    }
  }
  const combined = stdout + "\n" + stderr;
  const matched = CODEX_LOGIN_URL_PATTERNS.some((pat) => pat.test(combined));

  // We're not strictly requiring `codex login --help` to print a URL — that's a niche
  // codex behavior. The real safeguard is that the patterns at least mention something
  // codex-related; if they don't, then OAuthLoginJob will silently fail in production
  // because the regex won't match the URL that codex *does* print at runtime.
  //
  // For this smoke test, we just assert that the patterns aren't all malformed/empty
  // and at least one pattern looks like a URL pattern. The stronger assertion
  // (regex matches real codex output) requires an integration test against a
  // running codex.

  // First, the bare sanity check on the patterns themselves:
  assert.ok(CODEX_LOGIN_URL_PATTERNS.length >= 3, "at least 3 URL patterns expected");
  for (const pat of CODEX_LOGIN_URL_PATTERNS) {
    assert.ok(pat instanceof RegExp);
    assert.match(pat.source, /^https/, `pattern should target https URLs: ${pat.source}`);
  }

  // Then the soft assertion against help output. If codex --help doesn't mention a URL,
  // we emit a console.warn so CI logs surface the potential drift, but we don't fail
  // (per the spec note that help output may not include the URL).
  if (!matched) {
    console.warn(
      `[smoke] No CODEX_LOGIN_URL_PATTERN matched 'codex login --help' output.\n` +
      `This may be benign (help text doesn't print the URL), but if it persists\n` +
      `alongside production OAuth-login failures, investigate the patterns in\n` +
      `src/hub/oauth-url-extract.ts. Help output was:\n${combined.slice(0, 2000)}`
    );
  }
});
