import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

import { config } from "../../config";
import { createLogger } from "../../logger";
import { buildTelegramApprovalHint, isApprovalPrompt } from "../../shared/approval";
import {
  HubResultSchema,
  type HubResult,
  type ReplyChannel,
  type TelegramInlineKeyboard
} from "../../types";
import type { ChannelAdapter } from "../../hub/channel-adapter";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_SAFE_TEXT_LIMIT = 3500;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_MAX_SEND_ATTEMPTS = 5;
const TELEGRAM_RETRY_BACKOFF_BASE_MS = 500;
const TELEGRAM_RETRY_BACKOFF_MAX_MS = 8000;
const TELEGRAM_DETAIL_CACHE_LIMIT = 200;
const TELEGRAM_DUPLICATE_WINDOW_MS = 120 * 1000;
const SUMMARY_INCOMPLETE_LABEL = "summary incomplete";
const SUMMARY_MARKER_BEGIN = "[[MERIDIAN_SUMMARY_BEGIN";
const SUMMARY_MARKER_END = "[[MERIDIAN_SUMMARY_END";

interface TelegramDetailCacheRecord {
  traceId: string;
  threadId: string;
  source: HubResult["source"];
  status: HubResult["status"];
  fullText: string;
  summaryText: string;
  chatId: string;
  botId: string | null;
  createdAtMs: number;
}

interface TelegramDetailLookupOptions {
  chatId: string;
  botId?: string;
  traceId?: string;
  threadId?: string;
}

const telegramDetailCache = new Map<string, TelegramDetailCacheRecord[]>();

interface TelegramApiResponseBody {
  ok?: boolean;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly statusCode: number | undefined,
    readonly retryAfterSeconds: number | undefined
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export function splitTextForTelegram(content: string, limit = TELEGRAM_SAFE_TEXT_LIMIT): string[] {
  if (limit <= 0) {
    throw new Error(`Invalid Telegram chunk limit: ${limit}`);
  }

  if (content.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let offset = 0;

  while (offset < content.length) {
    const remaining = content.length - offset;
    if (remaining <= limit) {
      chunks.push(content.slice(offset));
      break;
    }

    const window = content.slice(offset, offset + limit);
    let splitIndex = window.lastIndexOf("\n");
    if (splitIndex <= Math.floor(limit * 0.5)) {
      splitIndex = limit;
    }
    if (splitIndex <= 0) {
      splitIndex = Math.min(limit, remaining);
    }

    chunks.push(content.slice(offset, offset + splitIndex));
    offset += splitIndex;
  }

  return chunks;
}

function stripMeridianContentFraming(content: string): string {
  return content.replace(/^\[thread=[^\]]*\]\n?/, "");
}

function parseSummaryTagId(tagText: string): string | null {
  const matched = tagText.match(/\bid=([0-9a-fA-F-]{36})\b/);
  return matched?.[1]?.toLowerCase() ?? null;
}

function stripSummaryProtocolTags(content: string): string {
  return content
    .replace(/\[\[MERIDIAN_SUMMARY_BEGIN[^\]]*\]\]\s*/g, "")
    .replace(/\s*\[\[MERIDIAN_SUMMARY_END[^\]]*\]\]/g, "")
    .trim();
}

function isLowValueLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (/^(heartbeat|typing)\b/i.test(trimmed)) {
    return true;
  }
  if (/^(status:\s*(running|idle|live)|connected|reconnecting)$/i.test(trimmed)) {
    return true;
  }
  if (/^(\$|>|#)\s*(pwd|ls|cd)\b/.test(trimmed)) {
    return true;
  }
  if (/^\/[\w./-]+$/.test(trimmed) || /^\.\/[\w./-]+$/.test(trimmed)) {
    return true;
  }
  if (/^\[[0-9:. -]+\]/.test(trimmed)) {
    return true;
  }
  return false;
}

function extractSummaryBlocks(
  content: string,
  traceId: string
): { summary: string | null; residual: string; incomplete: boolean } {
  const beginIndex = content.indexOf(SUMMARY_MARKER_BEGIN);
  if (beginIndex < 0) {
    return { summary: null, residual: content, incomplete: false };
  }

  const beginClose = content.indexOf("]]", beginIndex);
  if (beginClose < 0) {
    return { summary: null, residual: content, incomplete: false };
  }

  const beginTag = content.slice(beginIndex, beginClose + 2);
  if (beginTag.includes("\n")) {
    return { summary: null, residual: content, incomplete: false };
  }
  const beginId = parseSummaryTagId(beginTag);
  if (!beginId || beginId !== traceId.toLowerCase()) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }

  const endIndex = content.indexOf(SUMMARY_MARKER_END, beginClose + 2);
  if (endIndex < 0) {
    const partial = content.slice(beginClose + 2).trim();
    const summary = partial ? `${partial}\n\n(${SUMMARY_INCOMPLETE_LABEL})` : SUMMARY_INCOMPLETE_LABEL;
    const residual = `${content.slice(0, beginIndex)}\n${partial}`.trim();
    return { summary, residual, incomplete: true };
  }

  const endClose = content.indexOf("]]", endIndex);
  if (endClose < 0) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }

  const endTag = content.slice(endIndex, endClose + 2);
  if (endTag.includes("\n")) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }
  const endId = parseSummaryTagId(endTag);
  if (!endId || endId !== beginId) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }

  const summary = content.slice(beginClose + 2, endIndex).trim();
  const residual = `${content.slice(0, beginIndex)}${content.slice(endClose + 2)}`.trim();
  return {
    summary: summary || null,
    residual,
    incomplete: false
  };
}

function summarizeText(content: string, traceId: string): { summary: string; details: string; truncated: boolean } {
  const extracted = extractSummaryBlocks(content, traceId);
  if (extracted.summary) {
    const details = extracted.residual.trim();
    return { summary: extracted.summary, details, truncated: extracted.incomplete || details.length > 0 };
  }

  const normalized = stripSummaryProtocolTags(content);
  const lines = normalized.split(/\r?\n/).map((line) => line.trimEnd());
  const informativeLines = lines
    .filter((line) => !isLowValueLine(line))
    .filter((line) => !/^(\+\+\+|---|@@|diff\s|index\s)/.test(line));
  const summaryLines = informativeLines.slice(0, 6);
  const fallbackSummary = summaryLines.join("\n").trim();
  const details = normalized.trim();
  return {
    summary: fallbackSummary || "Update received. Use /detail to view full output.",
    details,
    truncated: informativeLines.length > summaryLines.length || details.length > Math.max(fallbackSummary.length + 80, 260)
  };
}

export function decorateTelegramResultText(result: HubResult): string {
  const tag = `trace=${result.trace_id}`;
  const body = stripMeridianContentFraming(stripSummaryProtocolTags(result.content)).trim();
  if (!body) {
    return tag;
  }
  const baseText = `${tag}\n\n${body}`;
  if (!isApprovalPrompt(result.content)) {
    return baseText;
  }
  return `${baseText}${buildTelegramApprovalHint(result.thread_id)}`;
}

function composeSummaryTelegramText(result: HubResult, summaryText: string, includeDetailHint: boolean): string {
  const tag = `trace=${result.trace_id}`;
  const body = stripMeridianContentFraming(summaryText).trim();
  if (!includeDetailHint) {
    return `${tag}\n\n${body}`;
  }
  return `${tag}\n\n${body}\n\n/detail trace=${result.trace_id}`;
}

function makeDetailCacheKey(chatId: string, botId: string | null): string {
  return `${botId ?? "default"}::${chatId}`;
}

function composeDetailTelegramText(result: HubResult, detailText: string): string {
  const tag = `trace=${result.trace_id}`;
  const body = stripMeridianContentFraming(detailText).trim();
  return body ? `${tag}\n\n${body}` : tag;
}

function makeTelegramMessageFingerprint(summaryText: string, detailText: string): string {
  return ["agent", summaryText.trim(), detailText.trim()].join("\n---\n");
}

function saveTelegramDetailRecord(
  replyChannel: ReplyChannel,
  result: HubResult,
  fullText: string,
  summaryText: string
): void {
  const key = makeDetailCacheKey(replyChannel.chat_id, replyChannel.bot_id ?? null);
  const records = telegramDetailCache.get(key) ?? [];
  records.unshift({
    traceId: result.trace_id,
    threadId: result.thread_id,
    source: result.source,
    status: result.status,
    fullText,
    summaryText,
    chatId: replyChannel.chat_id,
    botId: replyChannel.bot_id ?? null,
    createdAtMs: Date.now()
  });
  if (records.length > TELEGRAM_DETAIL_CACHE_LIMIT) {
    records.length = TELEGRAM_DETAIL_CACHE_LIMIT;
  }
  telegramDetailCache.set(key, records);
}

export function resolveTelegramDetailRecord(
  options: TelegramDetailLookupOptions
): TelegramDetailCacheRecord | null {
  const key = makeDetailCacheKey(options.chatId, options.botId ?? null);
  const records = telegramDetailCache.get(key);
  if (!records || records.length === 0) {
    return null;
  }

  if (options.traceId) {
    const byTrace = records.find((record) => record.traceId === options.traceId);
    if (byTrace) {
      return byTrace;
    }
  }
  if (options.threadId) {
    const byThread = records.find((record) => record.threadId === options.threadId);
    if (byThread) {
      return byThread;
    }
  }
  return records[0] ?? null;
}

export function shouldPushTelegramProactive(result: HubResult): boolean {
  if (!config.TELEGRAM_PUSH_WHITELIST_ONLY) {
    return true;
  }
  if (result.status === "error") {
    return true;
  }
  if (isApprovalPrompt(result.content)) {
    return true;
  }
  const normalized = result.content.toLowerCase();
  if (normalized.includes("completed") || normalized.includes("done") || normalized.includes("finished")) {
    return true;
  }
  return false;
}

export interface TelegramAdapterOptions {
  botToken?: string;
  botTokens?: string[];
}

function extractBotIdFromToken(token: string): string {
  const [rawBotId] = token.trim().split(":");
  if (!rawBotId || !/^\d+$/.test(rawBotId)) {
    throw new Error("Telegram bot token must use format '<bot_id>:<secret>'");
  }
  return rawBotId;
}

function parseAdditionalBotTokens(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveConfiguredBotTokens(): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of [config.TELEGRAM_BOT_TOKEN, ...parseAdditionalBotTokens(config.TELEGRAM_BOT_TOKENS)]) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}

function resolveTelegramTargetChatId(chatId: string): string {
  return chatId.startsWith("telegram:") ? chatId.slice("telegram:".length) : chatId;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  private readonly log = createLogger("hub");
  private readonly defaultBotToken: string;
  private readonly botTokenById: Map<string, string>;
  private readonly recentTelegramFingerprints = new Map<string, number>();

  constructor(options: TelegramAdapterOptions = {}) {
    const tokens = options.botToken
      ? [options.botToken]
      : options.botTokens ?? resolveConfiguredBotTokens();
    if (tokens.length === 0) {
      throw new Error("At least one Telegram bot token is required");
    }

    this.defaultBotToken = tokens[0];
    this.botTokenById = new Map<string, string>();
    for (const token of tokens) {
      const botId = extractBotIdFromToken(token);
      if (this.botTokenById.has(botId)) {
        throw new Error(`Duplicate Telegram bot_id detected in configured tokens: ${botId}`);
      }
      this.botTokenById.set(botId, token);
    }
  }

  canHandle(replyChannel: ReplyChannel): boolean {
    return replyChannel.channel === "telegram";
  }

  async send(result: HubResult, replyChannel: ReplyChannel): Promise<void> {
    const botToken = this.resolveBotToken(replyChannel.bot_id);
    const replyToMessageId = this.toMessageId(replyChannel.message_id);
    const targetChatId = resolveTelegramTargetChatId(replyChannel.chat_id);
    const summarized =
      result.summary_text !== undefined && result.details_text !== undefined
        ? {
            summary: result.summary_text,
            details: result.details_text,
            truncated:
              result.details_text.trim().length > 0 && result.details_text.trim() !== result.summary_text.trim()
          }
        : summarizeText(result.content, result.trace_id);
    const fullTextBody =
      result.details_text !== undefined
        ? composeDetailTelegramText(result, result.details_text || result.summary_text || result.content)
        : decorateTelegramResultText(result);
    const summaryBody = composeSummaryTelegramText(
      result,
      summarized.summary,
      summarized.truncated && !isApprovalPrompt(result.content)
    );
    const textBody = config.TELEGRAM_SUMMARY_ONLY ? summaryBody : fullTextBody;
    const replyMarkup = result.telegram_inline_keyboard;

    saveTelegramDetailRecord(replyChannel, result, fullTextBody, summaryBody);
    if (this.shouldSkipDuplicateTelegramDelivery(replyChannel, result, summarized.summary, summarized.details)) {
      return;
    }

    if (textBody.length > TELEGRAM_TEXT_LIMIT) {
      await this.sendContentAsFile(botToken, targetChatId, textBody, replyToMessageId, {
        traceId: result.trace_id,
        threadId: result.thread_id
      }, replyMarkup);
    } else {
      await this.sendTextWithRetry(botToken, targetChatId, textBody, replyToMessageId, replyMarkup);
    }

    for (const attachment of result.attachments) {
      const filename = attachment.filename ?? path.basename(attachment.path);
      await this.sendDocumentWithRetry(
        botToken,
        targetChatId,
        attachment.path,
        filename,
        undefined,
        replyToMessageId
      );
    }

    this.log.info(
      {
        trace_id: result.trace_id,
        thread_id: result.thread_id,
        status: result.status,
        target: targetChatId,
        bot_id: replyChannel.bot_id ?? extractBotIdFromToken(botToken)
      },
      "HubResult delivered to Telegram"
    );
  }

  private shouldSkipDuplicateTelegramDelivery(
    replyChannel: ReplyChannel,
    result: HubResult,
    summaryText: string,
    detailText: string
  ): boolean {
    const nowMs = Date.now();
    for (const [key, sentAtMs] of this.recentTelegramFingerprints.entries()) {
      if (nowMs - sentAtMs > TELEGRAM_DUPLICATE_WINDOW_MS) {
        this.recentTelegramFingerprints.delete(key);
      }
    }

    const fingerprint = makeTelegramMessageFingerprint(summaryText, detailText);
    const cacheKey = `${makeDetailCacheKey(replyChannel.chat_id, replyChannel.bot_id ?? null)}::${result.thread_id}::${fingerprint}`;
    const previous = this.recentTelegramFingerprints.get(cacheKey);
    if (previous && nowMs - previous < TELEGRAM_DUPLICATE_WINDOW_MS) {
      this.log.info(
        {
          trace_id: result.trace_id,
          thread_id: result.thread_id,
          target: replyChannel.chat_id,
          bot_id: replyChannel.bot_id ?? null
        },
        "Duplicate Telegram delivery suppressed"
      );
      this.recentTelegramFingerprints.set(cacheKey, nowMs);
      return true;
    }

    this.recentTelegramFingerprints.set(cacheKey, nowMs);
    return false;
  }

  private async sendContentAsFile(
    botToken: string,
    chatId: string,
    content: string,
    replyToMessageId?: number,
    context?: {
      traceId: string;
      threadId: string;
    },
    replyMarkup?: TelegramInlineKeyboard
  ): Promise<void> {
    const filePath = path.join("/tmp", `meridian-${context?.traceId ?? randomUUID()}.txt`);
    this.log.info(
      {
        trace_id: context?.traceId ?? null,
        thread_id: context?.threadId ?? null,
        chat_id: chatId,
        total_characters: content.length
      },
      "Sending long Telegram reply as text attachment"
    );

    await fs.promises.writeFile(filePath, content, "utf8");
    try {
      await this.sendDocumentWithRetry(
        botToken,
        chatId,
        filePath,
        path.basename(filePath),
        undefined,
        replyToMessageId,
        replyMarkup
      );
    } finally {
      await fs.promises.unlink(filePath).catch(() => undefined);
    }
  }

  private async sendTextWithRetry(
    botToken: string,
    chatId: string,
    text: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramInlineKeyboard
  ): Promise<void> {
    await this.withTelegramRetry(
      () => this.sendText(botToken, chatId, text, replyToMessageId, replyMarkup),
      "sendMessage"
    );
  }

  private async sendDocumentWithRetry(
    botToken: string,
    chatId: string,
    filePath: string,
    filename: string,
    caption?: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramInlineKeyboard
  ): Promise<void> {
    await this.withTelegramRetry(
      () => this.sendDocument(botToken, chatId, filePath, filename, caption, replyToMessageId, replyMarkup),
      "sendDocument"
    );
  }

  private async withTelegramRetry(
    operation: () => Promise<void>,
    endpoint: "sendMessage" | "sendDocument"
  ): Promise<void> {
    for (let attempt = 1; attempt <= TELEGRAM_MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        const retryDelayMs = this.resolveRetryDelay(error, attempt);
        if (retryDelayMs === null || attempt >= TELEGRAM_MAX_SEND_ATTEMPTS) {
          throw error;
        }
        this.log.warn(
          {
            trace_id: null,
            thread_id: null,
            endpoint,
            attempt,
            retry_delay_ms: retryDelayMs,
            err: error instanceof Error ? error.message : String(error)
          },
          "Telegram delivery failed, retrying"
        );
        await this.delay(retryDelayMs);
      }
    }
  }

  private resolveRetryDelay(error: unknown, attempt: number): number | null {
    const jitterMs = Math.floor(Math.random() * 200);
    const exponentialBackoffMs = Math.min(
      TELEGRAM_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1),
      TELEGRAM_RETRY_BACKOFF_MAX_MS
    );

    if (error instanceof TelegramApiError) {
      if (error.retryAfterSeconds && error.retryAfterSeconds > 0) {
        return error.retryAfterSeconds * 1000 + 200;
      }
      if (error.statusCode === 429 || (error.statusCode !== undefined && error.statusCode >= 500)) {
        return exponentialBackoffMs + jitterMs;
      }
      return null;
    }

    if (error && typeof error === "object") {
      const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EAI_AGAIN") {
        return exponentialBackoffMs + jitterMs;
      }
    }

    return null;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async sendText(
    botToken: string,
    chatId: string,
    text: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramInlineKeyboard
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text
    };
    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    await this.postJson(botToken, "/sendMessage", payload);
  }

  private async sendDocument(
    botToken: string,
    chatId: string,
    filePath: string,
    filename: string,
    caption?: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramInlineKeyboard
  ): Promise<void> {
    const fileData = await fs.promises.readFile(filePath);
    const boundary = `----MeridianBoundary${randomUUID()}`;
    const parts: Buffer[] = [];

    parts.push(this.formField(boundary, "chat_id", chatId));
    if (caption && caption.trim().length > 0) {
      parts.push(this.formField(boundary, "caption", caption.slice(0, TELEGRAM_CAPTION_LIMIT)));
    }
    if (replyToMessageId) {
      parts.push(this.formField(boundary, "reply_to_message_id", String(replyToMessageId)));
    }
    if (replyMarkup) {
      parts.push(this.formField(boundary, "reply_markup", JSON.stringify(replyMarkup)));
    }
    parts.push(this.formFile(boundary, "document", filename, fileData));
    parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

    const body = Buffer.concat(parts);

    await this.postBuffer(botToken, `/sendDocument`, body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    });
  }

  private formField(boundary: string, name: string, value: string): Buffer {
    return Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8"
    );
  }

  private formFile(boundary: string, fieldName: string, filename: string, content: Buffer): Buffer {
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8"
    );
    const footer = Buffer.from("\r\n", "utf8");
    return Buffer.concat([header, content, footer]);
  }

  private async postJson(botToken: string, endpoint: string, payload: Record<string, unknown>): Promise<void> {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    await this.postBuffer(botToken, endpoint, body, {
      "Content-Type": "application/json"
    });
  }

  private async postBuffer(
    botToken: string,
    endpoint: string,
    body: Buffer,
    headers: Record<string, string>
  ): Promise<void> {
    const pathWithToken = `/bot${botToken}${endpoint}`;

    await new Promise<void>((resolve, reject) => {
      const request = https.request(
        {
          host: "api.telegram.org",
          path: pathWithToken,
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": String(body.length)
          }
        },
        (response) => {
          let responseBody = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            responseBody += chunk;
          });
          response.on("end", () => {
            try {
              const parsed = JSON.parse(responseBody) as TelegramApiResponseBody;
              const retryAfterSeconds = parsed.parameters?.retry_after;
              const statusCode = response.statusCode;

              if ((statusCode ?? 500) < 200 || (statusCode ?? 500) >= 300) {
                reject(
                  new TelegramApiError(
                    `Telegram API ${endpoint} failed with status=${statusCode}: ${parsed.description ?? "unknown error"}`,
                    endpoint,
                    statusCode,
                    retryAfterSeconds
                  )
                );
                return;
              }

              if (parsed.ok !== true) {
                reject(
                  new TelegramApiError(
                    `Telegram API ${endpoint} returned ok=false: ${parsed.description ?? "unknown"}`,
                    endpoint,
                    statusCode,
                    retryAfterSeconds
                  )
                );
                return;
              }
              resolve();
            } catch (error) {
              const statusCode = response.statusCode;
              if ((statusCode ?? 500) >= 500) {
                reject(
                  new TelegramApiError(
                    `Telegram API ${endpoint} returned non-JSON body (status=${statusCode})`,
                    endpoint,
                    statusCode,
                    undefined
                  )
                );
                return;
              }
              reject(
                new Error(
                  `Telegram API ${endpoint} returned non-JSON body: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                )
              );
            }
          });
        }
      );

      request.on("error", reject);
      request.write(body);
      request.end();
    });
  }

  private resolveBotToken(botId: string | undefined): string {
    if (botId) {
      const token = this.botTokenById.get(botId);
      if (token) {
        return token;
      }
      this.log.warn({ bot_id: botId }, "Unknown reply_channel.bot_id, falling back to default bot");
    }
    return this.defaultBotToken;
  }

  private toMessageId(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
      return undefined;
    }
    return number;
  }
}
