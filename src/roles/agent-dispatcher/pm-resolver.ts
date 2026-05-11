import path from "node:path";

import type { AgentDispatcherConfig } from "../../types";
import { LifecycleStore } from "./lifecycle-store";
import {
  createMeridianApiClient,
  type MeridianApiClient
} from "./meridian-api-client";
import {
  resolveConfiguredDispatchRepoRoot,
  resolveConfiguredDocsRoot
} from "./dispatch-paths";
import { parseModelIdWithEffort } from "../../tool-gateway/tools/spawn";
import {
  PM_RESOLVER_ACTIONS,
  PM_RESOLVER_MARKER_OUTCOMES
} from "./meridian-status-marker";
import { MERIDIAN_TOOL_DISPLAY_COMMAND } from "./tool-entrypoint";

export interface PmResolverIssueContext {
  status: string;
  workerId?: string;
  message?: string;
  error?: string;
  source?: string;
}

export interface PmResolverRequest {
  dispatcherId: string;
  config: AgentDispatcherConfig;
  issue: PmResolverIssueContext;
}

export type PmResolverResult =
  | {
      ok: true;
      status: "pm_resolver_started";
      thread_id: string;
      message: string;
    }
  | {
      ok: true;
      status: "pm_resolver_disabled";
      message: string;
    }
  | {
      ok: true;
      status: "pm_resolver_already_running";
      thread_id: string;
      message: string;
    };

export interface PmResolverDeps {
  meridianApi?: MeridianApiClient;
  log?: Pick<typeof console, "warn">;
  lifecycleStore?: Pick<
    LifecycleStore,
    "recordPmResolverStart" | "recordPmResolverResult" | "recordPmResolverTransportStall"
  >;
}

export async function startPmResolver(
  request: PmResolverRequest,
  deps: PmResolverDeps = {}
): Promise<PmResolverResult> {
  const pmConfig = request.config.pm_resolver;
  if (!pmConfig.enabled) {
    return {
      ok: true,
      status: "pm_resolver_disabled",
      message: "PM resolver is disabled for this role"
    };
  }

  const meridianApi = deps.meridianApi ?? createMeridianApiClient();
  const lifecycleStore = deps.lifecycleStore
    ?? new LifecycleStore(resolveDispatchThreadPath(request.config.dispatch_plan_path), {
      dispatchPlanPath: request.config.dispatch_plan_path
    });
  const spawnDir = resolveConfiguredDispatchRepoRoot(request.config) ?? path.dirname(request.config.dispatch_plan_path);
  const { modelId, effort } = parseModelIdWithEffort(pmConfig.model_id);
  const spawned = await meridianApi.spawn({
    agentType: pmConfig.agent_type,
    mode: pmConfig.mode,
    spawnDir,
    modelId,
    effort,
    autoApprove: pmConfig.auto_approve
  });
  safeRecordPmResolverStart(lifecycleStore, request, spawned.threadId, deps.log);
  const prompt = buildPmResolverPrompt(request);
  const run = meridianApi.run({
    threadId: spawned.threadId,
    content: prompt
  });

  run.then((result) => {
    safeRecordPmResolverResult(lifecycleStore, spawned.threadId, result, deps.log);
    void safeKillPmResolver(meridianApi, spawned.threadId, request.dispatcherId, deps.log);
  }).catch((error) => {
    // Transport-class rejection (hub overload, Meridian-API unreachable,
    // request timeout, IPC drop). The PM agent process may still be alive;
    // retain the thread so a human can take over via the GUI talk-box, and
    // record the transport stall WITHOUT flipping lifecycle status to
    // "failed". The reconciler still promotes this entry to "completed" if
    // the target worker reaches a healthy state via human-resolve, retry,
    // or other recovery paths.
    const errorMessage = error instanceof Error ? error.message : String(error);
    deps.log?.warn("PM resolver run rejected; retaining thread for human takeover", {
      dispatcherId: request.dispatcherId,
      threadId: spawned.threadId,
      error: errorMessage
    });
    safeRecordPmResolverTransportStall(lifecycleStore, spawned.threadId, errorMessage, deps.log);
  });

  return {
    ok: true,
    status: "pm_resolver_started",
    thread_id: spawned.threadId,
    message: `PM resolver started for ${request.issue.workerId ?? request.issue.status}`
  };
}

async function safeKillPmResolver(
  meridianApi: MeridianApiClient,
  threadId: string,
  dispatcherId: string,
  log: PmResolverDeps["log"]
): Promise<void> {
  try {
    await meridianApi.kill(threadId);
  } catch (error) {
    log?.warn("Failed to kill PM resolver thread after run", {
      dispatcherId,
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function safeRecordPmResolverStart(
  lifecycleStore: Pick<LifecycleStore, "recordPmResolverStart">,
  request: PmResolverRequest,
  threadId: string,
  log: PmResolverDeps["log"]
): void {
  try {
    const pmConfig = request.config.pm_resolver;
    lifecycleStore.recordPmResolverStart(threadId, request.issue, {
      agentType: pmConfig.agent_type,
      modelId: pmConfig.model_id,
      mode: pmConfig.mode,
      autoApprove: pmConfig.auto_approve
    });
  } catch (error) {
    log?.warn("Failed to record PM resolver start", {
      dispatcherId: request.dispatcherId,
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function safeRecordPmResolverResult(
  lifecycleStore: Pick<LifecycleStore, "recordPmResolverResult">,
  threadId: string,
  result: Awaited<ReturnType<MeridianApiClient["run"]>>,
  log: PmResolverDeps["log"]
): void {
  try {
    lifecycleStore.recordPmResolverResult(threadId, result);
  } catch (error) {
    log?.warn("Failed to record PM resolver result", {
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function safeRecordPmResolverTransportStall(
  lifecycleStore: Pick<LifecycleStore, "recordPmResolverTransportStall">,
  threadId: string,
  errorMessage: string,
  log: PmResolverDeps["log"]
): void {
  try {
    lifecycleStore.recordPmResolverTransportStall(threadId, errorMessage);
  } catch (error) {
    log?.warn("Failed to record PM resolver transport stall", {
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json");
}

export function buildPmResolverPrompt(request: PmResolverRequest): string {
  const config = request.config;
  const pmConfig = config.pm_resolver;
  const dispatchThreadsPath = path.join(path.dirname(config.dispatch_plan_path), "dispatch_threads.json");
  const workerIdPlaceholder = request.issue.workerId ?? "<worker_id>";
  const outcomeOptions = PM_RESOLVER_MARKER_OUTCOMES.join(" | ");
  const pmActionOptions = PM_RESOLVER_ACTIONS.join(" | ");

  return [
    "# Role",
    "You are the PM resolver for a Meridian dispatch. Resolve abnormal orchestration states that a dispatcher or scheduler cannot safely handle inside its narrow control loop.",
    "",
    "# Issue Context",
    `dispatcher_id: ${request.dispatcherId}`,
    `status: ${request.issue.status}`,
    `worker_id: ${request.issue.workerId ?? ""}`,
    `source: ${request.issue.source ?? "dispatcher"}`,
    `message: ${request.issue.message ?? ""}`,
    `error: ${request.issue.error ?? ""}`,
    "",
    "# Runtime Paths",
    `dispatch_plan_path: ${config.dispatch_plan_path}`,
    `command_file_path: ${config.command_file_path}`,
    `dispatch_threads_path: ${dispatchThreadsPath}`,
    `dispatch_repo_root: ${resolveConfiguredDispatchRepoRoot(config)}`,
    `docs_root: ${resolveConfiguredDocsRoot(config)}`,
    "",
    "# Channels",
    `dispatcher_user_reply_channels: ${JSON.stringify(config.user_reply_channels)}`,
    `pm_user_reply_channels: ${JSON.stringify(pmConfig.user_reply_channels)}`,
    "",
    "# Authority",
    "- Inspect the dispatch plan, lifecycle sidecar, worker reports, command file, repo, and docs needed to understand the blocker.",
    "- You may edit source, docs, dispatch plan notes/statuses, or config when that is the appropriate fix.",
    "- If the target worker report already exists, append a PM resolver section to it instead of replacing prior worker or validator history.",
    "- You may choose model/routing recommendations and update the plan when the current assignment is the blocker.",
    "- You may use the configured PM channels for user-facing status, questions, and escalation.",
    "- Escalate to a human only for credentials, approvals, external account actions, or product decisions you cannot resolve from the available context.",
    "",
    "# Meridian Control Tools",
    `Use only \`${MERIDIAN_TOOL_DISPLAY_COMMAND} <command>\` for dispatcher state handoff actions. The commands return JSON; check \`ok\` and \`status\` before taking the next action.`,
    `- \`${MERIDIAN_TOOL_DISPLAY_COMMAND} update-status --plan ${config.dispatch_plan_path} --worker ${request.issue.workerId ?? "<worker_id>"} --status completed\``,
    `- \`${MERIDIAN_TOOL_DISPLAY_COMMAND} resume-worker --plan ${config.dispatch_plan_path} --worker ${request.issue.workerId ?? "<worker_id>"} --action retry --force true\``,
    `- \`${MERIDIAN_TOOL_DISPLAY_COMMAND} continue-dispatcher --dispatcher ${request.dispatcherId} [--worker <worker_id>]\``,
    `- \`${MERIDIAN_TOOL_DISPLAY_COMMAND} notify --message "<text>" --urgency <low|normal|high> --reply-channels '${JSON.stringify(pmConfig.user_reply_channels)}'\``,
    "",
    "# Resolution Protocol",
    "1. Diagnose the abnormal state from the dispatch plan, lifecycle sidecar, report files, repo, and docs. Do not assume the blocked worker is wrong; verify the failing condition.",
    "2. If the blocker is resolvable from available context, make the smallest necessary source/docs/plan/config changes and run the relevant verification commands.",
    "3. If the blocked worker's acceptance criteria are fully satisfied after your resolution, mark that worker completed with `update-status`, then call `continue-dispatcher --dispatcher <dispatcher_id>` so Meridian launches the next eligible row.",
    "4. If the correct resolution is to rerun the blocked worker instead of marking it complete, call `resume-worker --action retry --force true`, then call `continue-dispatcher --dispatcher <dispatcher_id> --worker <worker_id>`.",
    "5. If you cannot resolve it without credentials, external approvals, or product decisions, use `notify` with the PM channels and leave a precise blocker summary. Do not call `continue-dispatcher` in that case.",
    "",
    "# Completion",
    "Do not stop with only advice when a safe state transition is available. Close the loop by updating or retrying the worker and invoking dispatcher continuation. Then leave a concise summary including the commands you ran and the dispatcher result.",
    "",
    "# Reply Protocol",
    "Your final reply MUST end with exactly one status block, plain text, NOT inside a code fence:",
    "",
    "<<<MERIDIAN-STATUS>>>",
    `worker_id: ${workerIdPlaceholder}`,
    "role: pm-resolver",
    `outcome: ${outcomeOptions}`,
    `pm_action: ${pmActionOptions}`,
    "notes: <one line: what you decided and why>",
    "<<<END>>>",
    "",
    "This block is the ONLY authoritative signal of your decision. Pick exactly one `outcome`:",
    "- `resolved` — you took a concrete corrective action via meridian-tool (update-status, resume-worker, continue-dispatcher) and the dispatcher can resume. The lifecycle store records this PM run as completed.",
    "- `escalated` — you reached a hard blocker (credentials, approvals, product decisions) and used `notify` to surface it. The lifecycle store records this PM run as failed-but-escalated; the dispatcher pauses pending human action.",
    "",
    "Pick exactly one `pm_action` describing the concrete control action you took (or recommended for the escalation case):",
    "- `retry` — you called `resume-worker --action retry`.",
    "- `skip` — you called `resume-worker --action skip` or otherwise advanced past the worker.",
    "- `force_complete` — you called `update-status ... --status completed`.",
    "- `wait` — you took no state change; the worker should remain in its current status pending external action.",
    "- `escalate_human` — you sent a `notify` and require human input before the dispatcher can continue.",
    "",
    "If you must reference the marker format earlier in your reply, wrap that example in a fenced code block (```); only the unfenced block at the end of your reply is parsed."
  ].join("\n");
}
