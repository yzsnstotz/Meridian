import fs from "node:fs";
import path from "node:path";

import { stripAnsiAndControl } from "../shared/terminal-text";

/** Size of log tail to read for dedup check (bytes). */
const TAIL_READ_SIZE = 65536;
/** Number of trailing lines of content to check for duplicate presence in tail. */
const DEDUP_LAST_LINES = 5;

function normalizeContent(s: string): string {
  return s.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Append run result (HubResult.content) to pane-{threadId}.log with timestamp.
 * Dedup: if the log tail already contains this content (or its last N lines), skip append.
 * Used only when instance mode is pane_bridge so pane log remains the single persistent source.
 *
 * @returns true if appended, false if skipped (empty content, dedup, or error)
 */
export async function appendRunResultToPaneLog(
  threadId: string,
  content: string,
  logDir: string
): Promise<boolean> {
  return appendContentToPaneLog(threadId, content, logDir);
}

/**
 * Append user run instruction to pane-{threadId}.log with timestamp.
 * Same dedup as run result; used so pane log has user input even when capture missed it.
 *
 * @returns true if appended, false if skipped (empty content, dedup, or error)
 */
export async function appendUserRunToPaneLog(
  threadId: string,
  content: string,
  logDir: string
): Promise<boolean> {
  return appendContentToPaneLog(threadId, content, logDir);
}

function appendContentToPaneLog(
  threadId: string,
  content: string,
  logDir: string
): Promise<boolean> {
  const trimmed = content?.trim();
  if (!trimmed) {
    return Promise.resolve(false);
  }
  const normalized = normalizeContent(trimmed);
  const logPath = path.join(logDir, `pane-${threadId}.log`);
  const timestamp = new Date().toISOString();
  const block = `\n--- ${timestamp} ---\n${trimmed}\n`;

  try {
    const exists = fs.existsSync(logPath);
    if (!exists) {
      fs.appendFileSync(logPath, block, "utf8");
      return Promise.resolve(true);
    }

    const tail = fs
      .readFileSync(logPath, { encoding: "utf8" })
      .slice(-TAIL_READ_SIZE);
    const tailNormalized = stripAnsiAndControl(tail).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (tailNormalized.includes(normalized)) {
      return Promise.resolve(false);
    }
    const contentLines = normalized.split("\n").filter(Boolean);
    const lastN = contentLines.slice(-DEDUP_LAST_LINES).join("\n");
    if (lastN && tailNormalized.includes(lastN)) {
      return Promise.resolve(false);
    }

    fs.appendFileSync(logPath, block, "utf8");
    return Promise.resolve(true);
  } catch (err) {
    return Promise.resolve(false);
  }
}
