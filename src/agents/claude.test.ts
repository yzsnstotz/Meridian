import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildClaudeCliArgs,
  buildClaudeSpawnArgs,
  buildClaudeStreamArgs,
  DEFAULT_CLAUDE_ALLOWED_TOOLS
} from "./claude";

test("buildClaudeCliArgs omits skip-permissions flag by default", () => {
  const args = buildClaudeCliArgs();

  assert.deepEqual(args, ["claude", "--allowedTools", DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" ")]);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("buildClaudeCliArgs appends skip-permissions flag for auto-approve", () => {
  const args = buildClaudeCliArgs(undefined, undefined, true);

  assert.deepEqual(args, [
    "claude",
    "--allowedTools",
    DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "),
    "--dangerously-skip-permissions"
  ]);
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
