import type { AgentDispatcherConfig, AppState, RoleState } from "../../types";
import { AgentDispatcherConfigSchema } from "../../types";
import { buildSystemPromptFromConfig, materializeDispatcherSystemPrompt } from "./prompt-builder";

export interface NormalizeAgentDispatcherConfigOptions {
  threadId?: string;
}

export function parseNormalizedAgentDispatcherConfig(
  config: unknown,
  options: NormalizeAgentDispatcherConfigOptions = {}
): AgentDispatcherConfig | null {
  const parsed = AgentDispatcherConfigSchema.safeParse(config);
  return parsed.success ? normalizeAgentDispatcherConfig(parsed.data, options) : null;
}

export function normalizeAgentDispatcherConfig(
  config: AgentDispatcherConfig,
  options: NormalizeAgentDispatcherConfigOptions = {}
): AgentDispatcherConfig {
  const normalizedDispatchRepoRoot = normalizeLegacyDispatchRepoRoot(config);
  const normalizedDocsRoot = normalizeLegacyDocsRoot(config);
  const normalizedConfig: AgentDispatcherConfig = {
    ...config,
    dispatch_repo_root: normalizedDispatchRepoRoot,
    docs_root: normalizedDocsRoot
  };
  const normalizedSystemPrompt = normalizeGeneratedSystemPrompt(normalizedConfig, options.threadId);

  return {
    ...normalizedConfig,
    system_prompt: normalizedSystemPrompt
  };
}

export function normalizePersistedAppState(state: AppState): AppState {
  return {
    ...state,
    roles: state.roles.map((roleState) => normalizePersistedAgentDispatcherRoleState(roleState))
  };
}

export function normalizePersistedAgentDispatcherRoleState(roleState: RoleState): RoleState {
  if (roleState.roleType !== "agent-dispatcher") {
    return roleState;
  }

  const normalizedConfig = parseNormalizedAgentDispatcherConfig(roleState.config, {
    threadId: roleState.threadId
  });
  if (!normalizedConfig) {
    return roleState;
  }

  return {
    ...roleState,
    config: normalizedConfig
  };
}

function normalizeLegacyDispatchRepoRoot(config: AgentDispatcherConfig): string | undefined {
  return normalizeText(config.dispatch_repo_root);
}

function normalizeLegacyDocsRoot(config: AgentDispatcherConfig): string | undefined {
  return normalizeText(config.docs_root);
}

function normalizeGeneratedSystemPrompt(
  config: AgentDispatcherConfig,
  threadId: string | undefined
): string | undefined {
  const systemPrompt = config.system_prompt;
  if (!systemPrompt || !threadId || !looksLikeGeneratedAgentDispatcherPrompt(systemPrompt)) {
    return systemPrompt;
  }

  return materializeDispatcherSystemPrompt(buildSystemPromptFromConfig(config), threadId);
}

function looksLikeGeneratedAgentDispatcherPrompt(prompt: string): boolean {
  const requiredMarkers = [
    "# Role Definition",
    "You are a project dispatcher.",
    "# Runtime Context",
    "dispatch_plan_path:",
    "command_file_path:",
    "dispatch_repo_root:",
    "user_reply_channels:",
    "default_agent_type:",
    "default_mode:",
    "kill_policy:",
    "resolved_model_map_json:",
    "The `meridian-tool` executable lives in the Meridian-roles repo"
  ];

  const hasSupportedWorkflowContract = prompt.includes("continue-dispatcher --dispatcher")
    || (prompt.includes("1. spawn") && prompt.includes("2. run"));

  return requiredMarkers.every((marker) => prompt.includes(marker)) && hasSupportedWorkflowContract;
}

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
