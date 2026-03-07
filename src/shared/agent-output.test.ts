import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyAgentOutput } from "./agent-output";

test("classifyAgentOutput marks spinner frames as transient noise", () => {
  const frame =
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n" +
    " ⠼ List your saved chat checkpoints with /chat list… (esc to cancel, 6s)";

  const result = classifyAgentOutput(frame);
  assert.equal(result.kind, "transient");
});

test("classifyAgentOutput normalizes action-required terminal frames", () => {
  const frame = [
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ Action Required                                                              │",
    "│                                                                              │",
    "│ ?  Shell git status && git remote -v && git log -n 3 [current working direc… │",
    "│                                                                              │",
    "│ git status && git remote -v && git log -n 3                                  │",
    "│ Allow execution of: 'git, git, git'?                                         │",
    "│                                                                              │",
    "│ ● 1. Allow once                                                              │",
    "│   2. Allow for this session                                                  │",
    "│   3. No, suggest changes (esc)                                               │",
    "│                                                                              │",
    "╰──────────────────────────────────────────────────────────────────────────────╯"
  ].join("\n");

  const result = classifyAgentOutput(frame);
  assert.equal(result.kind, "action_required");
  assert.match(result.text, /^Waiting for approval\.\.\./);
  assert.match(result.text, /Run this command\?/);
  assert.match(result.text, /git status && git remote -v && git log -n 3/);
  assert.doesNotMatch(result.text, /╭|╰|│/);
});

test("classifyAgentOutput keeps plain replies as message content", () => {
  const result = classifyAgentOutput("Hi! How can I help you today?");
  assert.equal(result.kind, "message");
  assert.equal(result.text, "Hi! How can I help you today?");
});
