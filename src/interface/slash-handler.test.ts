import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSlashCommand } from "./slash-handler";

test("parseSlashCommand parses /spawn normally", () => {
  const parsed = parseSlashCommand("/spawn type=gemini mode=pane_bridge");
  assert.equal(parsed.intent, "spawn");
  assert.equal(parsed.target, "gemini");
  assert.equal(parsed.mode, "pane_bridge");
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand accepts full-width slash prefix", () => {
  const parsed = parseSlashCommand("／spawn type=gemini mode=pane_bridge");
  assert.equal(parsed.intent, "spawn");
  assert.equal(parsed.target, "gemini");
  assert.equal(parsed.mode, "pane_bridge");
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand accepts spaced separators in args", () => {
  const parsed = parseSlashCommand("/status thread = gemini_01");
  assert.equal(parsed.intent, "status");
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand accepts full-width equals in args", () => {
  const parsed = parseSlashCommand("/status thread＝gemini_01");
  assert.equal(parsed.intent, "status");
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand marks /attach without thread as picker flow", () => {
  const parsed = parseSlashCommand("/attach");
  assert.equal(parsed.intent, "attach");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.picker, "attach");
});

test("parseSlashCommand marks /kill without thread as picker flow", () => {
  const parsed = parseSlashCommand("/kill");
  assert.equal(parsed.intent, "kill");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.picker, "kill");
});

test("parseSlashCommand marks /spawn without args as picker flow", () => {
  const parsed = parseSlashCommand("/spawn");
  assert.equal(parsed.intent, "spawn");
  assert.equal(parsed.picker, "spawn");
});

test("parseSlashCommand parses typed /model command", () => {
  const parsed = parseSlashCommand("/model thread=gemini_01 type=codex");
  assert.equal(parsed.intent, "switch_model");
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.target, "codex");
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand marks /model without args as picker flow", () => {
  const parsed = parseSlashCommand("/model");
  assert.equal(parsed.intent, "switch_model");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.picker, "switch_model");
});

test("parseSlashCommand keeps thread when /model omits type", () => {
  const parsed = parseSlashCommand("/model thread=gemini_01");
  assert.equal(parsed.intent, "switch_model");
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.picker, "switch_model");
});
