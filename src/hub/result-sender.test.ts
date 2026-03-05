import assert from "node:assert/strict";
import { test } from "node:test";

import { splitTextForTelegram } from "./result-sender";

test("splitTextForTelegram preserves content exactly", () => {
  const content = `header\n\n    indented line\n${"x".repeat(5000)}\nfooter`;
  const chunks = splitTextForTelegram(content, 300);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), content);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
});

test("splitTextForTelegram handles text with no newline", () => {
  const content = "a".repeat(9300);
  const chunks = splitTextForTelegram(content, 1024);
  assert.equal(chunks.join(""), content);
  assert.ok(chunks.every((chunk) => chunk.length <= 1024));
});

test("splitTextForTelegram returns empty array for empty input", () => {
  assert.deepEqual(splitTextForTelegram("", 200), []);
});
