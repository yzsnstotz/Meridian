import type { BridgeMode, ReasoningEffort } from "../types";

export const CLAUDE_AGENT_TYPE = "claude" as const;
const CLAUDE_CLI_COMMAND = "claude";
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = ["Bash", "Edit", "Replace"] as const;

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
  void autoApprove;
  // agentapi launches Claude in interactive mode, so omit --print-only streaming flags here.
  const args = [claudeAgentConfig.command, "--allowedTools", allowedTools.join(" ")];
  appendReasoningEffortFlag(args, reasoningEffort);
  if (modelId) {
    args.push("--model", modelId);
  }
  args.push("--dangerously-skip-permissions");
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
  void autoApprove;
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
  args.push("--dangerously-skip-permissions");
  return args;
}
