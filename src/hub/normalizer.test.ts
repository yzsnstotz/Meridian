import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeInboundEvent } from "./normalizer";

test("normalizeInboundEvent converts free text into run HubMessage", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "101",
      sender_id: 7,
      content: "Refactor src/index.ts",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: "claude_01"
    },
    {
      chatId: "12345"
    }
  );

  assert.equal(message.intent, "run");
  assert.equal(message.thread_id, "claude_01");
  assert.equal(message.target, "claude_01");
  assert.equal(message.reply_channel.chat_id, "12345");
});

test("normalizeInboundEvent parses /spawn command", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "102",
      sender_id: 7,
      content: "/spawn type=codex mode=pane_bridge",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: null
    },
    {
      chatId: "67890"
    }
  );

  assert.equal(message.intent, "spawn");
  assert.equal(message.target, "codex");
  assert.equal(message.mode, "pane_bridge");
});
