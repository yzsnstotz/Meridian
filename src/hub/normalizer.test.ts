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
  assert.equal(message.actor_id, "tg:7");
  assert.equal(message.reply_channel.chat_id, "telegram:12345");
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
      content: "/model thread=gemini_01 model=claude-sonnet-4-6",
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
  assert.equal(message.target, "gemini_01");
  assert.equal(message.payload.content, "claude-sonnet-4-6");
  assert.equal(message.mode, "bridge");
});

test("normalizeInboundEvent accepts numeric /approve selections", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "103b",
      sender_id: 7,
      content: "/approve 4 thread=gemini_01",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: null
    },
    {
      chatId: "67890"
    }
  );

  assert.equal(message.intent, "terminal_input");
  assert.equal(message.thread_id, "gemini_01");
  assert.equal(message.target, "gemini_01");
  assert.equal(message.payload.content, "4");
});

test("normalizeInboundEvent rejects bare /model without a model id", () => {
  assert.throws(
    () =>
      normalizeInboundEvent(
        {
          channel: "telegram",
          raw_message_id: "103a",
          sender_id: 7,
          content: "/model",
          attachments: [],
          timestamp: new Date().toISOString(),
          reply_to: "codex_01"
        },
        {
          chatId: "67890"
        }
      ),
    /\/model requires model=<provider_model_id>/
  );
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

test("normalizeInboundEvent parses /info as active-thread status", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "105a",
      sender_id: 7,
      content: "/info",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: null
    },
    {
      chatId: "67890"
    }
  );

  assert.equal(message.intent, "status");
  assert.equal(message.thread_id, "active");
  assert.equal(message.target, "active");
});

test("normalizeInboundEvent preserves bot_id in reply channel when provided", () => {
  const message = normalizeInboundEvent(
    {
      channel: "telegram",
      raw_message_id: "106",
      sender_id: 7,
      content: "hello",
      attachments: [],
      timestamp: new Date().toISOString(),
      reply_to: null
    },
    {
      chatId: "67890",
      botId: "123456789"
    }
  );

  assert.equal(message.reply_channel.chat_id, "telegram:67890");
  assert.equal(message.reply_channel.bot_id, "123456789");
});
