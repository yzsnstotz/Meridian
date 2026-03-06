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

export function buildCodexSpawnArgs(
  mode: BridgeMode,
  tmuxSession: string | null,
  endpointFlag: string,
  modelId?: string
): string[] {
  void mode;
  void tmuxSession;
  const args = ["server", `--type=${codexAgentConfig.type}`, endpointFlag];
  args.push("--", codexAgentConfig.command);
  if (modelId) {
    args.push("--model", modelId);
  }
  return args;
}
