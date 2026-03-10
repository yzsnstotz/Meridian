import { normalizeVisibleText } from "./terminal-text";

export const APPROVAL_HELP_TEXT =
  "Supported approval actions: run|allow|all|skip (aliases: y|tab|btab|n).";

export type ApprovalAction = "run" | "allow" | "all" | "skip";

function normalizeApprovalToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
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

export function isApprovalPrompt(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("waiting for approval") &&
    (normalized.includes("run this command?") || normalized.includes("allowlist"))
  );
}

/** Gemini-style: "Action Required" + "Allow execution of:" with numbered options. */
function parseGeminiApprovalText(content: string): string | null {
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
    if (!matched) continue;
    const optionNumber = Number(matched[1]);
    if (!Number.isFinite(optionNumber)) continue;
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
  if (command) summaryLines.push(command);
  summaryLines.push(lines[allowIndex] ?? "Allow execution?");
  summaryLines.push(...options);
  return summaryLines.join("\n");
}

/** Codex-style: "Would you like to run the following command?" with numbered options. */
function parseCodexApprovalText(content: string): string | null {
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
  const optionsByNumber = new Map<number, string>();
  const codexOptionRegex = /^[●○›•]?\s*(\d+)\.\s*(.+)$/;
  for (const line of lines) {
    const matched = line.match(codexOptionRegex);
    if (!matched) continue;
    const optionNumber = Number(matched[1]);
    if (!Number.isFinite(optionNumber)) continue;
    const label = matched[2]
      .trim()
      .replace(/\s*\(esc\)\s*$/, "")
      .replace(/\s*\([ypn]\)\s*$/i, "")
      .trim();
    if (!optionsByNumber.has(optionNumber)) {
      optionsByNumber.set(optionNumber, `${optionNumber}. ${label}`);
    }
  }
  const options = [...optionsByNumber.keys()]
    .sort((left, right) => left - right)
    .map((key) => optionsByNumber.get(key)!)
    .filter(Boolean);
  const summaryLines = ["Waiting for approval...", "Run this command?"];
  if (command) summaryLines.push(command);
  summaryLines.push("Run this command?");
  summaryLines.push(...options);
  return summaryLines.join("\n");
}

/**
 * Single entry: recognize raw provider output (Gemini or Codex) as an approval prompt
 * and return the canonical summary string, or null.
 */
export function parseApprovalSummaryFromRawContent(content: string): string | null {
  return parseGeminiApprovalText(content) ?? parseCodexApprovalText(content);
}

export function buildTelegramApprovalHint(threadId: string): string {
  return [
    "",
    "Telegram approval shortcuts:",
    `/approve run thread=${threadId}`,
    `/approve allow thread=${threadId}`,
    `/approve all thread=${threadId}`,
    `/approve skip thread=${threadId}`,
    "Or reply to this message with exactly: y, allow, all, or n.",
    "Requires pane_bridge mode."
  ].join("\n");
}
