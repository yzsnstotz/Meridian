import type { BridgeMode } from "../types";

const GEMINI_AGENT_TYPE = "gemini";
const GEMINI_CLI_COMMAND = "gemini";

export interface GeminiAgentConfig {
  type: typeof GEMINI_AGENT_TYPE;
  command: typeof GEMINI_CLI_COMMAND;
}

export const geminiAgentConfig: GeminiAgentConfig = {
  type: GEMINI_AGENT_TYPE,
  command: GEMINI_CLI_COMMAND
};

export function buildGeminiSpawnArgs(mode: BridgeMode, tmuxSession: string | null): string[] {
  const args = ["server", `--type=${geminiAgentConfig.type}`];
  if (mode === "pane_bridge" && tmuxSession) {
    args.push(`--tmux-session=${tmuxSession}`);
  }
  args.push("--", geminiAgentConfig.command);
  return args;
}
