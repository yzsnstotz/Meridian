export type AgentOutputKind = "message" | "action_required" | "transient";

export interface ClassifiedAgentOutput {
  kind: AgentOutputKind;
  text: string;
}

const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const TRANSIENT_HINTS = [
  "waiting for auth",
  "do you trust the files in this folder",
  "gemini cli is restarting to apply the trust changes",
  "skip the next speaker check for faster responses",
  "see full, untruncated responses",
  "let node.js auto-configure memory",
  "list your saved chat checkpoints with /chat list",
  "assessing the git situation",
  "analyzing push parameters",
  "(esc to cancel"
];

function stripAnsiAndControl(content: string): string {
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

function normalizeVisibleText(content: string): string {
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

function parseActionRequiredText(content: string): string | null {
  const normalized = normalizeVisibleText(content);
  const lower = normalized.toLowerCase();
  if (!lower.includes("action required") || !lower.includes("allow execution of:")) {
    return null;
  }

  const lines = normalized
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const allowIndex = lines.findIndex((line) => /^allow execution of:/i.test(line));
  if (allowIndex < 0) {
    return null;
  }

  let command = "";
  for (let index = allowIndex - 1; index >= 0; index -= 1) {
    const candidate = lines[index] ?? "";
    if (!candidate || /^action required$/i.test(candidate) || /^\?/.test(candidate)) {
      continue;
    }
    command = candidate;
    break;
  }

  const options = lines
    .slice(allowIndex + 1)
    .filter((line) => /^[●○]?\s*\d+\./.test(line))
    .map((line) => line.replace(/^[●○]\s*/, ""));

  const summaryLines = ["Waiting for approval...", "Run this command?"];
  if (command) {
    summaryLines.push(command);
  }
  summaryLines.push(lines[allowIndex] ?? "Allow execution?");
  summaryLines.push(...options);
  return summaryLines.join("\n");
}

function isTransientText(content: string): boolean {
  const normalized = normalizeVisibleText(content).toLowerCase();
  if (!normalized) {
    return true;
  }

  for (const hint of TRANSIENT_HINTS) {
    if (normalized.includes(hint)) {
      return true;
    }
  }

  if (/[\u2800-\u28ff]/.test(content) && normalized.includes("(esc to cancel")) {
    return true;
  }

  return false;
}

export function classifyAgentOutput(content: string): ClassifiedAgentOutput {
  const actionRequiredText = parseActionRequiredText(content);
  if (actionRequiredText) {
    return {
      kind: "action_required",
      text: actionRequiredText
    };
  }

  const normalized = normalizeVisibleText(content);
  if (isTransientText(content)) {
    return {
      kind: "transient",
      text: normalized
    };
  }

  return {
    kind: "message",
    text: normalized
  };
}
