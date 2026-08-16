import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentType, AttachmentResult, FileAttachment } from "../types";

const STAGING_PREFIX = "meridian-attachment-stage-";
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".log",
  ".csv",
  ".xml",
  ".yaml",
  ".yml"
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/xml",
  "text/yaml"
]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface TextAttachment {
  kind: "text";
  filename: string;
  content: string;
  path?: string;
  mime_type?: string;
  result: AttachmentResult;
}

export interface ImageAttachment {
  kind: "image";
  filename: string;
  path: string;
  mime_type?: string;
  result: AttachmentResult;
}

export type TransformedAttachment = TextAttachment | ImageAttachment;

export interface RejectedAttachment {
  attachment: FileAttachment;
  filename: string;
  reason: string;
  result: AttachmentResult;
}

export interface TransformAttachmentsResult {
  transformed: TransformedAttachment[];
  rejected: RejectedAttachment[];
  cleanupPaths: string[];
}

export interface StageAttachmentsResult {
  attachments: FileAttachment[];
  cleanupPaths: string[];
}

export async function stageInlineAttachments(attachments: FileAttachment[]): Promise<StageAttachmentsResult> {
  const stagedAttachments: FileAttachment[] = [];
  const cleanupPaths: string[] = [];

  for (const attachment of attachments) {
    const normalizedPath = normalizePath(attachment.path);
    if (normalizedPath) {
      stagedAttachments.push({
        ...attachment,
        path: normalizedPath
      });
      continue;
    }

    const inlineText = typeof attachment.content_text === "string" ? attachment.content_text : null;
    const inlineBase64 = attachment.content_base64?.trim() || null;
    if (inlineText === null && inlineBase64 === null) {
      stagedAttachments.push(attachment);
      continue;
    }

    const stagingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), STAGING_PREFIX));
    const stagedPath = path.join(stagingDir, buildStagedFilename(attachment, inlineText !== null ? "text" : "binary"));
    if (inlineText !== null) {
      await fs.promises.writeFile(stagedPath, inlineText, "utf8");
    } else {
      await fs.promises.writeFile(stagedPath, Buffer.from(inlineBase64 ?? "", "base64"));
    }
    cleanupPaths.push(stagingDir);
    stagedAttachments.push({
      path: stagedPath,
      filename: attachment.filename,
      mime_type: attachment.mime_type
    });
  }

  return {
    attachments: stagedAttachments,
    cleanupPaths
  };
}

export async function cleanupStagedAttachments(pathsToDelete: string[]): Promise<void> {
  const uniquePaths = [...new Set(pathsToDelete.filter((value) => value.trim().length > 0))];
  await Promise.all(uniquePaths.map(async (entry) => {
    try {
      await fs.promises.rm(entry, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
  }));
}

export async function transformAttachments(
  attachments: FileAttachment[],
  agentType: AgentType
): Promise<TransformAttachmentsResult> {
  const { attachments: stagedAttachments, cleanupPaths } = await stageInlineAttachments(attachments);
  const transformed: TransformedAttachment[] = [];
  const rejected: RejectedAttachment[] = [];

  for (const attachment of stagedAttachments) {
    const filename = resolveAttachmentFilename(attachment);
    const kind = detectAttachmentKind(attachment);

    if (kind === "image") {
      const normalizedPath = normalizePath(attachment.path);
      if (!normalizedPath) {
        rejected.push(buildRejectedAttachment(attachment, filename, "missing_content"));
        continue;
      }
      if (agentType !== "claude") {
        rejected.push(buildRejectedAttachment(attachment, filename, "unsupported_capability"));
        continue;
      }
      transformed.push({
        kind: "image",
        filename,
        path: normalizedPath,
        mime_type: attachment.mime_type,
        result: {
          filename,
          status: "accepted"
        }
      });
      continue;
    }

    if (kind === "text") {
      try {
        transformed.push({
          kind: "text",
          filename,
          content: await readTextAttachmentContent(attachment),
          path: normalizePath(attachment.path) ?? undefined,
          mime_type: attachment.mime_type,
          result: {
            filename,
            status: "extracted"
          }
        });
      } catch {
        rejected.push(buildRejectedAttachment(attachment, filename, "read_failed"));
      }
      continue;
    }

    rejected.push(buildRejectedAttachment(attachment, filename, "unsupported_type"));
  }

  return {
    transformed,
    rejected,
    cleanupPaths
  };
}

function normalizePath(rawPath: string | undefined): string | null {
  const normalized = rawPath?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function resolveAttachmentFilename(attachment: FileAttachment): string {
  const filename = attachment.filename?.trim();
  if (filename) {
    return filename;
  }

  const normalizedPath = normalizePath(attachment.path);
  if (normalizedPath) {
    return path.basename(normalizedPath);
  }

  return "attachment";
}

function buildStagedFilename(attachment: FileAttachment, fallbackKind: "text" | "binary"): string {
  const resolvedName = sanitizeFilename(resolveAttachmentFilename(attachment));
  const existingExt = path.extname(resolvedName).toLowerCase();
  if (existingExt) {
    return resolvedName;
  }

  if (attachment.mime_type) {
    const ext = extensionForMimeType(attachment.mime_type);
    if (ext) {
      return `${resolvedName}${ext}`;
    }
  }

  return fallbackKind === "text" ? `${resolvedName}.txt` : `${resolvedName}.bin`;
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  const base = trimmed.length > 0 ? path.basename(trimmed) : "attachment";
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "attachment";
}

function extensionForMimeType(mimeType: string): string | null {
  switch (mimeType.trim().toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/json":
    case "application/ld+json":
      return ".json";
    case "application/xml":
    case "text/xml":
      return ".xml";
    case "application/yaml":
    case "application/x-yaml":
    case "text/yaml":
      return ".yaml";
    case "text/markdown":
      return ".md";
    case "text/csv":
      return ".csv";
    case "text/plain":
      return ".txt";
    default:
      return null;
  }
}

function detectAttachmentKind(attachment: FileAttachment): "text" | "image" | "unknown" {
  if (typeof attachment.content_text === "string") {
    return "text";
  }

  const normalizedMime = attachment.mime_type?.trim().toLowerCase() ?? "";
  if (normalizedMime.startsWith("text/") || TEXT_MIME_TYPES.has(normalizedMime)) {
    return "text";
  }
  if (IMAGE_MIME_TYPES.has(normalizedMime)) {
    return "image";
  }

  const candidateName = attachment.filename?.trim() || normalizePath(attachment.path) || "";
  const ext = path.extname(candidateName).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }

  return "unknown";
}

async function readTextAttachmentContent(attachment: FileAttachment): Promise<string> {
  if (typeof attachment.content_text === "string") {
    return attachment.content_text;
  }

  if (attachment.content_base64?.trim()) {
    return Buffer.from(attachment.content_base64, "base64").toString("utf8");
  }

  const normalizedPath = normalizePath(attachment.path);
  if (!normalizedPath) {
    throw new Error("attachment has no readable path");
  }

  return await fs.promises.readFile(normalizedPath, "utf8");
}

function buildRejectedAttachment(attachment: FileAttachment, filename: string, reason: string): RejectedAttachment {
  return {
    attachment,
    filename,
    reason,
    result: {
      filename,
      status: "rejected",
      reason
    }
  };
}
