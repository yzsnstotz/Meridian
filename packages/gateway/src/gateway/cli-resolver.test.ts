import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resolveCli, resolveCliOrThrow, resetCliResolverCache } from "./cli-resolver";

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  resetCliResolverCache();
  saveEnv("PATH", "MERIDIAN_CODEX_BIN", "MERIDIAN_CLAUDE_BIN");
});
afterEach(() => {
  restoreEnv();
  resetCliResolverCache();
});

/** Write an executable shell script that reproduces a CLI's `--version` behavior. */
function writeFakeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

test("resolveCli picks a WORKING install over a stale one ranked earlier on PATH", () => {
  // Reproduces the production incident: a broken duplicate CLI is ranked FIRST
  // on PATH; the resolver must skip it and pick the working one further down.
  const stale = mkdtempSync(join(tmpdir(), "mgw-stale-"));
  const good = mkdtempSync(join(tmpdir(), "mgw-good-"));
  // Stale codex: `--version` exits non-zero (mimics ENOENT native binary).
  writeFakeBin(stale, "codex", 'echo "boom" >&2\nexit 1');
  // Good codex: `--version` prints a version and exits 0.
  writeFakeBin(good, "codex", 'echo "codex-cli 0.142.5"');

  process.env.PATH = `${stale}${delimiter}${good}`;
  resetCliResolverCache();

  const resolved = resolveCli("codex");
  assert.equal(resolved.path, join(good, "codex"), "must resolve the working install, not the stale one");
  assert.match(resolved.version ?? "", /0\.142\.5/);
});

test("resolveCli returns a clean actionable error when NO usable CLI exists", () => {
  const empty = mkdtempSync(join(tmpdir(), "mgw-empty-"));
  process.env.PATH = empty; // no codex anywhere resolvable
  delete process.env.MERIDIAN_CODEX_BIN;
  resetCliResolverCache();

  const resolved = resolveCli("codex");
  assert.equal(resolved.path, null);
  assert.match(resolved.error ?? "", /No usable `codex` CLI/);
  assert.match(resolved.error ?? "", /MERIDIAN_CODEX_BIN/);
});

test("resolveCliOrThrow throws the actionable error string when unresolved", () => {
  const empty = mkdtempSync(join(tmpdir(), "mgw-empty2-"));
  process.env.PATH = empty;
  delete process.env.MERIDIAN_CODEX_BIN;
  resetCliResolverCache();

  assert.throws(() => resolveCliOrThrow("codex"), /No usable `codex` CLI/);
});

test("MERIDIAN_<PROVIDER>_BIN override is honored when it verifies", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgw-override-"));
  const pinned = writeFakeBin(dir, "my-codex", 'echo "pinned 9.9.9"');
  process.env.PATH = "/nonexistent-dir-xyz";
  process.env.MERIDIAN_CODEX_BIN = pinned;
  resetCliResolverCache();

  const resolved = resolveCli("codex");
  assert.equal(resolved.path, pinned);
  assert.match(resolved.version ?? "", /9\.9\.9/);
});

test("a bad MERIDIAN_<PROVIDER>_BIN override fails LOUD instead of silently falling back", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgw-override-bad-"));
  // A working codex on PATH exists, but the explicit override points at a broken
  // binary — we must surface the override error, not silently use PATH.
  const good = mkdtempSync(join(tmpdir(), "mgw-override-good-"));
  writeFakeBin(good, "codex", 'echo "codex 1.0.0"');
  const broken = writeFakeBin(dir, "broken-codex", "exit 3");
  process.env.PATH = good;
  process.env.MERIDIAN_CODEX_BIN = broken;
  resetCliResolverCache();

  const resolved = resolveCli("codex");
  assert.equal(resolved.path, null);
  assert.match(resolved.error ?? "", /MERIDIAN_CODEX_BIN=/);
  assert.match(resolved.error ?? "", /not usable/);
});

test("resolveCli caches: the first resolution wins until reset", () => {
  // `codex` is not present in this repo's common install dirs, so removing it
  // from PATH would make a fresh probe fail — proving the cache is doing the work
  // when the second lookup still succeeds.
  saveEnv("MERIDIAN_CODEX_BIN");
  delete process.env.MERIDIAN_CODEX_BIN;
  const good = mkdtempSync(join(tmpdir(), "mgw-cache-"));
  writeFakeBin(good, "codex", 'echo "codex 0.142.5"');
  process.env.PATH = good;
  resetCliResolverCache();

  const first = resolveCli("codex");
  assert.equal(first.path, join(good, "codex"));

  // Change PATH to something with no codex; cached value must persist.
  process.env.PATH = "/nonexistent-cache-dir";
  const second = resolveCli("codex");
  assert.equal(second.path, first.path, "cached resolution should not re-probe");

  // After reset it re-probes and now finds nothing.
  resetCliResolverCache();
  const third = resolveCli("codex");
  assert.equal(third.path, null);
});
