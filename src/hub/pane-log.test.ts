import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { appendRunResultToPaneLog, appendUserRunToPaneLog } from "./pane-log";

const testLogDir = path.join(tmpdir(), `meridian-pane-log-test-${Date.now()}`);

test("appendRunResultToPaneLog creates file and appends when file does not exist", async () => {
  fs.mkdirSync(testLogDir, { recursive: true });
  const threadId = "run_01";
  const content = "Hello from run\nLine two";
  const appended = await appendRunResultToPaneLog(threadId, content, testLogDir);
  assert.equal(appended, true);
  const logPath = path.join(testLogDir, `pane-${threadId}.log`);
  assert.ok(fs.existsSync(logPath));
  const raw = fs.readFileSync(logPath, "utf8");
  assert.match(raw, /--- \d{4}-\d{2}-\d{2}T/);
  assert.ok(raw.includes(content));
  fs.rmSync(logPath, { force: true });
});

test("appendRunResultToPaneLog returns false for empty content", async () => {
  const threadId = "empty_01";
  assert.equal(await appendRunResultToPaneLog(threadId, "", testLogDir), false);
  assert.equal(await appendRunResultToPaneLog(threadId, "  \n  ", testLogDir), false);
  const logPath = path.join(testLogDir, `pane-${threadId}.log`);
  assert.equal(fs.existsSync(logPath), false);
});

test("appendRunResultToPaneLog dedups when tail already contains content", async () => {
  const threadId = "dedup_01";
  const logPath = path.join(testLogDir, `pane-${threadId}.log`);
  const existing = "\n--- 2020-01-01T00:00:00.000Z ---\nAlready in log\n";
  fs.mkdirSync(testLogDir, { recursive: true });
  fs.writeFileSync(logPath, existing, "utf8");
  const appended = await appendRunResultToPaneLog(threadId, "Already in log", testLogDir);
  assert.equal(appended, false);
  assert.equal(fs.readFileSync(logPath, "utf8"), existing);
  fs.rmSync(logPath, { force: true });
});

test("appendRunResultToPaneLog appends when tail does not contain content", async () => {
  const threadId = "append_01";
  const logPath = path.join(testLogDir, `pane-${threadId}.log`);
  const existing = "\n--- 2020-01-01T00:00:00.000Z ---\nOld content\n";
  fs.mkdirSync(testLogDir, { recursive: true });
  fs.writeFileSync(logPath, existing, "utf8");
  const newContent = "New run result";
  const appended = await appendRunResultToPaneLog(threadId, newContent, testLogDir);
  assert.equal(appended, true);
  const raw = fs.readFileSync(logPath, "utf8");
  assert.ok(raw.includes("Old content"));
  assert.ok(raw.includes(newContent));
  assert.match(raw, /--- \d{4}-\d{2}-\d{2}T.*\nNew run result/);
  fs.rmSync(logPath, { force: true });
});

test("appendRunResultToPaneLog dedups when tail contains last N lines of content", async () => {
  const threadId = "dedup_tail_01";
  const logPath = path.join(testLogDir, `pane-${threadId}.log`);
  const block = "Line A\nLine B\nLine C\nLine D\nLine E\n";
  const existing = `\n--- 2020-01-01T00:00:00.000Z ---\n${block}`;
  fs.mkdirSync(testLogDir, { recursive: true });
  fs.writeFileSync(logPath, existing, "utf8");
  const sameContent = "Line A\nLine B\nLine C\nLine D\nLine E";
  const appended = await appendRunResultToPaneLog(threadId, sameContent, testLogDir);
  assert.equal(appended, false);
  assert.equal(fs.readFileSync(logPath, "utf8"), existing);
  fs.rmSync(logPath, { force: true });
});

test("appendUserRunToPaneLog creates file and appends when file does not exist", async () => {
  const threadId = "user_01";
  const content = "please list files";
  const appended = await appendUserRunToPaneLog(threadId, content, testLogDir);
  assert.equal(appended, true);
  const logPath = path.join(testLogDir, `pane-${threadId}.log`);
  assert.ok(fs.existsSync(logPath));
  const raw = fs.readFileSync(logPath, "utf8");
  assert.match(raw, /--- \d{4}-\d{2}-\d{2}T/);
  assert.ok(raw.includes(content));
  fs.rmSync(logPath, { force: true });
});

test("appendUserRunToPaneLog dedups when tail already contains content", async () => {
  const threadId = "user_dedup_01";
  const logPath = path.join(testLogDir, `pane-${threadId}.log`);
  const existing = "\n--- 2020-01-01T00:00:00.000Z ---\nsame user line\n";
  fs.mkdirSync(testLogDir, { recursive: true });
  fs.writeFileSync(logPath, existing, "utf8");
  const appended = await appendUserRunToPaneLog(threadId, "same user line", testLogDir);
  assert.equal(appended, false);
  assert.equal(fs.readFileSync(logPath, "utf8"), existing);
  fs.rmSync(logPath, { force: true });
});
