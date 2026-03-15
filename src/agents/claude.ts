import type { BridgeMode } from "../types";

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

export function buildClaudeCliArgs(
  allowedTools: readonly string[] = claudeAgentConfig.allowedTools,
  modelId?: string,
  autoApprove?: boolean
): string[] {
  const args = [claudeAgentConfig.command, "--allowedTools", allowedTools.join(" ")];
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
  autoApprove?: boolean
): string[] {
  void mode;
  void tmuxSession;
  const args = ["server", `--type=${claudeAgentConfig.type}`, endpointFlag];
  args.push("--", ...buildClaudeCliArgs(claudeAgentConfig.allowedTools, modelId, autoApprove));
  return args;
}
