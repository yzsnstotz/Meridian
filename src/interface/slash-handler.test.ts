import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSlashCommand } from "./slash-handler";

test("parseSlashCommand parses /spawn normally", () => {
  const parsed = parseSlashCommand("/spawn type=gemini mode=pane_bridge");
  assert.equal(parsed.intent, "spawn");
  assert.equal(parsed.target, "gemini");
  assert.equal(parsed.mode, "pane_bridge");
});

test("parseSlashCommand accepts full-width slash prefix", () => {
  const parsed = parseSlashCommand("／spawn type=gemini mode=pane_bridge");
  assert.equal(parsed.intent, "spawn");
  assert.equal(parsed.target, "gemini");
  assert.equal(parsed.mode, "pane_bridge");
});

test("parseSlashCommand accepts spaced separators in args", () => {
  const parsed = parseSlashCommand("/status thread = gemini_01");
  assert.equal(parsed.intent, "status");
  assert.equal(parsed.threadId, "gemini_01");
});

test("parseSlashCommand accepts full-width equals in args", () => {
  const parsed = parseSlashCommand("/status thread＝gemini_01");
  assert.equal(parsed.intent, "status");
  assert.equal(parsed.threadId, "gemini_01");
});
