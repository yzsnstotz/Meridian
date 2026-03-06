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

test("normalizeInboundEvent parses /model command", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "103",
      sender_id: 7,
      content: "/model thread=gemini_01 type=claude",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: null
    },
    {
      chatId: "67890"
    }
  );

  assert.equal(message.intent, "switch_model");
  assert.equal(message.thread_id, "gemini_01");
  assert.equal(message.target, "claude");
  assert.equal(message.mode, "bridge");
});

test("normalizeInboundEvent parses /update command", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "104",
      sender_id: 7,
      content: "/update on thread=codex_01 interval=30",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: null
    },
    {
      chatId: "67890"
    }
  );

  assert.equal(message.intent, "monitor_update");
  assert.equal(message.thread_id, "codex_01");
  assert.equal(message.target, "codex_01");
  assert.equal(message.payload.monitor_updates_enabled, true);
  assert.equal(message.payload.monitor_updates_interval_sec, 30);
});

test("normalizeInboundEvent parses /mupdate command", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "105",
      sender_id: 7,
      content: "/mupdate thread=codex_01",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: null
    },
    {
      chatId: "67890"
    }
  );

  assert.equal(message.intent, "monitor_manual_update");
  assert.equal(message.thread_id, "codex_01");
  assert.equal(message.target, "codex_01");
  assert.equal(message.payload.monitor_updates_enabled, undefined);
  assert.equal(message.payload.monitor_updates_interval_sec, undefined);
});
