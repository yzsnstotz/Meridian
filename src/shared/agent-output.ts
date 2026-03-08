export type AgentOutputKind = "message" | "action_required" | "transient";

export interface ClassifiedAgentOutput {
  kind: AgentOutputKind;
  text: string;
}

const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const SUMMARY_MARKER_BEGIN = "[[MERIDIAN_SUMMARY_BEGIN";
const SUMMARY_MARKER_END = "[[MERIDIAN_SUMMARY_END";

const TRANSIENT_SUBSTRING_HINTS = [
  "shift+tab to accept edits",
  "gemini cli is restarting to apply the trust changes",
  "skip the next speaker check for faster responses",
  "see full, untruncated responses",
  "let node.js auto-configure memory",
  "list your saved chat checkpoints with /chat list",
  "assessing the git situation",
  "analyzing push parameters",
  "(esc to cancel",
  "hide individual footer elements",
  "show or hide the bottom status bar",
  "toggle the coding sandbox",
  "meridian protocol requirement",
  "output exactly one summary block",
  "do not output any content outside the summary block",
  "both tags must be single-line",
  "do not wrap tags in code fences"
];

const TRANSIENT_LINE_PATTERNS = [
  /^\[(?:success|error|partial)\]\s*thread=/,
  /^\[thread=[^\]]*\]$/,
  /^thread=[^\s]+\s+trace=[0-9a-f-]+/,
  /^trace=[0-9a-f-]+$/,
  /^(?:gemini|claude|codex|cursor)\.md$/,
  /^(?:tip|shortcut):\s/,
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

  const optionsByNumber = new Map<number, string>();
  for (const line of lines) {
    const matched = line.match(/^[●○]?\s*(\d+)\.\s*(.+)$/);
    if (!matched) {
      continue;
    }
    const optionNumber = Number(matched[1]);
    if (!Number.isFinite(optionNumber)) {
      continue;
    }
    if (!optionsByNumber.has(optionNumber)) {
      optionsByNumber.set(optionNumber, `${optionNumber}. ${matched[2].trim()}`);
    }
  }

  if (optionsByNumber.has(1) && optionsByNumber.has(2) && !optionsByNumber.has(3)) {
    optionsByNumber.set(3, "3. Allow for all commands");
  }

  const options = [...optionsByNumber.keys()]
    .sort((left, right) => left - right)
    .map((key) => optionsByNumber.get(key)!)
    .filter(Boolean);

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

  // Protocol tags without a complete closed block should never be treated as final content.
  if (looksLikeIncompleteSummaryProtocol(normalized)) {
    return true;
  }
  if (looksLikeProtocolOnlyContent(normalized)) {
    return true;
  }

  for (const hint of TRANSIENT_SUBSTRING_HINTS) {
    if (normalized.includes(hint)) {
      return true;
    }
  }

  for (const pattern of TRANSIENT_LINE_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  if (/[\u2800-\u28ff]/.test(content)) {
    return true;
  }

  return false;
}

function stripSummaryProtocolTags(content: string): string {
  return content
    .replace(/\[\[MERIDIAN_SUMMARY_BEGIN[^\]]*\]\]/gi, " ")
    .replace(/\[\[MERIDIAN_SUMMARY_END[^\]]*\]\]/gi, " ");
}

function looksLikeIncompleteSummaryProtocol(normalizedLowercaseContent: string): boolean {
  const beginMatches = normalizedLowercaseContent.match(/\[\[meridian_summary_begin[^\]]*\]\]/g) ?? [];
  const endMatches = normalizedLowercaseContent.match(/\[\[meridian_summary_end[^\]]*\]\]/g) ?? [];
  if (beginMatches.length === 0 && endMatches.length === 0) {
    return false;
  }
  return beginMatches.length !== endMatches.length;
}

function looksLikeProtocolOnlyContent(normalizedLowercaseContent: string): boolean {
  const hasSummaryProtocolTags =
    normalizedLowercaseContent.includes(SUMMARY_MARKER_BEGIN.toLowerCase()) ||
    normalizedLowercaseContent.includes(SUMMARY_MARKER_END.toLowerCase());
  if (!hasSummaryProtocolTags) {
    return false;
  }

  const stripped = stripSummaryProtocolTags(normalizedLowercaseContent)
    .replace(/id=[0-9a-f-]{36}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) {
    return true;
  }

  return stripped === "<summary>" || stripped === "summary" || stripped === "trace_id";
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
