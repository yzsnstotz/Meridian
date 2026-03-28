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
  modelId?: string,
  autoApprove?: boolean
): string[] {
  void mode;
  void tmuxSession;
  const args = ["server", `--type=${codexAgentConfig.type}`, endpointFlag];
  args.push("--", codexAgentConfig.command);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (autoApprove === true) {
    args.push("--approval-policy=auto-approve");
  }
  return args;
}

export function buildCodexExecArgs(modelId?: string, autoApprove?: boolean): string[] {
  const args = [codexAgentConfig.command, "exec", "--json"];
  if (modelId) {
    args.push("--model", modelId);
  }
  if (autoApprove === true) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return args;
}

export function buildCodexResumeArgs(sessionId: string, modelId?: string, autoApprove?: boolean): string[] {
  const args = [codexAgentConfig.command, "exec", "resume", sessionId, "--json"];
  if (modelId) {
    args.push("--model", modelId);
  }
  if (autoApprove === true) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return args;
}
