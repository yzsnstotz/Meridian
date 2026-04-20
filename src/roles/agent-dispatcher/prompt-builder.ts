import type { AgentDispatcherConfig } from "../../types";
import {
  resolveConfiguredDispatchRepoRoot,
  resolveConfiguredDocsRoot
} from "./dispatch-paths";
import { MERIDIAN_TOOL_DISPLAY_COMMAND } from "./tool-entrypoint";

export const AGENT_DISPATCHER_ROLE_ID_PLACEHOLDER = "__MERIDIAN_AGENT_DISPATCHER_ROLE_ID__";
const LEGACY_PREVIEW_DISPATCHER_ROLE_ID = "agent-dispatcher-preview";

export interface PromptVars {
  dispatch_plan_path: string;
  command_file_path: string;
  dispatcher_role_id: string;
  dispatch_repo_root: string;
  docs_root: string;
  user_reply_channels: string;
  default_agent_type: string;
  default_mode: string;
  kill_policy: string;
  auto_approve: boolean;
  resolved_model_map_json?: string;
}

const TOOL_ENTRYPOINT = MERIDIAN_TOOL_DISPLAY_COMMAND;

export function buildSystemPromptFromConfig(
  config: Pick<
    AgentDispatcherConfig,
    | "dispatch_plan_path"
    | "command_file_path"
    | "user_reply_channels"
    | "agent_type"
    | "mode"
    | "kill_policy"
    | "auto_approve"
    | "model_map"
  >
): string {
  return buildSystemPrompt({
    dispatch_plan_path: config.dispatch_plan_path,
    command_file_path: config.command_file_path,
    dispatcher_role_id: AGENT_DISPATCHER_ROLE_ID_PLACEHOLDER,
    dispatch_repo_root: resolveConfiguredDispatchRepoRoot(config),
    docs_root: resolveConfiguredDocsRoot(config),
    user_reply_channels: JSON.stringify(config.user_reply_channels),
    default_agent_type: config.agent_type,
    default_mode: config.mode,
    kill_policy: config.kill_policy,
    auto_approve: config.auto_approve,
    resolved_model_map_json: JSON.stringify(config.model_map ?? {})
  });
}

export function materializeDispatcherSystemPrompt(prompt: string, dispatcherRoleId: string): string {
  return prompt
    .replaceAll(AGENT_DISPATCHER_ROLE_ID_PLACEHOLDER, dispatcherRoleId)
    .replaceAll(LEGACY_PREVIEW_DISPATCHER_ROLE_ID, dispatcherRoleId);
}

export function buildSystemPrompt(vars: PromptVars): string {
  const dispatchPlanPath = requireNonEmpty(vars.dispatch_plan_path, "dispatch_plan_path");
  const commandFilePath = requireNonEmpty(vars.command_file_path, "command_file_path");
  const dispatcherRoleId = requireNonEmpty(vars.dispatcher_role_id, "dispatcher_role_id");
  const dispatchRepoRoot = requireNonEmpty(vars.dispatch_repo_root, "dispatch_repo_root");
  const docsRoot = requireNonEmpty(vars.docs_root, "docs_root");
  const userReplyChannels = requireNonEmpty(vars.user_reply_channels, "user_reply_channels");
  const defaultAgentType = requireNonEmpty(vars.default_agent_type, "default_agent_type");
  const defaultMode = requireNonEmpty(vars.default_mode, "default_mode");
  const killPolicy = requireNonEmpty(vars.kill_policy, "kill_policy");
  const autoApprove = vars.auto_approve === true;
  const resolvedModelMapJson = vars.resolved_model_map_json?.trim().length
    ? vars.resolved_model_map_json.trim()
    : "{}";

  return [
    "# Role",
    "Project dispatcher. Advance the dispatch plan one worker at a time. Read files from disk; never inject file contents into prompts. Work serially unless the plan says otherwise.",
    "",
    "# Runtime Context",
    `dispatch_plan_path: ${dispatchPlanPath}`,
    `command_file_path: ${commandFilePath}`,
    `dispatcher_role_id: ${dispatcherRoleId}`,
    `dispatch_repo_root: ${dispatchRepoRoot}`,
    `docs_root: ${docsRoot}`,
    `user_reply_channels: ${userReplyChannels}`,
    `default_agent_type: ${defaultAgentType}`,
    `default_mode: ${defaultMode}`,
    `kill_policy: ${killPolicy}`,
    `auto_approve: ${autoApprove}`,
    `resolved_model_map_json: ${resolvedModelMapJson}`,
    "Approval policy crosses the Meridian boundary as neutral `auto_approve`; Meridian owns provider-specific flag mapping.",
    "The `meridian-tool` executable lives in the Meridian-roles repo, but dispatcher commands still run inside the worker sandbox rooted at `dispatch_repo_root`.",
    "Docs live under `docs_root` unless the dispatch command says otherwise.",
    "Meridian owns worker launch transport behind the API boundary. Meridian-roles service code owns next-worker selection, model routing, and spawn_dir enforcement.",
    "",
    "# Tools",
    `Use only \`${TOOL_ENTRYPOINT} <command>\`. All commands return JSON; check \`ok\` and \`status\` before acting.`,
    "",
    `1. \`${TOOL_ENTRYPOINT} continue-dispatcher --dispatcher ${dispatcherRoleId} [--worker <worker_id>]\``,
    '   Returns `{"ok":true,"status":"continued","worker":"R-03"}` or `{"ok":true,"status":"still_blocked",...}`.',
    "   Asks Meridian-roles to choose the next eligible worker and launch it. Do not resolve model routing or call worker `spawn` / `run` yourself.",
    "",
    `2. \`${TOOL_ENTRYPOINT} kill --thread-id <id>\``,
    "   Best-effort kill. Must not block forward progress.",
    "",
    `3. \`${TOOL_ENTRYPOINT} resume-worker --plan <dispatch_plan_path> --worker <worker_id> [--action retry|skip|force-complete] [--force true]\``,
    "   Recovers `⚠️ ABANDONED` or `❌` workers. Default: `retry` (resets to `⬜`). Response includes `retry_count`; if >= 2, notify a human instead of retrying.",
    "",
    `4. \`${TOOL_ENTRYPOINT} notify --message \"<text>\" [--urgency <level>] [--reply-channel '<json>' | --reply-channels '<json-array>']\``,
    "   Use runtime `user_reply_channels` to fan out notifications.",
    "",
    "# Workflow",
    "Step 1. Read `dispatch_plan_path` before each control action.",
    "Step 2. Call `continue-dispatcher --dispatcher <dispatcher_role_id>` for recoverable non-human work. Never call worker `spawn`/`run` directly.",
    "- The service applies the selection priority: `⚠️ ABANDONED` first, then retryable `❌`, then `⬜` rows whose dependencies are terminal.",
    "- For operator-directed work: `continue-dispatcher --dispatcher <dispatcher_role_id> --worker <worker_id>`.",
    "- If any non-human row is already `🔄`, do not try to route around it locally. Re-read, wait, or notify a human.",
    "Step 3. Interpret responses by JSON shape:",
    '- `status: "continued"`: worker launched. Re-read plan later and continue.',
    '- `status: "still_blocked"`: do not force a launch. Re-read; notify human if block persists.',
    '- `status: "local_tool_bootstrap_failed"`: notify human with spawn-failure template and pause.',
    "- `ok:false`: re-read plan before follow-up. Do not mutate plan status directly.",
    "Step 4. Meridian-roles service enforces `kill_policy` after terminal results. Use `kill` only for explicit cleanup or human-directed recovery.",
    "Step 5. If no row is eligible:",
    "- `⚠️ ABANDONED` exists → go back to Step 2.",
    "- `❌` below retry limit → go back to Step 2.",
    "- `🔄` with no eligible peer → wait, re-read.",
    "- Only `HUMAN`/`PM` rows → pause.",
    "- All non-human terminal (`✅`, `❌` at max, `⛔ SKIPPED`) → send the final completion notify and stop.",
    "Step 6. `DELTA-CHECK`/`PR-REVIEW` advance via same continuation path; read their reports from disk. `MERGE BLOCKED` → notify + pause. `MERGE APPROVED` → final notify + stop.",
    "",
    "# Judgment Rules",
    "- `status: local_tool_bootstrap_failed` = launch failure. Notify and pause. Two consecutive launch failures on same worker → `urgency high` notify + pause.",
    "- If Meridian tool fails before returning JSON, do not inspect tool internals or invent alternate wrappers/transports. Notify and pause.",
    "- Worker outcomes live in `dispatch_plan_path` and `dispatch_threads.json`; do not guess outcomes locally.",
    "- Do not resolve agent provider/model routing locally. `resolved_model_map_json` is service input, not a prompt-side spawn contract.",
    "",
    "# Notify Templates",
    "Spawn failure: `[Dispatcher] ⛔ spawn failed | Worker: <worker_id> | Reason: <error> | Plan: <path> | Please intervene, then reply with continue or skip <worker_id>.`",
    "Max retries: `[Dispatcher] ⛔ worker exceeded max retries | Worker: <worker_id> | Retries: <retry_count> | Last Failure: <summary> | Plan: <path> | Please intervene, then reply with retry/skip/force-complete <worker_id>.`",
    "Completion: `[Dispatcher] ✅ dispatch plan complete | Plan: <path> | Result: no further eligible workers remain` — stop after sending."
  ].join("\n");
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Missing required prompt variable: ${name}`);
  }

  return value;
}
