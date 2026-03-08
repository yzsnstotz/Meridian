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
  assert.match(result.text, /3\.\s*(No, suggest changes|Allow for all commands)/);
  assert.doesNotMatch(result.text, /╭|╰|│/);
});

test("classifyAgentOutput keeps plain replies as message content", () => {
  const result = classifyAgentOutput("Hi! How can I help you today?");
  assert.equal(result.kind, "message");
  assert.equal(result.text, "Hi! How can I help you today?");
});

test("classifyAgentOutput backfills option 3 when terminal prompt only exposes 1 and 2", () => {
  const frame = [
    "Action Required",
    "",
    "git status",
    "Allow execution of: 'git'?",
    "1. Allow once",
    "2. Allow for this session"
  ].join("\n");

  const result = classifyAgentOutput(frame);
  assert.equal(result.kind, "action_required");
  assert.match(result.text, /3\. Allow for all commands/);
});

test("classifyAgentOutput marks incomplete summary protocol blocks as transient", () => {
  const partial = [
    "some preface",
    "[[MERIDIAN_SUMMARY_BEGIN id=123e4567-e89b-12d3-a456-426614174000]]",
    "in-progress content without end tag"
  ].join("\n");

  const result = classifyAgentOutput(partial);
  assert.equal(result.kind, "transient");
});

test("classifyAgentOutput marks protocol-only summary blocks as transient", () => {
  const protocolOnly = [
    "[[MERIDIAN_SUMMARY_BEGIN id=123e4567-e89b-12d3-a456-426614174000]]",
    "[[MERIDIAN_SUMMARY_END id=123e4567-e89b-12d3-a456-426614174000]]"
  ].join("\n");

  const result = classifyAgentOutput(protocolOnly);
  assert.equal(result.kind, "transient");
});
