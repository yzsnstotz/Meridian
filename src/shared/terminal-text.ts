/**
 * Shared helpers for normalizing terminal/agent output (strip ANSI, unwrap box frames).
 * Used by approval parsing and agent output classification.
 */

const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsiAndControl(content: string): string {
  return content.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "");
}

function isHorizontalBorder(line: string): boolean {
  return /^[\s╭╮╰╯─━═▀▄▁▔█]+$/.test(line);
}

function unwrapTerminalFrameLine(rawLine: string): string {
  const trimmed = rawLine.trimEnd();
  if (!trimmed) {
    return "";
  }
  if (isHorizontalBorder(trimmed)) {
    return "";
  }
  const boxed = trimmed.match(/^[│┃]\s?(.*?)\s?[│┃]$/);
  if (boxed) {
    return boxed[1]?.trimEnd() ?? "";
  }
  return trimmed;
}

export function normalizeVisibleText(content: string): string {
  const stripped = stripAnsiAndControl(content);
  const lines = stripped.split(/\n/).map(unwrapTerminalFrameLine);
  while (lines.length > 0 && !lines[0]?.trim()) {
    lines.shift();
  }
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) {
    lines.pop();
  }
  return lines.join("\n").trim();
}
