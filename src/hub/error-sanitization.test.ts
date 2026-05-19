import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeErrorMessage } from "./error-sanitization";

test("sanitizeErrorMessage: redacts .meridian/credentials paths", () => {
  const msg = "ENOENT: no such file, open '/Users/foo/.meridian/credentials/abc-uuid/env.json'";
  const sanitized = sanitizeErrorMessage(msg);
  assert.equal(sanitized.includes("/Users/foo"), false);
  assert.equal(sanitized.includes("abc-uuid"), false);
  assert.equal(sanitized.includes("<credentials-dir>"), true);
});

test("sanitizeErrorMessage: redacts tmp test paths", () => {
  const msg = "EACCES: permission denied, open '/tmp/T/cred-test/.meridian/credentials/xyz/config.toml'";
  const sanitized = sanitizeErrorMessage(msg);
  assert.equal(sanitized.includes("/tmp/T/cred-test"), false);
  assert.equal(sanitized.includes("<credentials-dir>"), true);
});

test("sanitizeErrorMessage: redacts macOS osx tmp paths under /var/folders ending in credentials", () => {
  const msg = "open '/var/folders/aa/bb/T/meridian-creds-1/credentials/uuid-12345/auth.json'";
  const sanitized = sanitizeErrorMessage(msg);
  assert.equal(sanitized.includes("/var/folders"), false);
  assert.equal(sanitized.includes("uuid-12345"), false);
  assert.equal(sanitized.includes("<credentials-dir>"), true);
});

test("sanitizeErrorMessage: leaves error codes and other text intact", () => {
  const msg = "EACCES: permission denied while writing config.toml";
  assert.equal(sanitizeErrorMessage(msg), msg);
});

test("sanitizeErrorMessage: handles multiple paths in one message", () => {
  const msg =
    "Failed to rename /Users/x/.meridian/credentials/a/env.json.tmp to /Users/x/.meridian/credentials/a/env.json";
  const sanitized = sanitizeErrorMessage(msg);
  assert.equal(sanitized.includes("/Users/x"), false);
  // Both occurrences should be redacted
  const matches = sanitized.match(/<credentials-dir>/g);
  assert.ok(matches);
  assert.ok(matches!.length >= 2, `expected 2+ redactions, got ${matches!.length}`);
});

test("sanitizeErrorMessage: empty/undefined-safe", () => {
  assert.equal(sanitizeErrorMessage(""), "");
});
