import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

process.env.LOG_DIR ??= "/tmp/meridian-test-logs";

import type { HubResult, ReplyChannel } from "../types";
import { ResultSender, TelegramChannelAdapter, decorateTelegramResultText, resolveTelegramDetailRecord, splitTextForTelegram } from "./result-sender";

test("splitTextForTelegram preserves content exactly", () => {
  const content = `header\n\n    indented line\n${"x".repeat(5000)}\nfooter`;
  const chunks = splitTextForTelegram(content, 300);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), content);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
});

test("splitTextForTelegram handles text with no newline", () => {
  const content = "a".repeat(9300);
  const chunks = splitTextForTelegram(content, 1024);
  assert.equal(chunks.join(""), content);
  assert.ok(chunks.every((chunk) => chunk.length <= 1024));
});

test("splitTextForTelegram returns empty array for empty input", () => {
  assert.deepEqual(splitTextForTelegram("", 200), []);
});

test("decorateTelegramResultText appends approval guidance for approval prompts", () => {
  const text = decorateTelegramResultText({
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    thread_id: "cursor_01",
    source: "cursor",
    status: "success",
    content: "Waiting for approval...\nRun this command?\nAdd Shell(git status) to allowlist?",
    attachments: [],
    timestamp: new Date().toISOString()
  });

  assert.match(text, /\/approve run thread=cursor_01/);
  assert.match(text, /reply to this message with exactly: y, allow, all, or n/i);
});

test("ResultSender strips telegram: prefix before sending to Telegram API", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: (
      botToken: string,
      chatId: string,
      filePath: string,
      filename: string,
      caption?: string,
      replyToMessageId?: number
    ) => Promise<void>;
  };
  const sender = new ResultSender([bridge]);
  const sentChatIds: string[] = [];
  bridgeMock.sendTextWithRetry = async (_botToken: string, chatId: string) => {
    sentChatIds.push(chatId);
  };
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  const result: HubResult = {
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    thread_id: "codex_01",
    source: "codex",
    status: "success",
    content: "ok",
    attachments: [],
    timestamp: new Date().toISOString()
  };
  const replyChannel: ReplyChannel = {
    channel: "telegram",
    chat_id: "telegram:12345"
  };

  await sender.sendResult(result, replyChannel);
  assert.deepEqual(sentChatIds, ["12345"]);
});

test("ResultSender sends oversized content as a temporary text file and removes it afterwards", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: (
      botToken: string,
      chatId: string,
      filePath: string,
      filename: string,
      caption?: string,
      replyToMessageId?: number
    ) => Promise<void>;
  };
  const sender = new ResultSender([bridge]);

  let textSendCount = 0;
  let capturedFilePath = "";
  let capturedFilename = "";
  let capturedContent = "";
  bridgeMock.sendTextWithRetry = async () => {
    textSendCount += 1;
  };
  bridgeMock.sendDocumentWithRetry = async (_botToken, chatId, filePath, filename) => {
    assert.equal(chatId, "12345");
    capturedFilePath = filePath;
    capturedFilename = filename;
    assert.ok(fs.existsSync(filePath));
    capturedContent = fs.readFileSync(filePath, "utf8");
  };

  const traceId = "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8";
  const result: HubResult = {
    trace_id: traceId,
    thread_id: "codex_01",
    source: "codex",
    status: "success",
    content: "x".repeat(5000),
    attachments: [],
    timestamp: new Date().toISOString()
  };

  await sender.sendResult(result, {
    channel: "telegram",
    chat_id: "telegram:12345"
  });

  assert.equal(textSendCount, 0);
  assert.equal(capturedFilename, `meridian-${traceId}.txt`);
  assert.doesNotMatch(capturedContent, new RegExp(`trace=${traceId}`));
  assert.doesNotMatch(capturedContent, /\/detail trace=/);
  assert.equal(fs.existsSync(capturedFilePath), false);
});

test("ResultSender caches full detail text for /detail retrieval", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: () => Promise<void>;
  };
  const sender = new ResultSender([bridge]);
  bridgeMock.sendTextWithRetry = async () => undefined;
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  const result: HubResult = {
    trace_id: "81f8b79e-b32f-44e7-8f07-6f1f4be8f2f7",
    thread_id: "codex_01",
    source: "codex",
    status: "success",
    content: "final summary\n\nraw detail line",
    attachments: [],
    timestamp: new Date().toISOString()
  };
  const replyChannel: ReplyChannel = {
    channel: "telegram",
    chat_id: "telegram:12345",
    bot_id: "123456789"
  };
  await sender.sendResult(result, replyChannel);

  const detail = resolveTelegramDetailRecord({
    chatId: "telegram:12345",
    botId: "123456789",
    traceId: result.trace_id
  });
  assert.ok(detail);
  assert.equal(detail?.traceId, result.trace_id);
  assert.equal(detail?.fullText, decorateTelegramResultText(result));
});

test("ResultSender prefers shared history summary/details when provided", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: () => Promise<void>;
  };
  const sender = new ResultSender([bridge]);
  let sentText = "";
  bridgeMock.sendTextWithRetry = async (_botToken, _chatId, text) => {
    sentText = text;
  };
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  const traceId = "d23f6b56-46a4-4fcb-a57d-9325317cdd62";
  await sender.sendResult(
    {
      trace_id: traceId,
      thread_id: "codex_01",
      source: "codex",
      status: "success",
      content: "raw upstream payload that should not leak into summary",
      summary_text: "pane summary",
      details_text: "Your message:\nhello\n\nAgent reply:\nfull detail body",
      attachments: [],
      timestamp: new Date().toISOString()
    },
    {
      channel: "telegram",
      chat_id: "12345"
    }
  );

  assert.match(sentText, /pane summary/);
  assert.doesNotMatch(sentText, /raw upstream payload/);

  const detail = resolveTelegramDetailRecord({ chatId: "12345", traceId });
  assert.ok(detail);
  assert.match(detail?.fullText ?? "", /Your message:\nhello/);
  assert.match(detail?.fullText ?? "", /Agent reply:\nfull detail body/);
});

test("ResultSender suppresses duplicate Telegram deliveries with the same pane fingerprint", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: () => Promise<void>;
    log: { info: () => void; warn: () => void; error: () => void };
  };
  const sender = new ResultSender([bridge]);
  bridgeMock.log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
  let sendCount = 0;
  bridgeMock.sendTextWithRetry = async () => {
    sendCount += 1;
  };
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  const replyChannel: ReplyChannel = {
    channel: "telegram",
    chat_id: "telegram:12345",
    bot_id: "123456789"
  };
  const baseResult = {
    thread_id: "codex_01",
    source: "codex" as const,
    status: "success" as const,
    content: "raw",
    summary_text: "same summary",
    details_text: "same detail",
    attachments: [],
    timestamp: new Date().toISOString()
  };

  await sender.sendResult(
    {
      ...baseResult,
      trace_id: "78bd18f5-b9bb-4203-b434-b41c2f3c89c8"
    },
    replyChannel
  );
  await sender.sendResult(
    {
      ...baseResult,
      trace_id: "27873689-b0f5-458b-8628-b8b4cf64c20b"
    },
    replyChannel
  );

  assert.equal(sendCount, 1);
  assert.ok(resolveTelegramDetailRecord({ chatId: "telegram:12345", botId: "123456789", traceId: "27873689-b0f5-458b-8628-b8b4cf64c20b" }));
});

test("ResultSender avoids adding /detail hint for short summary content", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: () => Promise<void>;
  };
  const sender = new ResultSender([bridge]);
  let sentText = "";
  bridgeMock.sendTextWithRetry = async (_botToken, _chatId, text) => {
    sentText = text;
  };
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  await sender.sendResult(
    {
      trace_id: "6b0cc95f-85e9-49eb-b18b-3e5f3fa0ed06",
      thread_id: "codex_01",
      source: "codex",
      status: "success",
      content: "Task completed successfully.",
      attachments: [],
      timestamp: new Date().toISOString()
    },
    {
      channel: "telegram",
      chat_id: "12345"
    }
  );

  assert.doesNotMatch(sentText, /\/detail trace=/);
  assert.doesNotMatch(sentText, /^trace=/);
});

test("ResultSender forwards inline keyboard metadata to Telegram sendMessage", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (
      botToken: string,
      chatId: string,
      text: string,
      replyToMessageId?: number,
      replyMarkup?: Record<string, unknown>
    ) => Promise<void>;
    sendDocumentWithRetry: () => Promise<void>;
  };
  const sender = new ResultSender([bridge]);

  let capturedReplyMarkup: Record<string, unknown> | undefined;
  bridgeMock.sendTextWithRetry = async (_botToken, _chatId, _text, _replyToMessageId, replyMarkup) => {
    capturedReplyMarkup = replyMarkup;
  };
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  await sender.sendResult(
    {
      trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
      thread_id: "codex_01",
      source: "codex",
      status: "success",
      content: "ok",
      attachments: [],
      telegram_inline_keyboard: {
        inline_keyboard: [[{ text: "Open GUI", url: "http://gui.example.com/?thread=codex_01" }]]
      },
      timestamp: new Date().toISOString()
    },
    {
      channel: "telegram",
      chat_id: "12345"
    }
  );

  assert.deepEqual(capturedReplyMarkup, {
    inline_keyboard: [[{ text: "Open GUI", url: "http://gui.example.com/?thread=codex_01" }]]
  });
});

test("ResultSender parses trace-bound summary block and hides protocol tags", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: () => Promise<void>;
  };
  const sender = new ResultSender([bridge]);
  let sentText = "";
  bridgeMock.sendTextWithRetry = async (_botToken, _chatId, text) => {
    sentText = text;
  };
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  const traceId = "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8";
  await sender.sendResult(
    {
      trace_id: traceId,
      thread_id: "codex_01",
      source: "codex",
      status: "success",
      content:
        `before raw\n` +
        `[[MERIDIAN_SUMMARY_BEGIN id=${traceId}]]\n` +
        "Final answer in summary.\n" +
        `[[MERIDIAN_SUMMARY_END id=${traceId}]]\n` +
        "after raw",
      attachments: [],
      timestamp: new Date().toISOString()
    },
    {
      channel: "telegram",
      chat_id: "12345"
    }
  );

  assert.match(sentText, /Final answer in summary\./);
  assert.doesNotMatch(sentText, /\[\[MERIDIAN_SUMMARY_(BEGIN|END)/);

  const detail = resolveTelegramDetailRecord({ chatId: "12345", traceId });
  assert.ok(detail);
  assert.doesNotMatch(detail?.fullText ?? "", /\[\[MERIDIAN_SUMMARY_(BEGIN|END)/);
});

test("ResultSender marks missing summary end as incomplete", async () => {
  const bridge = new TelegramChannelAdapter({ botToken: "123456789:test_token" });
  const bridgeMock = bridge as unknown as {
    sendTextWithRetry: (botToken: string, chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
    sendDocumentWithRetry: () => Promise<void>;
  };
  const sender = new ResultSender([bridge]);
  let sentText = "";
  bridgeMock.sendTextWithRetry = async (_botToken, _chatId, text) => {
    sentText = text;
  };
  bridgeMock.sendDocumentWithRetry = async () => undefined;

  const traceId = "81f8b79e-b32f-44e7-8f07-6f1f4be8f2f7";
  await sender.sendResult(
    {
      trace_id: traceId,
      thread_id: "codex_01",
      source: "codex",
      status: "success",
      content: `[[MERIDIAN_SUMMARY_BEGIN id=${traceId}]]\npartial response still streaming`,
      attachments: [],
      timestamp: new Date().toISOString()
    },
    {
      channel: "telegram",
      chat_id: "12345"
    }
  );

  assert.match(sentText, /\(summary incomplete\)/);
});
