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

test("classifyAgentOutput recognizes Codex-style approval prompt", () => {
  const codexFrame = [
    "Would you like to run the following command?",
    "",
    "Reason: Do you want me to query the live local web API so I can confirm why",
    "the GUI and /list data are out of sync on the running service?",
    "",
    "$ curl --max-time 5 -sS 'http://127.0.0.1:3000/api/instances?token=meridian-gui-token'",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `curl --max-time 5` (p)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "Press enter to confirm or esc to cancel"
  ].join("\n");

  const result = classifyAgentOutput(codexFrame);
  assert.equal(result.kind, "action_required");
  assert.match(result.text, /^Waiting for approval\.\.\./);
  assert.match(result.text, /Run this command\?/);
  assert.match(result.text, /curl --max-time 5/);
  assert.match(result.text, /1\.\s*Yes, proceed/);
  assert.match(result.text, /3\.\s*No, and tell Codex what to do differently/);
});
