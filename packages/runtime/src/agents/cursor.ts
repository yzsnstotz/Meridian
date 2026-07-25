import type { BridgeMode } from "../types";

const CURSOR_AGENT_TYPE = "cursor";
const CURSOR_CLI_COMMAND = "cursor-agent";

export interface CursorAgentConfig {
  type: typeof CURSOR_AGENT_TYPE;
  command: typeof CURSOR_CLI_COMMAND;
}

export const cursorAgentConfig: CursorAgentConfig = {
  type: CURSOR_AGENT_TYPE,
  command: CURSOR_CLI_COMMAND
};

export function buildCursorSpawnArgs(
  mode: BridgeMode,
  tmuxSession: string | null,
  endpointFlag: string,
  modelId?: string
): string[] {
  void mode;
  void tmuxSession;
  const args = ["server", `--type=${cursorAgentConfig.type}`, endpointFlag];
  args.push("--", cursorAgentConfig.command);
  if (modelId) {
    args.push("--model", modelId);
  }
  return args;
}
