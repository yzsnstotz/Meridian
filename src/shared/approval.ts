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
      return ["y"];
    case "allow":
      return ["Tab"];
    case "all":
      return ["BTab"];
    case "skip":
      return ["n"];
  }
}

export function isApprovalPrompt(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("waiting for approval") &&
    (normalized.includes("run this command?") || normalized.includes("allowlist"))
  );
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
