import { parseApprovalSummaryFromRawContent } from "./approval";
import { normalizeVisibleText } from "./terminal-text";

export type AgentOutputKind = "message" | "action_required" | "transient";

export interface ClassifiedAgentOutput {
  kind: AgentOutputKind;
  text: string;
}

const SUMMARY_MARKER_BEGIN = "[[MERIDIAN_SUMMARY_BEGIN";
const SUMMARY_MARKER_END = "[[MERIDIAN_SUMMARY_END";

const TRANSIENT_SUBSTRING_HINTS = [
  "shift+tab to accept edits",
  "gemini cli v",
  "gemini cli is restarting to apply the trust changes",
  "signed in with google:",
  "we're making changes to gemini cli",
  "goo.gle/geminicli-updates",
  "skip the next speaker check for faster responses",
  "press ctrl+o to expand pasted text",
  "see full, untruncated responses",
  "let node.js auto-configure memory",
  "list your saved chat checkpoints with /chat list",
  "assessing the git situation",
  "analyzing push parameters",
  "(esc to cancel",
  "? for shortcuts",
  "hide individual footer elements",
  "show or hide the bottom status bar",
  "toggle the coding sandbox",
  "type your message or @path/to/file",
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
  const summary = parseApprovalSummaryFromRawContent(content);
  if (summary) {
    return {
      kind: "action_required",
      text: summary
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
