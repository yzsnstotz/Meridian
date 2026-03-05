import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

import { config } from "../config";
import { createLogger } from "../logger";
import { HubResultSchema, ReplyChannelSchema, type HubResult, type ReplyChannel } from "../types";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

export interface ResultSenderOptions {
  botToken?: string;
}

export class ResultSender {
  private readonly log = createLogger("hub");
  private readonly botToken: string;

  constructor(options: ResultSenderOptions = {}) {
    this.botToken = options.botToken ?? config.TELEGRAM_BOT_TOKEN;
  }

  async sendResult(rawResult: HubResult, rawReplyChannel: ReplyChannel): Promise<void> {
    const result = HubResultSchema.parse(rawResult);
    const replyChannel = ReplyChannelSchema.parse(rawReplyChannel);

    if (replyChannel.channel !== "telegram") {
      throw new Error(`Unsupported reply channel: ${replyChannel.channel}`);
    }

    const replyToMessageId = this.toMessageId(replyChannel.message_id);
    const headline = `[${result.status}] thread=${result.thread_id} trace=${result.trace_id}`;
    const textBody = result.content.trim().length === 0 ? headline : `${headline}\n\n${result.content}`;

    if (textBody.length > TELEGRAM_TEXT_LIMIT) {
      await this.sendLongTextInChunks(replyChannel.chat_id, textBody, replyToMessageId);
    } else {
      await this.sendText(replyChannel.chat_id, textBody, replyToMessageId);
    }

    for (const attachment of result.attachments) {
      const filename = attachment.filename ?? path.basename(attachment.path);
      await this.sendDocument(replyChannel.chat_id, attachment.path, filename, undefined, replyToMessageId);
    }

    this.log.info(
      {
        trace_id: result.trace_id,
        thread_id: result.thread_id,
        status: result.status,
        target: replyChannel.chat_id
      },
      "HubResult delivered to Telegram"
    );
  }

  private async sendLongTextInChunks(
    chatId: string,
    content: string,
    replyToMessageId?: number
  ): Promise<void> {
    const chunks = this.splitTextForTelegram(content);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      await this.sendText(chatId, chunk, index === 0 ? replyToMessageId : undefined);
    }
  }

  private splitTextForTelegram(content: string): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > TELEGRAM_TEXT_LIMIT) {
      let splitIndex = remaining.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
      if (splitIndex < Math.floor(TELEGRAM_TEXT_LIMIT * 0.5)) {
        splitIndex = TELEGRAM_TEXT_LIMIT;
      }

      const chunk = remaining.slice(0, splitIndex).trimEnd();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      remaining = remaining.slice(splitIndex).trimStart();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private async sendText(chatId: string, text: string, replyToMessageId?: number): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text
    };
    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }

    await this.postJson("/sendMessage", payload);
  }

  private async sendDocument(
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

    await this.postBuffer(`/sendDocument`, body, {
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

  private async postJson(endpoint: string, payload: Record<string, unknown>): Promise<void> {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    await this.postBuffer(endpoint, body, {
      "Content-Type": "application/json"
    });
  }

  private async postBuffer(
    endpoint: string,
    body: Buffer,
    headers: Record<string, string>
  ): Promise<void> {
    const pathWithToken = `/bot${this.botToken}${endpoint}`;

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
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              reject(
                new Error(
                  `Telegram API ${endpoint} failed with status=${response.statusCode}: ${responseBody}`
                )
              );
              return;
            }

            try {
              const parsed = JSON.parse(responseBody) as { ok?: boolean; description?: string };
              if (parsed.ok !== true) {
                reject(new Error(`Telegram API ${endpoint} returned ok=false: ${parsed.description ?? "unknown"}`));
                return;
              }
              resolve();
            } catch (error) {
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
