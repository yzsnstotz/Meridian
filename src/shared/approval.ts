import { normalizeVisibleText } from "./terminal-text";

export const APPROVAL_HELP_TEXT =
  "Supported approval inputs: run|allow|all|skip (aliases: y|tab|btab|n) or a numeric option like 4.";

export type ApprovalAction = "run" | "allow" | "all" | "skip";

export interface ApprovalOption {
  key: string;
  label: string;
  action: ApprovalAction | null;
}

interface ParsedApprovalPrompt {
  summary: string;
  options: ApprovalOption[];
}

function normalizeApprovalToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeApprovalOptionLabel(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\(esc\)\s*$/i, "")
    .replace(/\s*\([ypn]\)\s*$/i, "")
    .trim();
}

function stripPromptLeader(raw: string): string {
  return raw.replace(/^\?\s*/, "").trim();
}

function isApprovalOptionLine(raw: string): boolean {
  return /^[●○›•]?\s*\d+\.\s+/.test(raw.trim());
}

function isDiffPreviewLine(raw: string): boolean {
  return /^\d+\s+[+\-]?\S/.test(raw.trim());
}

export function normalizeApprovalAction(raw: string): ApprovalAction | null {
  const normalized = normalizeApprovalToken(raw);
  if (!normalized) {
    return null;
  }

  if (["run", "runonce", "once", "y", "yes"].includes(normalized)) {
    return "run";
  }
  if (["allow", "allowlist", "tab"].includes(normalized)) {
    return "allow";
  }
  if (["all", "runall", "runeverything", "everything", "shifttab", "btab"].includes(normalized)) {
    return "all";
  }
  if (["skip", "n", "no", "esc", "escape"].includes(normalized)) {
    return "skip";
  }

  return null;
}

export function normalizeApprovalSelection(raw: string): string | null {
  const action = normalizeApprovalAction(raw);
  if (action) {
    return action;
  }

  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function approvalActionToTmuxKeys(action: ApprovalAction): string[] {
  switch (action) {
    case "run":
      return ["1", "Enter"];
    case "allow":
      return ["2", "Enter"];
    case "all":
      return ["BTab"];
    case "skip":
      return ["3", "Enter"];
  }
}

function mapApprovalOptionLabelToAction(raw: string): ApprovalAction | null {
  const normalized = normalizeApprovalToken(raw);
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes("allowonce") ||
    normalized.includes("runonce") ||
    normalized.includes("approveonce") ||
    normalized.includes("yesproceed") ||
    normalized === "yes"
  ) {
    return "run";
  }

  if (
    normalized.includes("allowforthissession") ||
    normalized.includes("forthissession") ||
    normalized.includes("allowlist") ||
    normalized.includes("dontaskagain")
  ) {
    return "allow";
  }

  if (
    normalized.includes("allowforall") ||
    normalized.includes("allowall") ||
    normalized.includes("alwaysallow") ||
    normalized.includes("allcommands")
  ) {
    return "all";
  }

  if (
    normalized === "no" ||
    normalized.includes("suggestchanges") ||
    normalized.includes("reject") ||
    normalized.includes("deny") ||
    normalized.includes("dontallow") ||
    normalized.includes("tellcodexwhattododifferently") ||
    normalized.includes("tellmewhattododifferently")
  ) {
    return "skip";
  }

  return null;
}

function parseApprovalOptions(normalizedContent: string): ApprovalOption[] {
  const lines = normalizedContent
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const options: ApprovalOption[] = [];
  const seenKeys = new Set<string>();

  for (const line of lines) {
    const matched = line.match(/^[●○›•]?\s*(\d+)\.\s*(.+)$/);
    if (!matched) {
      continue;
    }

    const key = matched[1]?.trim() ?? "";
    const labelBody = normalizeApprovalOptionLabel(matched[2] ?? "");
    if (!key || !labelBody || seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    options.push({
      key,
      label: `${key}. ${labelBody}`,
      action: mapApprovalOptionLabelToAction(labelBody)
    });
  }

  return options;
}

function buildApprovalSummary(
  header: string,
  context: string | null,
  promptLine: string,
  options: ApprovalOption[]
): string {
  const lines = ["Waiting for approval...", header];
  const normalizedContext = context?.trim() ?? "";
  const normalizedPromptLine = promptLine.trim();

  if (normalizedContext && normalizedContext !== header && normalizedContext !== normalizedPromptLine) {
    lines.push(normalizedContext);
  }
  if (normalizedPromptLine && normalizedPromptLine !== header) {
    lines.push(normalizedPromptLine);
  }
  for (const option of options) {
    lines.push(option.label);
  }
  return lines.join("\n");
}

function findNearestContextLine(lines: string[], fromIndex: number): string | null {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const candidate = stripPromptLeader(lines[index] ?? "");
    const lower = candidate.toLowerCase();
    if (!candidate) {
      continue;
    }
    if (lower === "action required" || isApprovalOptionLine(candidate) || isDiffPreviewLine(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
}

function findNearestEditContextLine(lines: string[], fromIndex: number): string | null {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const candidate = stripPromptLeader(lines[index] ?? "");
    if (!candidate) {
      continue;
    }
    if (/^(edit|write|update|create|delete|rename|move)\b/i.test(candidate)) {
      return candidate;
    }
  }
  return findNearestContextLine(lines, fromIndex);
}

function parseGeminiApprovalText(content: string): ParsedApprovalPrompt | null {
  const normalized = normalizeVisibleText(content);
  const lower = normalized.toLowerCase();
  if (!lower.includes("action required")) {
    return null;
  }

  const options = parseApprovalOptions(normalized);
  if (options.length === 0) {
    return null;
  }

  const lines = normalized
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const allowIndex = lines.findIndex((line) => /^allow execution of:/i.test(line));
  if (allowIndex >= 0) {
    const promptLine = lines[allowIndex] ?? "Allow execution?";
    const context = findNearestContextLine(lines, allowIndex);
    return {
      summary: buildApprovalSummary("Run this command?", context, promptLine, options),
      options
    };
  }

  const applyIndex = lines.findIndex((line) => /^apply this change\?$/i.test(line));
  if (applyIndex >= 0) {
    const promptLine = lines[applyIndex] ?? "Apply this change?";
    const context = findNearestEditContextLine(lines, applyIndex);
    return {
      summary: buildApprovalSummary("Apply this change?", context, promptLine, options),
      options
    };
  }

  const genericQuestionIndex = lines.findIndex((line) => {
    const candidate = stripPromptLeader(line);
    return (
      candidate.endsWith("?") &&
      candidate.toLowerCase() !== "action required" &&
      !isApprovalOptionLine(candidate)
    );
  });
  if (genericQuestionIndex >= 0) {
    const promptLine = stripPromptLeader(lines[genericQuestionIndex] ?? "");
    const context = findNearestContextLine(lines, genericQuestionIndex);
    return {
      summary: buildApprovalSummary(promptLine || "Approval required", context, promptLine, options),
      options
    };
  }

  return null;
}

function parseCodexApprovalText(content: string): ParsedApprovalPrompt | null {
  const normalized = normalizeVisibleText(content);
  const lower = normalized.toLowerCase();
  const hasCodexQuestion = /would you like to run the following command\?/.test(lower);
  const hasCodexOptions =
    /yes,\s*proceed/i.test(lower) ||
    /yes,\s*and don't ask again/i.test(lower) ||
    /no,\s*and tell\s+(codex|me)/i.test(lower);
  if (!hasCodexQuestion || !hasCodexOptions) {
    return null;
  }

  const lines = normalized
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let command = "";
  for (const line of lines) {
    const cmdMatch = line.match(/^\$\s*(.+)$/);
    if (cmdMatch) {
      command = cmdMatch[1]?.trim() ?? "";
      break;
    }
  }

  const options = parseApprovalOptions(normalized);
  if (options.length === 0) {
    return null;
  }

  return {
    summary: buildApprovalSummary("Run this command?", command || null, "Run this command?", options),
    options
  };
}

function parseApprovalPromptFromRawContent(content: string): ParsedApprovalPrompt | null {
  return parseGeminiApprovalText(content) ?? parseCodexApprovalText(content);
}

export function isApprovalPrompt(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    (
      normalized.includes("waiting for approval") &&
      (
        normalized.includes("run this command?") ||
        normalized.includes("allowlist") ||
        normalized.includes("apply this change?")
      )
    ) ||
    parseApprovalPromptFromRawContent(content) !== null
  );
}

/**
 * Single entry: recognize raw provider output (Gemini or Codex) as an approval prompt
 * and return the canonical summary string, or null.
 */
export function parseApprovalSummaryFromRawContent(content: string): string | null {
  return parseApprovalPromptFromRawContent(content)?.summary ?? null;
}

export function selectApprovalOptionInput(content: string, requestedAction: ApprovalAction): string | null {
  const prompt = parseApprovalPromptFromRawContent(content);
  if (!prompt) {
    return null;
  }

  const findFirst = (...preferred: ApprovalAction[]): string | null => {
    for (const action of preferred) {
      const matched = prompt.options.find((option) => option.action === action);
      if (matched) {
        return matched.key;
      }
    }
    return null;
  };

  switch (requestedAction) {
    case "run":
      return findFirst("run");
    case "allow":
      return findFirst("allow", "all", "run");
    case "all":
      return findFirst("all", "allow", "run");
    case "skip":
      return findFirst("skip");
  }
}

export function buildTelegramApprovalHint(threadId: string): string {
  return [
    "",
    "Telegram approval shortcuts:",
    `/approve run thread=${threadId}`,
    `/approve allow thread=${threadId}`,
    `/approve all thread=${threadId}`,
    `/approve skip thread=${threadId}`,
    `Or reply with an exact option number like: /approve 4 thread=${threadId}`,
    "Or reply to this message with exactly: y, allow, all, or n.",
    "Requires pane_bridge mode."
  ].join("\n");
}
