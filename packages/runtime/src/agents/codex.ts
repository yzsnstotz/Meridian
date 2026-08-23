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

function appendLeanContextConfig(args: string[]): void {
  // Every hub-spawned codex session pays a fixed context prologue that has
  // nothing to do with the task: the full skill roster with per-skill
  // instructions, a ~32KB "## Memory" developer message, and the multi-agent
  // preamble. Measured A/B against codex-cli 0.146.0 with an identical prompt:
  // 17,564 input tokens without these flags vs 10,016 with them (−43%), and the
  // prologue's "skill" mentions drop from 195 to 18. Workers get their task from
  // the dispatch prompt, so none of that prologue earns its cost.
  //
  // Read the env var at call time, not module load, so the escape hatch flips
  // without a rebuild+restart of the hub.
  //
  // This only touches agents the hub spawns — the operator's interactive codex
  // never goes through these builders, so their skills and memories stay intact.
  //
  // Keep these three key names and their boolean types exact: codex validates
  // `-c` keys and hard-errors on a wrong shape (e.g. `skills.bundled=false`
  // dies with "invalid type: boolean, expected struct BundledSkillsConfig"),
  // which would abort EVERY hub spawn, not just degrade one.
  const optOut = process.env.MERIDIAN_CODEX_LEAN_CONTEXT;
  if (optOut === "0" || optOut === "false") {
    return;
  }
  args.push("-c", "skills.include_instructions=false");
  args.push("-c", "features.memories=false");
  args.push("-c", "features.multi_agent=false");
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
  appendLeanContextConfig(args);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (sandboxMode === "read-only") {
    args.push("--sandbox", "read-only", "--skip-git-repo-check");
  } else if (autoApprove === true) {
    args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
  } else {
    // codex CLI enforces a trusted-directory check independently of approval
    // and sandbox flags. Worktrees under ~/.worktrees are not pre-trusted, so
    // every spawn path needs the explicit bypass.
    args.push("--skip-git-repo-check");
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
  appendLeanContextConfig(args);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (sandboxMode === "read-only") {
    // Read-only sandbox keeps approvals enforced, but headless exec still cannot
    // answer the trusted-directory prompt — bypass the git-repo gate explicitly.
    args.push("--sandbox", "read-only", "--skip-git-repo-check");
  } else {
    // codex exec --json is always headless (stdin/stdout); it cannot prompt for
    // approvals and will reject untrusted directories. The bypass flag covers
    // approvals/sandbox but does NOT cover the trust check on its own.
    args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
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
  appendLeanContextConfig(args);
  if (modelId) {
    args.push("--model", modelId);
  }
  if (sandboxMode === "read-only") {
    // Same gate as buildCodexExecArgs: headless resume cannot answer the
    // trusted-directory prompt under a read-only sandbox.
    args.push("--sandbox", "read-only", "--skip-git-repo-check");
  } else {
    // Same as buildCodexExecArgs: bypass covers approvals/sandbox but not the
    // trusted-directory check — pass both so untrusted worktrees don't abort.
    args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
  }
  return args;
}
