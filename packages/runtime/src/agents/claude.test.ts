import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildClaudeCliArgs,
  buildClaudeSpawnArgs,
  buildClaudeStreamArgs,
  DEFAULT_CLAUDE_ALLOWED_TOOLS
} from "./claude";

test("buildClaudeCliArgs omits skip-permissions by default", () => {
  const args = buildClaudeCliArgs();

  assert.deepEqual(args, ["claude", "--allowedTools", DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" ")]);
  assert.equal(args.includes("--output-format"), false);
  assert.equal(args.includes("--include-partial-messages"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("buildClaudeCliArgs appends skip-permissions flag for auto-approve", () => {
  const args = buildClaudeCliArgs(undefined, undefined, true);

  assert.deepEqual(args, ["claude", "--allowedTools", DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "), "--dangerously-skip-permissions"]);
});

test("buildClaudeCliArgs omits skip-permissions when auto-approve is disabled", () => {
  const args = buildClaudeCliArgs(undefined, undefined, false);

  assert.deepEqual(args, ["claude", "--allowedTools", DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" ")]);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("buildClaudeSpawnArgs threads auto-approve to the provider CLI", () => {
  const args = buildClaudeSpawnArgs("bridge", null, "--socket=/tmp/claude.sock", "claude-3", true);

  assert.deepEqual(args, [
    "server",
    "--type=claude",
    "--socket=/tmp/claude.sock",
    "--",
    "claude",
    "--allowedTools",
    DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "),
    "--model",
    "claude-3",
    "--dangerously-skip-permissions"
  ]);
});

test("buildClaudeStreamArgs enables stream-json print mode without affecting bridge args", () => {
  const args = buildClaudeStreamArgs("claude-3", true);

  assert.deepEqual(args, [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--allowedTools",
    DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "),
    "--model",
    "claude-3",
    "--dangerously-skip-permissions"
  ]);
});

test("buildClaudeStreamArgs omits skip-permissions when auto-approve is disabled", () => {
  const args = buildClaudeStreamArgs("claude-3", false);

  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("buildClaudeCliArgs appends --effort flag when reasoningEffort is provided", () => {
  const args = buildClaudeCliArgs(undefined, "claude-opus-4-7", undefined, "high");

  assert.deepEqual(args, [
    "claude",
    "--allowedTools",
    DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "),
    "--effort",
    "high",
    "--model",
    "claude-opus-4-7"
  ]);
});

test("buildClaudeCliArgs omits --effort flag when reasoningEffort is absent", () => {
  const args = buildClaudeCliArgs(undefined, "claude-opus-4-7");

  assert.equal(args.includes("--effort"), false);
});

test("buildClaudeSpawnArgs threads reasoningEffort to the provider CLI", () => {
  const args = buildClaudeSpawnArgs("bridge", null, "--socket=/tmp/claude.sock", "claude-opus-4-7", true, "xhigh");

  assert.deepEqual(args, [
    "server",
    "--type=claude",
    "--socket=/tmp/claude.sock",
    "--",
    "claude",
    "--allowedTools",
    DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "),
    "--effort",
    "xhigh",
    "--model",
    "claude-opus-4-7",
    "--dangerously-skip-permissions"
  ]);
});

test("buildClaudeStreamArgs threads reasoningEffort to the print-mode CLI", () => {
  const args = buildClaudeStreamArgs("claude-opus-4-7", true, "medium");

  assert.deepEqual(args, [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--allowedTools",
    DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "),
    "--effort",
    "medium",
    "--model",
    "claude-opus-4-7",
    "--dangerously-skip-permissions"
  ]);
});
