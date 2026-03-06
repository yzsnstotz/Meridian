import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSlashCommand } from "./slash-handler";

test("parseSlashCommand parses /spawn normally", () => {
  const parsed = parseSlashCommand("/spawn type=gemini mode=pane_bridge");
  assert.equal(parsed.intent, "spawn");
  assert.equal(parsed.target, "gemini");
  assert.equal(parsed.mode, "pane_bridge");
  assert.equal(parsed.spawnDir, null);
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand parses /spawn with explicit dir", () => {
  const parsed = parseSlashCommand("/spawn type=codex mode=pane_bridge dir=/Users/yzliu/work/project-a");
  assert.equal(parsed.intent, "spawn");
  assert.equal(parsed.target, "codex");
  assert.equal(parsed.mode, "pane_bridge");
  assert.equal(parsed.spawnDir, "/Users/yzliu/work/project-a");
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

test("parseSlashCommand forwards bare /model as run intent", () => {
  const parsed = parseSlashCommand("/model");
  assert.equal(parsed.intent, "run");
  assert.equal(parsed.shouldForward, true);
  assert.equal(parsed.target, "active");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.payloadContent, "/model");
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand keeps thread when /model omits type", () => {
  const parsed = parseSlashCommand("/model thread=gemini_01");
  assert.equal(parsed.intent, "switch_model");
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.picker, "switch_model");
});

test("parseSlashCommand parses /restart as local command", () => {
  const parsed = parseSlashCommand("/restart");
  assert.equal(parsed.intent, "service_restart");
  assert.equal(parsed.shouldForward, false);
});

test("parseSlashCommand parses /browse as local command", () => {
  const parsed = parseSlashCommand("/browse");
  assert.equal(parsed.intent, "browse");
  assert.equal(parsed.shouldForward, false);
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand parses /update on with interval and thread", () => {
  const parsed = parseSlashCommand("/update on thread=codex_01 interval=45");
  assert.equal(parsed.intent, "monitor_update");
  assert.equal(parsed.shouldForward, true);
  assert.equal(parsed.threadId, "codex_01");
  assert.equal(parsed.target, "codex_01");
  assert.equal(parsed.monitorUpdatesEnabled, true);
  assert.equal(parsed.monitorUpdateIntervalSec, 45);
});

test("parseSlashCommand parses /update off", () => {
  const parsed = parseSlashCommand("/update off");
  assert.equal(parsed.intent, "monitor_update");
  assert.equal(parsed.monitorUpdatesEnabled, false);
  assert.equal(parsed.monitorUpdateIntervalSec, null);
});

test("parseSlashCommand parses /mupdate with explicit thread", () => {
  const parsed = parseSlashCommand("/mupdate thread=codex_01");
  assert.equal(parsed.intent, "monitor_manual_update");
  assert.equal(parsed.shouldForward, true);
  assert.equal(parsed.threadId, "codex_01");
  assert.equal(parsed.target, "codex_01");
  assert.equal(parsed.monitorUpdatesEnabled, null);
  assert.equal(parsed.monitorUpdateIntervalSec, null);
});
