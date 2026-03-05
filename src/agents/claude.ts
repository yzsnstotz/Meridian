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

export function buildClaudeCliArgs(allowedTools: readonly string[] = claudeAgentConfig.allowedTools): string[] {
  return [claudeAgentConfig.command, "--allowedTools", allowedTools.join(" ")];
}

export function buildClaudeSpawnArgs(mode: BridgeMode, tmuxSession: string | null): string[] {
  const args = ["server", `--type=${claudeAgentConfig.type}`];
  if (mode === "pane_bridge" && tmuxSession) {
    args.push(`--tmux-session=${tmuxSession}`);
  }
  args.push("--", ...buildClaudeCliArgs());
  return args;
}
