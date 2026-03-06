import assert from "node:assert/strict";
import { test } from "node:test";

import { decorateTelegramResultText, splitTextForTelegram } from "./result-sender";

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

test("decorateTelegramResultText appends approval guidance for approval prompts", () => {
  const text = decorateTelegramResultText({
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    thread_id: "cursor_01",
    source: "cursor",
    status: "success",
    content: "Waiting for approval...\nRun this command?\nAdd Shell(git status) to allowlist?",
    attachments: [],
    timestamp: new Date().toISOString()
  });

  assert.match(text, /\/approve run thread=cursor_01/);
  assert.match(text, /reply to this message with exactly: y, allow, all, or n/i);
});
