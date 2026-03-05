import type { BridgeMode } from "../types";

const CODEX_AGENT_TYPE = "codex";
const CODEX_CLI_COMMAND = "codex";

export interface CodexAgentConfig {
  type: typeof CODEX_AGENT_TYPE;
  command: typeof CODEX_CLI_COMMAND;
}

export const codexAgentConfig: CodexAgentConfig = {
  type: CODEX_AGENT_TYPE,
  command: CODEX_CLI_COMMAND
};

export function buildCodexSpawnArgs(mode: BridgeMode, tmuxSession: string | null): string[] {
  const args = ["server", `--type=${codexAgentConfig.type}`];
  if (mode === "pane_bridge" && tmuxSession) {
    args.push(`--tmux-session=${tmuxSession}`);
  }
  args.push("--", codexAgentConfig.command);
  return args;
}
