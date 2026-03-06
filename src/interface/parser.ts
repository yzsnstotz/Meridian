import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import type { Context } from "grammy";
import type { FileAttachment, InboundUIEvent } from "../types";

const ATTACHMENT_DIR = "/tmp/hub-attachments";
const FILENAME_SAFE_REGEX = /[^a-zA-Z0-9._-]/g;

export interface ParsedInboundEvent {
  chatId: string;
  botId: string;
  event: InboundUIEvent;
}

type TelegramMessage = NonNullable<Context["message"]>;

function sanitizeFilename(name: string): string {
  return name.replace(FILENAME_SAFE_REGEX, "_");
}

function getMessageContent(message: TelegramMessage): string {
  const candidate = (message as { text?: unknown; caption?: unknown }).text;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }

  const caption = (message as { caption?: unknown }).caption;
  if (typeof caption === "string") {
    return caption.trim();
  }

  return "";
}

async function ensureAttachmentDir(): Promise<void> {
  await fs.promises.mkdir(ATTACHMENT_DIR, { recursive: true });
}

function downloadFile(url: string, destinationPath: string, redirectCount = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;

      if ([301, 302, 307, 308].includes(statusCode) && location && redirectCount < 5) {
        response.resume();
        void downloadFile(location, destinationPath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Telegram file download failed with status ${statusCode}`));
        return;
      }

      const output = fs.createWriteStream(destinationPath);
      response.pipe(output);

      output.on("finish", () => {
        output.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          resolve();
        });
      });

      output.on("error", (error) => {
        output.close(() => {
          void fs.promises.unlink(destinationPath).catch(() => undefined);
          reject(error);
        });
      });
    });

    request.on("error", reject);
  });
}

async function downloadTelegramAttachment(
  ctx: Context,
  botToken: string,
  fileId: string,
  displayFilename: string,
  mimeType?: string
): Promise<FileAttachment> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram file has no path for file_id=${fileId}`);
  }

  await ensureAttachmentDir();
  const safeDisplayFilename = sanitizeFilename(displayFilename);
  const persistedFilename = `${Date.now()}-${safeDisplayFilename}`;
  const destinationPath = path.join(ATTACHMENT_DIR, persistedFilename);
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  await downloadFile(url, destinationPath);

  return {
    path: destinationPath,
    filename: safeDisplayFilename,
    mime_type: mimeType
  };
}

async function parsePhotoAttachment(ctx: Context, message: TelegramMessage, botToken: string): Promise<FileAttachment[]> {
  const photos = (message as { photo?: Array<{ file_id: string }> }).photo ?? [];
  if (!Array.isArray(photos) || photos.length === 0) {
    return [];
  }

  const largestPhoto = photos[photos.length - 1];
  const displayFilename = `photo-${largestPhoto.file_id}.jpg`;
  return [await downloadTelegramAttachment(ctx, botToken, largestPhoto.file_id, displayFilename, "image/jpeg")];
}

async function parseDocumentAttachment(
  ctx: Context,
  message: TelegramMessage,
  botToken: string
): Promise<FileAttachment[]> {
  const document = (message as { document?: { file_id: string; file_name?: string; mime_type?: string } }).document;
  if (!document) {
    return [];
  }

  const originalFilename = document.file_name && document.file_name.trim().length > 0 ? document.file_name : `file-${document.file_id}`;
  return [await downloadTelegramAttachment(ctx, botToken, document.file_id, originalFilename, document.mime_type)];
}

async function parseAttachments(ctx: Context, message: TelegramMessage, botToken: string): Promise<FileAttachment[]> {
  const attachments: FileAttachment[] = [];
  attachments.push(...(await parsePhotoAttachment(ctx, message, botToken)));
  attachments.push(...(await parseDocumentAttachment(ctx, message, botToken)));
  return attachments;
}

function resolveReplyTo(message: TelegramMessage): string | null {
  const replyMessageId = (message as { reply_to_message?: { message_id?: number } }).reply_to_message?.message_id;
  return typeof replyMessageId === "number" ? String(replyMessageId) : null;
}

export async function parseTelegramMessage(ctx: Context): Promise<ParsedInboundEvent | null> {
  const message = ctx.message;
  if (!message) {
    return null;
  }

  const senderId = message.from?.id;
  if (!senderId) {
    throw new Error("Telegram message missing sender id");
  }

  const botToken = ctx.api.token;
  const botId = String(ctx.me.id);

  const unixSeconds = typeof message.date === "number" ? message.date : Math.floor(Date.now() / 1000);
  const attachments = await parseAttachments(ctx, message, botToken);
  const event: InboundUIEvent = {
    channel: "telegram",
    raw_message_id: String(message.message_id),
    sender_id: senderId,
    content: getMessageContent(message),
    attachments,
    timestamp: new Date(unixSeconds * 1000).toISOString(),
    reply_to: resolveReplyTo(message)
  };

  return {
    chatId: String(message.chat.id),
    botId,
    event
  };
}
