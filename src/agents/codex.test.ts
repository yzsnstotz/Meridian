import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexExecArgs, buildCodexResumeArgs, buildCodexSpawnArgs } from "./codex";

test("buildCodexSpawnArgs omits auto-approve flag by default", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock");

  assert.deepEqual(args, ["server", "--type=codex", "--socket=/tmp/codex.sock", "--", "codex"]);
  assert.equal(args.includes("--approval-policy=auto-approve"), false);
  assert.equal(args.includes("--ask-for-approval"), false);
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
    "--ask-for-approval",
    "never"
  ]);
  assert.equal(args.includes("--approval-policy=auto-approve"), false);
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
