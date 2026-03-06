import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

import { config } from "../config";
import { createLogger } from "../logger";
import { HubResultSchema, ReplyChannelSchema, type HubResult, type ReplyChannel } from "../types";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_SAFE_TEXT_LIMIT = 3500;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_CHUNK_DELAY_MS = 250;
const TELEGRAM_MAX_SEND_ATTEMPTS = 5;
const TELEGRAM_RETRY_BACKOFF_BASE_MS = 500;
const TELEGRAM_RETRY_BACKOFF_MAX_MS = 8000;

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

export interface ResultSenderOptions {
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

export class ResultSender {
  private readonly log = createLogger("hub");
  private readonly defaultBotToken: string;
  private readonly botTokenById: Map<string, string>;

  constructor(options: ResultSenderOptions = {}) {
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

  async sendResult(rawResult: HubResult, rawReplyChannel: ReplyChannel): Promise<void> {
    const result = HubResultSchema.parse(rawResult);
    const replyChannel = ReplyChannelSchema.parse(rawReplyChannel);

    if (replyChannel.channel !== "telegram") {
      throw new Error(`Unsupported reply channel: ${replyChannel.channel}`);
    }

    const botToken = this.resolveBotToken(replyChannel.bot_id);
    const replyToMessageId = this.toMessageId(replyChannel.message_id);
    const headline = `[${result.status}] thread=${result.thread_id} trace=${result.trace_id}`;
    const textBody = result.content.trim().length === 0 ? headline : `${headline}\n\n${result.content}`;

    if (textBody.length > TELEGRAM_TEXT_LIMIT) {
      await this.sendLongTextInChunks(botToken, replyChannel.chat_id, textBody, replyToMessageId, {
        traceId: result.trace_id,
        threadId: result.thread_id
      });
    } else {
      await this.sendTextWithRetry(botToken, replyChannel.chat_id, textBody, replyToMessageId);
    }

    for (const attachment of result.attachments) {
      const filename = attachment.filename ?? path.basename(attachment.path);
      await this.sendDocumentWithRetry(
        botToken,
        replyChannel.chat_id,
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
        target: replyChannel.chat_id,
        bot_id: replyChannel.bot_id ?? extractBotIdFromToken(botToken)
      },
      "HubResult delivered to Telegram"
    );
  }

  private async sendLongTextInChunks(
    botToken: string,
    chatId: string,
    content: string,
    replyToMessageId?: number,
    context?: {
      traceId: string;
      threadId: string;
    }
  ): Promise<void> {
    const chunks = splitTextForTelegram(content);
    this.log.info(
      {
        trace_id: context?.traceId ?? null,
        thread_id: context?.threadId ?? null,
        chat_id: chatId,
        chunk_count: chunks.length,
        total_characters: content.length
      },
      "Sending long Telegram reply in chunks"
    );

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      await this.sendTextWithRetry(botToken, chatId, chunk, index === 0 ? replyToMessageId : undefined);
      if (index < chunks.length - 1) {
        await this.delay(TELEGRAM_CHUNK_DELAY_MS);
      }
    }
  }

  private async sendTextWithRetry(
    botToken: string,
    chatId: string,
    text: string,
    replyToMessageId?: number
  ): Promise<void> {
    await this.withTelegramRetry(
      () => this.sendText(botToken, chatId, text, replyToMessageId),
      "sendMessage"
    );
  }

  private async sendDocumentWithRetry(
    botToken: string,
    chatId: string,
    filePath: string,
    filename: string,
    caption?: string,
    replyToMessageId?: number
  ): Promise<void> {
    await this.withTelegramRetry(
      () => this.sendDocument(botToken, chatId, filePath, filename, caption, replyToMessageId),
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

  private async sendText(botToken: string, chatId: string, text: string, replyToMessageId?: number): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text
    };
    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }

    await this.postJson(botToken, "/sendMessage", payload);
  }

  private async sendDocument(
    botToken: string,
    chatId: string,
    filePath: string,
    filename: string,
    caption?: string,
    replyToMessageId?: number
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
