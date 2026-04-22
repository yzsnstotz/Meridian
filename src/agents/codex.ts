import type { BridgeMode, ReasoningEffort, SandboxMode } from "../types";

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

function appendReasoningEffortConfig(args: string[], reasoningEffort?: ReasoningEffort): void {
  if (!reasoningEffort) {
    return;
  }
  args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
}

export function buildCodexSpawnArgs(
  mode: BridgeMode,
  tmuxSession: string | null,
  endpointFlag: string,
  modelId?: string,
  autoApprove?: boolean,
  reasoningEffort?: ReasoningEffort,
  sandboxMode?: SandboxMode
): string[] {
  void mode;
  void tmuxSession;
  const args = ["server", `--type=${codexAgentConfig.type}`, endpointFlag];
  args.push("--", codexAgentConfig.command);
  appendReasoningEffortConfig(args, reasoningEffort);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (sandboxMode === "read-only") {
    args.push("--sandbox", "read-only");
  } else if (autoApprove === true) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return args;
}

export function buildCodexExecArgs(
  modelId?: string,
  autoApprove?: boolean,
  reasoningEffort?: ReasoningEffort,
  sandboxMode?: SandboxMode
): string[] {
  void autoApprove;
  const args = [codexAgentConfig.command, "exec", "--json"];
  appendReasoningEffortConfig(args, reasoningEffort);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (sandboxMode === "read-only") {
    args.push("--sandbox", "read-only");
  } else {
    // codex exec --json is always headless (stdin/stdout); it cannot prompt for
    // approvals and will reject untrusted directories without this flag.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return args;
}

export function buildCodexResumeArgs(
  sessionId: string,
  modelId?: string,
  autoApprove?: boolean,
  reasoningEffort?: ReasoningEffort,
  sandboxMode?: SandboxMode
): string[] {
  void autoApprove;
  const args = [codexAgentConfig.command, "exec", "resume", sessionId, "--json"];
  appendReasoningEffortConfig(args, reasoningEffort);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (sandboxMode === "read-only") {
    args.push("--sandbox", "read-only");
  } else {
    // Same as buildCodexExecArgs: headless exec always needs the bypass flag.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return args;
}
