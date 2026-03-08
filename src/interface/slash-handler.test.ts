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

test("parseSlashCommand parses /info as active-thread status", () => {
  const parsed = parseSlashCommand("/info");
  assert.equal(parsed.intent, "status");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.target, "active");
  assert.equal(parsed.shouldForward, true);
});

test("parseSlashCommand marks /attach without thread as picker flow", () => {
  const parsed = parseSlashCommand("/attach");
  assert.equal(parsed.intent, "attach");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.picker, "attach");
});

test("parseSlashCommand parses /detach with implicit active thread", () => {
  const parsed = parseSlashCommand("/detach");
  assert.equal(parsed.intent, "detach");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.target, "active");
  assert.equal(parsed.picker, null);
});

test("parseSlashCommand parses /detach with explicit thread", () => {
  const parsed = parseSlashCommand("/detach thread=codex_01");
  assert.equal(parsed.intent, "detach");
  assert.equal(parsed.threadId, "codex_01");
  assert.equal(parsed.target, "codex_01");
});

test("parseSlashCommand parses /reboot with explicit thread", () => {
  const parsed = parseSlashCommand("/reboot thread=codex_01");
  assert.equal(parsed.intent, "reboot");
  assert.equal(parsed.threadId, "codex_01");
  assert.equal(parsed.target, "codex_01");
});

test("parseSlashCommand parses /gui with implicit active thread", () => {
  const parsed = parseSlashCommand("/gui");
  assert.equal(parsed.intent, "gui");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.target, "active");
});

test("parseSlashCommand parses /gui with explicit thread", () => {
  const parsed = parseSlashCommand("/gui thread=gemini_01");
  assert.equal(parsed.intent, "gui");
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.target, "gemini_01");
});

test("parseSlashCommand parses /approve with explicit thread", () => {
  const parsed = parseSlashCommand("/approve allow thread=cursor_01");
  assert.equal(parsed.intent, "terminal_input");
  assert.equal(parsed.threadId, "cursor_01");
  assert.equal(parsed.target, "cursor_01");
  assert.equal(parsed.payloadContent, "allow");
});

test("parseSlashCommand normalizes /approve aliases", () => {
  const parsed = parseSlashCommand("/approve y");
  assert.equal(parsed.intent, "terminal_input");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.target, "active");
  assert.equal(parsed.payloadContent, "run");
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

test("parseSlashCommand routes /model through picker flow with explicit thread", () => {
  const parsed = parseSlashCommand("/model thread=gemini_01");
  assert.equal(parsed.intent, "switch_model");
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.target, "gemini_01");
  assert.equal(parsed.shouldForward, false);
  assert.equal(parsed.picker, "switch_model");
});

test("parseSlashCommand routes bare /model through picker flow", () => {
  const parsed = parseSlashCommand("/model");
  assert.equal(parsed.intent, "switch_model");
  assert.equal(parsed.shouldForward, false);
  assert.equal(parsed.target, "active");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.payloadContent, "");
  assert.equal(parsed.picker, "switch_model");
});

test("parseSlashCommand parses /detail with explicit trace and thread", () => {
  const parsed = parseSlashCommand("/detail trace=5af7c1f6-91e3-4fcf-8b7a-3f6308f8f9af thread=gemini_01");
  assert.equal(parsed.intent, "detail");
  assert.equal(parsed.shouldForward, true);
  assert.equal(parsed.threadId, "gemini_01");
  assert.equal(parsed.target, "gemini_01");
  assert.equal(parsed.payloadContent, "5af7c1f6-91e3-4fcf-8b7a-3f6308f8f9af");
});

test("parseSlashCommand parses bare /detail against active thread", () => {
  const parsed = parseSlashCommand("/detail");
  assert.equal(parsed.intent, "detail");
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.target, "active");
  assert.equal(parsed.payloadContent, "");
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

test("parseSlashCommand parses /push on thread=abc", () => {
  const parsed = parseSlashCommand("/push on thread=abc");
  assert.equal(parsed.intent, "push");
  assert.equal(parsed.shouldForward, true);
  assert.equal(parsed.pushEnabled, true);
  assert.equal(parsed.threadId, "abc");
  assert.equal(parsed.target, "abc");
});

test("parseSlashCommand parses /push off", () => {
  const parsed = parseSlashCommand("/push off");
  assert.equal(parsed.intent, "push");
  assert.equal(parsed.shouldForward, true);
  assert.equal(parsed.pushEnabled, false);
  assert.equal(parsed.threadId, null);
  assert.equal(parsed.target, "active");
});

test("parseSlashCommand parses bare /push as query", () => {
  const parsed = parseSlashCommand("/push");
  assert.equal(parsed.intent, "push");
  assert.equal(parsed.shouldForward, true);
  assert.equal(parsed.pushEnabled, null);
  assert.equal(parsed.threadId, null);
});
