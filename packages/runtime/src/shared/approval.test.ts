import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isApprovalPrompt,
  normalizeApprovalSelection,
  parseApprovalSummaryFromRawContent,
  selectApprovalOptionInput
} from "./approval";

test("parseApprovalSummaryFromRawContent normalizes Gemini edit approval prompts", () => {
  const frame = [
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ Action Required                                                              │",
    "│                                                                              │",
    "│ ?  Edit .gitignore: .context/ => .context/                                   │",
    "│                                                                              │",
    "│ 5   .DS_Store                                                                │",
    "│ 6   bin/agentapi                                                             │",
    "│ 7   .context/                                                                │",
    "│ 8 + docs/                                                                    │",
    "│ Apply this change?                                                           │",
    "│                                                                              │",
    "│ ● 1. Allow once                                                              │",
    "│   2. Allow for this session                                                  │",
    "│   3. Modify with external editor                                             │",
    "│   4. No, suggest changes (esc)                                               │",
    "│                                                                              │",
    "╰──────────────────────────────────────────────────────────────────────────────╯"
  ].join("\n");

  const summary = parseApprovalSummaryFromRawContent(frame);
  assert.match(summary ?? "", /^Waiting for approval\.\.\./);
  assert.match(summary ?? "", /Apply this change\?/);
  assert.match(summary ?? "", /Edit \.gitignore: \.context\/ => \.context\//);
  assert.match(summary ?? "", /3\. Modify with external editor/);
  assert.match(summary ?? "", /4\. No, suggest changes/);
  assert.equal(selectApprovalOptionInput(frame, "run"), "1");
  assert.equal(selectApprovalOptionInput(frame, "allow"), "2");
  assert.equal(selectApprovalOptionInput(frame, "all"), "2");
  assert.equal(selectApprovalOptionInput(frame, "skip"), "4");
});

test("normalizeApprovalSelection accepts numeric approval choices", () => {
  assert.equal(normalizeApprovalSelection("4"), "4");
  assert.equal(normalizeApprovalSelection(" allow "), "allow");
  assert.equal(normalizeApprovalSelection("unknown"), null);
});

test("isApprovalPrompt recognizes canonical apply-change approval summaries", () => {
  const canonicalSummary = [
    "Waiting for approval...",
    "Apply this change?",
    "Edit .gitignore: .context/ => .context/",
    "1. Allow once",
    "2. Allow for this session",
    "3. Modify with external editor",
    "4. No, suggest changes"
  ].join("\n");

  assert.equal(isApprovalPrompt(canonicalSummary), true);
});
