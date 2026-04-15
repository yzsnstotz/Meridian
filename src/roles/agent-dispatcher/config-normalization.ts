import path from "node:path";

import type { AgentDispatcherConfig, AppState, RoleState } from "../../types";
import { AgentDispatcherConfigSchema } from "../../types";
import {
  DEFAULT_AGENT_DISPATCHER_DOCS_ROOT,
  DEFAULT_AGENT_DISPATCHER_REPO_ROOT,
  resolveConfiguredDocsRoot,
  resolveDispatchRepoRoot
} from "./dispatch-paths";
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
  const explicitRoot = normalizeText(config.dispatch_repo_root);
  if (!explicitRoot) {
    return undefined;
  }

  const inferredRoot = resolveDispatchRepoRoot([
    config.dispatch_plan_path,
    config.command_file_path
  ]);

  const detachedWorkspaceRoot = resolveDetachedWorkspaceRoot(config);
  if (
    inferredRoot !== explicitRoot
    && (explicitRoot === DEFAULT_AGENT_DISPATCHER_REPO_ROOT || explicitRoot === detachedWorkspaceRoot)
  ) {
    return inferredRoot;
  }

  return explicitRoot;
}

function normalizeLegacyDocsRoot(config: AgentDispatcherConfig): string | undefined {
  const explicitRoot = normalizeText(config.docs_root);
  if (!explicitRoot) {
    return undefined;
  }

  const inferredDocsRoot = resolveConfiguredDocsRoot({
    dispatch_plan_path: config.dispatch_plan_path,
    command_file_path: config.command_file_path
  });

  const detachedDocsRoot = resolveDetachedDocsRoot(config);
  if (
    inferredDocsRoot !== explicitRoot
    && (explicitRoot === DEFAULT_AGENT_DISPATCHER_DOCS_ROOT || explicitRoot === detachedDocsRoot)
  ) {
    return inferredDocsRoot;
  }

  return explicitRoot;
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

function resolveDetachedWorkspaceRoot(config: AgentDispatcherConfig): string | undefined {
  const candidate = parseDetachedDocsCandidate(config.dispatch_plan_path)
    ?? parseDetachedDocsCandidate(config.command_file_path);
  return candidate?.workspaceRoot;
}

function resolveDetachedDocsRoot(config: AgentDispatcherConfig): string | undefined {
  const candidate = parseDetachedDocsCandidate(config.dispatch_plan_path)
    ?? parseDetachedDocsCandidate(config.command_file_path);
  return candidate ? path.join(candidate.workspaceRoot, candidate.docsDirectoryName) : undefined;
}

function parseDetachedDocsCandidate(candidatePath: string): {
  workspaceRoot: string;
  docsDirectoryName: string;
} | null {
  const normalized = path.resolve(candidatePath).replace(/\\/g, "/");
  const segments = normalized.split("/");

  for (let index = 0; index <= segments.length - 4; index += 1) {
    const docsDirectoryName = segments[index];
    const docsSegment = docsDirectoryName?.toLowerCase();
    const projectSegment = segments[index + 1]?.toLowerCase();
    const branchSegment = segments[index + 3]?.toLowerCase();

    if (
      (docsSegment === "docs")
      && (projectSegment === "project" || projectSegment === "projects")
      && branchSegment === "branch"
    ) {
      const workspaceRoot = path.normalize(segments.slice(0, index).join("/") || path.sep);
      return {
        workspaceRoot,
        docsDirectoryName
      };
    }
  }

  return null;
}
