import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexExecArgs, buildCodexResumeArgs, buildCodexSpawnArgs } from "./codex";

test("buildCodexSpawnArgs omits auto-approve flag by default", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock");

  assert.deepEqual(args, ["server", "--type=codex", "--socket=/tmp/codex.sock", "--", "codex"]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexSpawnArgs appends auto-approve flag when requested", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", true, "xhigh");

  assert.deepEqual(args, [
    "server",
    "--type=codex",
    "--socket=/tmp/codex.sock",
    "--",
    "codex",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
});

test("buildCodexSpawnArgs uses read-only sandbox when requested", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", false, "xhigh", "read-only");

  assert.deepEqual(args, [
    "server",
    "--type=codex",
    "--socket=/tmp/codex.sock",
    "--",
    "codex",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--model",
    "gpt-5.4",
    "--sandbox",
    "read-only"
  ]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexExecArgs enables direct JSON streaming mode", () => {
  const args = buildCodexExecArgs("gpt-5.4", true, "xhigh");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
});

test("buildCodexExecArgs uses read-only sandbox when requested", () => {
  const args = buildCodexExecArgs("gpt-5.4", false, "xhigh", "read-only");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--model",
    "gpt-5.4",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check"
  ]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexExecArgs always includes bypass flag even when autoApprove is false", () => {
  const args = buildCodexExecArgs("gpt-5.4", false);

  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
    "headless exec must always bypass approvals");
});

test("buildCodexExecArgs always includes bypass flag even when autoApprove is undefined", () => {
  const args = buildCodexExecArgs("gpt-5.4");

  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
    "headless exec must always bypass approvals");
});

test("buildCodexResumeArgs resumes an existing exec session", () => {
  const args = buildCodexResumeArgs("session-123", "gpt-5.4", true, "xhigh");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "resume",
    "session-123",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
});

test("buildCodexResumeArgs uses read-only sandbox when requested", () => {
  const args = buildCodexResumeArgs("session-123", "gpt-5.4", false, "xhigh", "read-only");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "resume",
    "session-123",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--model",
    "gpt-5.4",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check"
  ]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexResumeArgs always includes bypass flag even when autoApprove is false", () => {
  const args = buildCodexResumeArgs("session-456", "gpt-5.4", false);

  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
    "headless resume must always bypass approvals");
});
