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

export function buildGeminiSpawnArgs(
  mode: BridgeMode,
  tmuxSession: string | null,
  endpointFlag: string,
  modelId?: string
): string[] {
  void mode;
  void tmuxSession;
  const args = ["server", `--type=${geminiAgentConfig.type}`, endpointFlag];
  args.push("--", geminiAgentConfig.command);
  if (modelId) {
    args.push("--model", modelId);
  }
  return args;
}
