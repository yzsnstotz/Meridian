import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTelegramActorId, formatTelegramChatId, parseTelegramMessage } from "./parser";

test("formatTelegram identity helpers build composite IDs", () => {
  assert.equal(formatTelegramChatId(12345), "telegram:12345");
  assert.equal(formatTelegramActorId(77), "tg:77");
});

test("parseTelegramMessage returns composite chat_id and actor_id", async () => {
  const parsed = await parseTelegramMessage({
    message: {
      message_id: 101,
      chat: { id: 12345, type: "private", first_name: "Alice", last_name: "Ng" },
      from: { id: 77 },
      text: "hello",
      date: Math.floor(Date.now() / 1000)
    },
    api: {
      token: "123456789:test_token"
    },
    me: {
      id: 123456789,
      username: "meridian_bot"
    }
  } as never);

  assert.equal(parsed?.chatId, "telegram:12345");
  assert.equal(parsed?.actorId, "tg:77");
  assert.equal(parsed?.botId, "123456789");
  assert.equal(parsed?.chatName, "Alice Ng");
  assert.equal(parsed?.botName, "@meridian_bot");
  assert.equal(parsed?.event.sender_id, 77);
});
