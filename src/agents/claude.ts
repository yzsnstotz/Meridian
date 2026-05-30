import type { BridgeMode, ReasoningEffort } from "../types";

export const CLAUDE_AGENT_TYPE = "claude" as const;
const CLAUDE_CLI_COMMAND = "claude";
// Claude Code's canonical tool names. The previous list `["Bash", "Edit",
// "Replace"]` was missing `Write` (creating new files) and `Read` (reading
// arbitrary files), and included the legacy `Replace` name that no current
// version of the Claude CLI exposes. Skills that compose investigate +
// taskspec + dispatch (e.g. `$bug-fix`) need to manufacture brand-new
// markdown files like `bug_reports_input.md` and `investigation_report.md`;
// without `Write` claude opus typically refuses to fall back to a Bash
// heredoc and exits cleanly with zero on-disk output.
//
// Grep / Glob are added because the same skills routinely search the repo
// to populate `investigation_context.md`. The previous omission forced
// skills to shell out via Bash, which is slower and less reliable.
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"] as const;

export interface ClaudeAgentConfig {
  type: typeof CLAUDE_AGENT_TYPE;
  command: typeof CLAUDE_CLI_COMMAND;
  allowedTools: readonly string[];
}

export const claudeAgentConfig: ClaudeAgentConfig = {
  type: CLAUDE_AGENT_TYPE,
  command: CLAUDE_CLI_COMMAND,
  allowedTools: DEFAULT_CLAUDE_ALLOWED_TOOLS
};

function appendReasoningEffortFlag(args: string[], reasoningEffort?: ReasoningEffort): void {
  if (!reasoningEffort) {
    return;
  }
  args.push("--effort", reasoningEffort);
}

export function buildClaudeCliArgs(
  allowedTools: readonly string[] = claudeAgentConfig.allowedTools,
  modelId?: string,
  autoApprove?: boolean,
  reasoningEffort?: ReasoningEffort
): string[] {
  // agentapi launches Claude in interactive mode, so omit --print-only streaming flags here.
  const args = [claudeAgentConfig.command, "--allowedTools", allowedTools.join(" ")];
  appendReasoningEffortFlag(args, reasoningEffort);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (autoApprove === true) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

export function buildClaudeSpawnArgs(
  mode: BridgeMode,
  tmuxSession: string | null,
  endpointFlag: string,
  modelId?: string,
  autoApprove?: boolean,
  reasoningEffort?: ReasoningEffort
): string[] {
  void mode;
  void tmuxSession;
  const args = ["server", `--type=${claudeAgentConfig.type}`, endpointFlag];
  args.push("--", ...buildClaudeCliArgs(claudeAgentConfig.allowedTools, modelId, autoApprove, reasoningEffort));
  return args;
}

export function buildClaudeStreamArgs(
  modelId?: string,
  autoApprove?: boolean,
  reasoningEffort?: ReasoningEffort
): string[] {
  const args = [
    claudeAgentConfig.command,
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--allowedTools",
    claudeAgentConfig.allowedTools.join(" ")
  ];
  appendReasoningEffortFlag(args, reasoningEffort);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (autoApprove === true) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}
