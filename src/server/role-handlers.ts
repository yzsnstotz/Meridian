import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import { z } from "zod";

import type { A2AClient } from "../a2a/client";
import { HUB_SOCKET_PATH, ROLES_SERVICE_ID } from "../config";
import {
  resolveConfiguredDispatchRepoRoot,
  resolveConfiguredDocsRoot
} from "../roles/agent-dispatcher/dispatch-paths";
import { wrapForHub } from "../shared/caller-identity";
import { continueDispatchWorker } from "../roles/agent-dispatcher/continue-worker";
import {
  LifecycleStore,
  findActivePmResolversForWorker,
  hubResultContainsBlockSignal,
  hubResultContainsFailureSignal,
  hubResultContainsHitLimit,
  isPmResolverHubResult,
  isValidatorSpawnBackoffActive
} from "../roles/agent-dispatcher/lifecycle-store";
import { createMeridianApiClient, type MeridianApiClient } from "../roles/agent-dispatcher/meridian-api-client";
import { parseMeridianStatusMarker } from "../roles/agent-dispatcher/meridian-status-marker";
import { isMissingThreadEvidence } from "../roles/agent-dispatcher/missing-thread";
import {
  AGENT_DISPATCHER_ROLE_ID_PLACEHOLDER,
  buildSystemPrompt,
  materializeDispatcherSystemPrompt
} from "../roles/agent-dispatcher/prompt-builder";
import {
  normalizeReasoningEffort,
  parseDispatchModelCode
} from "../roles/agent-dispatcher/model-routing";
import {
  startPmResolver as startPmResolverDefault,
  type PmResolverRequest,
  type PmResolverResult
} from "../roles/agent-dispatcher/pm-resolver";
import { reconcile } from "../roles/agent-dispatcher/reconciler";
import { SchedulerStateStore } from "../roles/scheduler/scheduler-state-store";
import {
  hasRecoverableDispatchWork,
  isHumanDispatchRow,
  resolveManualInterventionWorker,
  resolveServiceContinueWorker,
  type DispatchContinuationPlanRow
} from "../roles/agent-dispatcher/service-continuation";
import {
  isValidationEnabledForWorker,
  isValidatorResultPassing,
  interceptCompletionForValidation,
  executeValidationCycle,
  deliverValidatorFeedback,
  type ValidatorOrchestratorDeps
} from "../roles/agent-dispatcher/validator-orchestrator";
import { launchDispatchWorker, type LaunchDispatchWorkerConfig, type LaunchDispatchWorkerResult } from "../roles/agent-dispatcher/worker-launcher";
import { buildDispatchStatusReport, type DispatchWorkerProgress } from "../tool-gateway/tools/dispatch-status";
import { executeResumeWorkerAction, ResumeWorkerActionRequestSchema } from "../tool-gateway/tools/resume-worker";
import { executeUpdateWorkerStatusAction } from "../tool-gateway/tools/update-status";
import {
  parseMutableAgentDispatcherConfig,
  toEditableAgentDispatcherConfig
} from "../roles/dispatcher-config-editor";
import type { PromptStoreRoleBinding } from "../roles/prompt-store";
import { RoleRegistry } from "../roles/role-registry";
import { RoleRunner } from "../roles/role-runner";
import {
  ACTIVE_ROLE_STATUS,
  isReconcilableAgentDispatcherRoleStatus,
  isTerminalAgentDispatcherRoleStatus,
  NEEDS_REACTIVATION_ROLE_STATUS,
  StateStore
} from "../state-store";
import {
  AgentDispatcherConfigSchema,
  AgentTypeSchema,
  AppStateSchema,
  StatefulBridgeModeSchema,
  type DispatchThreadStateV2,
  type DispatchWorkerState,
  type LifecycleStatus,
  DispatchTaskSchema,
  DispatcherConfigSchema,
  HubMessageSchema,
  HubResultSchema,
  KillPolicySchema,
  PmResolverConfigSchema,
  ReplyChannelSchema,
  ValidatorConfigSchema,
  RoleTypeSchema,
  SchedulerConfigSchema,
  type AgentDispatcherEditorConfig,
  type AppState,
  type AgentDispatcherConfig,
  type DispatcherConfig,
  type HubMessage,
  type HubResult,
  type PmResolverLifecycleState,
  type ReplyChannel,
  type RoleType,
  type RoleState,
  type SchedulerConfig,
  type ValidatorConfig
} from "../types";
import {
  buildEnvReplyChannelPresets,
  listAllowedUserIdsFromEnv,
  listTelegramBotNumericIdsFromEnv,
  mergeReplyChannelLists
} from "./env-reply-channel-presets";
import type { Logger } from "../roles/base-role";

type PersistableStateStore = Pick<StateStore, "load" | "save">;
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const DISPATCHER_WORKER_ID = "DISPATCHER";
const REACTIVATION_REQUIRED_DISPATCHER_STATUSES = new Set<LifecycleStatus>(["abandoned", "failed"]);
const PM_RESOLVER_DETAIL_TIMEOUT_MS = 1_500;
type DispatcherThreadAwareRole = {
  getDispatcherThreadId(): string | null;
};

const CreateRoleBodySchema = z.object({
  thread_id: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  role_type: RoleTypeSchema.optional(),
  roleType: RoleTypeSchema.optional(),
  tasks: z.array(DispatchTaskSchema).optional(),
  taskspec: z.string().optional(),
  system_prompt: z.string().optional(),
  user_reply_channel: ReplyChannelSchema.optional(),
  user_reply_channels: z.array(ReplyChannelSchema).min(1).optional(),
  dispatch_plan_path: z.string().min(1).optional(),
  command_file_path: z.string().min(1).optional(),
  dispatch_repo_root: z.string().min(1).optional(),
  docs_root: z.string().min(1).optional(),
  agent_type: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  kill_policy: z.string().min(1).optional(),
  auto_approve: z.boolean().optional(),
  use_agent_dispatcher: z.boolean().optional(),
  validator: ValidatorConfigSchema.optional(),
  pm_resolver: PmResolverConfigSchema.optional(),
  config: z.unknown().optional()
});

const AgentDispatcherPromptPreviewBodySchema = z.object({
  dispatch_plan_path: z.string().min(1).optional(),
  command_file_path: z.string().min(1).optional(),
  dispatch_repo_root: z.string().min(1).optional(),
  docs_root: z.string().min(1).optional(),
  user_reply_channel: ReplyChannelSchema.optional(),
  user_reply_channels: z.array(ReplyChannelSchema).min(1).optional(),
  agent_type: AgentTypeSchema.optional(),
  mode: StatefulBridgeModeSchema.optional(),
  kill_policy: KillPolicySchema.optional(),
  auto_approve: z.boolean().optional(),
  pm_resolver: PmResolverConfigSchema.optional()
});

const AgentDispatcherConfigPatchSchema = z.object({
  agent_type: AgentTypeSchema.optional(),
  model_id: z.string().min(1).optional().nullable(),
  mode: StatefulBridgeModeSchema.optional(),
  kill_policy: KillPolicySchema.optional(),
  auto_approve: z.boolean().optional(),
  validator: ValidatorConfigSchema.optional(),
  pm_resolver: PmResolverConfigSchema.optional()
}).strict();

const UpdateWorkerStatusRequestSchema = z.object({
  status: z.string().min(1),
  thread_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning_effort: z.string().min(1).optional()
});

const HumanResolveWorkerRequestSchema = z.object({
  note: z.string().min(1).optional()
});

const PmResolveRequestSchema = z.object({
  status: z.string().min(1),
  worker_id: z.string().min(1).optional(),
  worker: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  source: z.string().min(1).optional()
});

type RoleRouteMatch =
  | { kind: "health" }
  | { kind: "list-channels" }
  | { kind: "list-roles" }
  | { kind: "preview-agent-dispatcher-prompt" }
  | { kind: "get-role"; threadId: string }
  | { kind: "get-config"; threadId: string }
  | { kind: "start-agent-dispatcher" }
  | { kind: "pause-dispatcher"; threadId: string }
  | { kind: "resume-dispatcher"; threadId: string }
  | { kind: "continue-dispatcher"; threadId: string }
  | { kind: "pm-resolve"; threadId: string }
  | { kind: "start-dispatcher-hub"; threadId: string }
  | { kind: "resume-worker"; threadId: string; workerId: string }
  | { kind: "continue-worker"; threadId: string; workerId: string }
  | { kind: "update-worker-status"; threadId: string; workerId: string }
  | { kind: "human-resolve-worker"; threadId: string; workerId: string }
  | { kind: "reconcile" }
  | { kind: "patch-config"; threadId: string }
  | { kind: "delete-role"; threadId: string }
  | { kind: "hub-relay" };

const PACKAGE_VERSION = readPackageVersion();

export interface RoleHandlersOptions {
  runner: RoleRunner;
  registry: RoleRegistry;
  stateStore?: PersistableStateStore;
  listReplyChannels?: () => Promise<ReplyChannel[]>;
  getThreadDetail?: (threadId: string) => Promise<string>;
  attachToThread?: (threadId: string) => Promise<void>;
  sendHubRequest?: (message: HubMessage) => Promise<HubResult>;
  launchDispatchWorker?: (config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult>;
  startPmResolver?: (request: PmResolverRequest) => Promise<PmResolverResult>;
  meridianApi?: MeridianApiClient;
  log?: Logger;
}

export interface RoleHandlers {
  getConfig(threadId: string): Promise<RoleConfigResponse>;
  patchConfig(threadId: string, body: unknown): Promise<RoleConfigResponse>;
  continueDispatcher(threadId: string, workerId?: string): Promise<ContinueDispatcherResponse>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  resolveRole(threadId: string): PromptStoreRoleBinding | null;
}

export interface RoleConfigResponse {
  thread_id: string;
  status: string;
  can_edit: boolean;
  blocked_reason?: string;
  config: AgentDispatcherEditorConfig;
}

export interface DispatchPlanRow {
  status: string;
  batch: string;
  worker: string;
  task: string;
  model: string;
  depends_on: string;
  prds_to_attach?: string;
  notes?: string;
  lifecycle_status?: string | null;
  thread_id?: string | null;
  last_seen_at?: string | null;
  stale?: boolean;
  stale_label?: string | null;
  stale_duration_minutes?: number | null;
  stale_duration_human?: string | null;
  progress?: DispatchWorkerProgress | null;
  // The currently active owner of this row — surfaced on the main task
  // bar so operators can see whether the worker, validator, or PM
  // resolver is actually running, plus its thread id.
  active_owner_kind?: "worker" | "validator" | "pm_resolver" | null;
  active_owner_thread_id?: string | null;
}

export interface DispatchMessageDetail {
  trace_id: string | null;
  sender_name: string;
  sender_agent_type: string | null;
  sender_model: string | null;
  sender_thread_id: string | null;
  timestamp: string | null;
  content: string;
}

export interface DispatchWorkerDetail {
  detail_kind?: "worker" | "pm_resolver" | "validator";
  worker_id: string;
  // task_id identifies the dispatch-plan worker this bar belongs to.
  // - For `worker` entries: the worker's own id.
  // - For `pm_resolver` entries: the target worker the PM was resolving.
  // - For `validator` entries: the worker that was being validated.
  // The frontend groups bars by task_id so every dispatcher/scheduler/etc.
  // task hosts its own stack of role-specific bars.
  task_id?: string | null;
  status: string;
  task: string | null;
  model: string | null;
  applied_model: string | null;
  applied_reasoning_effort: string | null;
  worker_thread_id: string;
  trace_id: string | null;
  command: DispatchMessageDetail | null;
  reply: DispatchMessageDetail | null;
  validation: DispatchValidationDetail | null;
  // Number of times this worker has been re-launched. The current data
  // model only retains the latest attempt's hub_result; prior attempts'
  // reply text is not persisted. The frontend surfaces this as a badge
  // on the worker bar so retried work is visible even though only the
  // most recent attempt's prompt+reply is available.
  retry_count?: number;
  // Validator-only fields. Populated for entries with detail_kind === "validator".
  validator_cycle?: number;
  validator_score?: number | null;
  validator_outcome?: "pass" | "fix_requested" | "fail";
  // GUI-only signal: true when the underlying session/thread should be
  // considered live (the worker, validator, or PM resolver is in a
  // running/in-flight state with a thread_id present). Drives the green-dot
  // indicator on each dispatch detail card.
  is_alive?: boolean;
  // Set on `worker` bars when an operator explicitly marked the worker
  // resolved out-of-band (PM-killed-after-human-takeover scenario). The GUI
  // surfaces this as a HUMAN-resolved badge so PM failure context is not
  // mistaken for a regression.
  human_resolution?: { resolved_at: string; note: string | null } | null;
}

export interface DispatchValidationDetail {
  current_cycle: number;
  max_fix_cycles: number;
  validator_thread_id: string | null;
  last_score: number | null;
  last_feedback: string | null;
  history: DispatchValidationHistoryEntry[];
}

export interface DispatchValidationHistoryEntry {
  cycle: number;
  score: number;
  feedback: string;
  validator_thread_id: string;
  timestamp: string;
}

export interface RoleDetailResponse {
  thread_id: string;
  role_type: string;
  status: string;
  taskspec?: string;
  system_prompt?: string;
  tasks: Array<{
    task_id: string;
    status: string;
    depends_on: string[];
    trace_id?: string;
    result_summary?: string;
    instruction: string;
  }>;
  dispatch_plan_path?: string;
  command_file_path?: string;
  dispatch_repo_root?: string;
  docs_root?: string;
  dispatcher_thread_id?: string | null;
  continue_worker?: string | null;
  current_worker?: string | null;
  last_log_line?: string | null;
  user_reply_channels?: ReplyChannel[];
  agent_type?: string;
  model_id?: string;
  mode?: string;
  kill_policy?: string;
  auto_approve?: boolean;
  session_log?: string[];
  dispatch_details?: DispatchWorkerDetail[];
  dispatch_plan?: {
    rows: DispatchPlanRow[];
  };
}

export interface ContinueDispatcherResponse {
  ok: true;
  status: "continued" | "still_blocked" | "plan_complete" | "local_tool_bootstrap_failed" | "manual_intervention_required" | "validation_in_progress" | "validation_feedback_delivered";
  message: string;
  dispatcher_thread_id?: string;
  worker?: string;
  running_workers?: string[];
  pm_resolver_thread_ids?: string[];
  resume_result?: Awaited<ReturnType<typeof executeResumeWorkerAction>>;
  error?: string;
  validation_outcome?: string;
}

interface StartAgentDispatcherHubSessionResponse {
  ok: true;
  dispatcher_thread_id?: string;
  status?: "still_blocked";
  message?: string;
}

export interface DispatchPlanData {
  rows: DispatchPlanRow[];
  modelLegend: DispatchPlanModelLegend;
}

export type DispatchPlanModelLegend = Record<string, {
  provider: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
}>;

export function createRoleHandlers(options: RoleHandlersOptions): RoleHandlers {
  const stateStore = options.stateStore ?? new StateStore();
  const log = options.log ?? console;
  const listReplyChannels = options.listReplyChannels ?? (async () => []);
  const getThreadDetail = options.getThreadDetail;
  const attachToThread = options.attachToThread ?? defaultAttachToThread;
  const sendHubRequestImpl = options.sendHubRequest ?? sendHubRequest;
  const launchDispatchWorkerImpl = options.launchDispatchWorker ?? launchDispatchWorker;
  const startPmResolverImpl = options.startPmResolver ?? startPmResolverDefault;
  const activeRoles = new Map<string, PromptStoreRoleBinding>();

  function syncActiveRolesFromRunner(): void {
    const activeThreadIds = new Set<string>();

    for (const liveRole of options.runner.listRoles()) {
      activeThreadIds.add(liveRole.threadId);
      const existing = activeRoles.get(liveRole.threadId);
      if (existing?.roleType === liveRole.roleType) {
        continue;
      }

      activeRoles.set(liveRole.threadId, {
        roleType: liveRole.roleType,
        config: liveRole.config
      });
    }

    for (const threadId of [...activeRoles.keys()]) {
      if (!activeThreadIds.has(threadId)) {
        activeRoles.delete(threadId);
      }
    }
  }

  function resolveActiveRoleBinding(threadId: string): PromptStoreRoleBinding | null {
    syncActiveRolesFromRunner();

    const cachedRole = activeRoles.get(threadId);
    if (cachedRole) {
      return cachedRole;
    }

    const liveRole = options.runner.getRole(threadId);
    if (!liveRole) {
      return null;
    }

    const binding: PromptStoreRoleBinding = {
      roleType: liveRole.roleType,
      config: liveRole.config
    };
    activeRoles.set(threadId, binding);
    return binding;
  }

  const handlers: RoleHandlers = {
    continueDispatcher: continueDispatcherForRole,

    async getConfig(threadId: string): Promise<RoleConfigResponse> {
      const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
      return {
        thread_id: threadId,
        status: context.status,
        can_edit: true,
        config: toEditableAgentDispatcherConfig(context.effectiveConfig)
      };
    },
    async patchConfig(threadId: string, body: unknown): Promise<RoleConfigResponse> {
      const parsed = AgentDispatcherConfigPatchSchema.safeParse(body);
      if (!parsed.success) {
        throw createHttpError(400, `Invalid config patch: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
      }

      const patch = parsed.data;
      const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
      const config = context.effectiveConfig;

      if (patch.agent_type !== undefined) config.agent_type = patch.agent_type;
      if (patch.mode !== undefined) config.mode = patch.mode;
      if (patch.kill_policy !== undefined) config.kill_policy = patch.kill_policy;
      if (patch.auto_approve !== undefined) config.auto_approve = patch.auto_approve;
      if (patch.model_id !== undefined) config.model_id = patch.model_id ?? undefined;
      if (patch.validator !== undefined) config.validator = patch.validator;
      if (patch.pm_resolver !== undefined) {
        config.pm_resolver = {
          ...patch.pm_resolver,
          user_reply_channels: patch.pm_resolver.user_reply_channels
            ?? config.user_reply_channels.map((replyChannel) => ({ ...replyChannel }))
        };
      }

      // Persist to state store
      if (context.roleState) {
        context.roleState.config = config;
        await stateStore.save(context.state);
      }

      // Update active in-memory role binding
      const activeBinding = resolveActiveRoleBinding(threadId);
      if (activeBinding) {
        (activeBinding as { config: unknown }).config = config;
      }

      return {
        thread_id: threadId,
        status: context.status,
        can_edit: true,
        config: toEditableAgentDispatcherConfig(config)
      };
    },
    resolveRole(threadId: string): PromptStoreRoleBinding | null {
      return resolveActiveRoleBinding(threadId);
    },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const route = matchRoleRoute(request);
      if (!route) {
        return false;
      }

      try {
        switch (route.kind) {
          case "health":
            writeJson(response, 200, await getHealth());
            return true;
          case "list-channels":
            writeJson(response, 200, await getChannels());
            return true;
          case "list-roles":
            writeJson(response, 200, await listRoles(stateStore, log));
            return true;
          case "preview-agent-dispatcher-prompt":
            writeJson(response, 200, buildAgentDispatcherPromptPreview(await readJsonBody(request)));
            return true;
          case "get-role":
            writeJson(response, 200, await getRole(stateStore, route.threadId, {
              log,
              getThreadDetail,
              attachToThread
            }));
            return true;
          case "get-config":
            writeJson(response, 200, await handlers.getConfig(route.threadId));
            return true;
          case "start-agent-dispatcher":
            writeJson(response, 201, await startAgentDispatcher(await readJsonBody(request)));
            return true;
          case "pause-dispatcher":
            writeJson(response, 200, await setAgentDispatcherStatus(route.threadId, "paused"));
            return true;
          case "resume-dispatcher":
            writeJson(response, 200, await setAgentDispatcherStatus(route.threadId, "active"));
            return true;
          case "continue-dispatcher":
            writeJson(response, 200, await continueDispatcherForRole(route.threadId));
            return true;
          case "pm-resolve":
            writeJson(response, 200, await startPmResolverForRole(route.threadId, await readJsonBody(request)));
            return true;
          case "start-dispatcher-hub":
            writeJson(response, 200, await startAgentDispatcherHubSession(route.threadId));
            return true;
          case "resume-worker":
            writeJson(response, 200, await resumeWorkerForRole(route.threadId, route.workerId, await readJsonBody(request)));
            return true;
          case "continue-worker":
            writeJson(response, 200, await continueDispatcherForRole(route.threadId, route.workerId));
            return true;
          case "update-worker-status":
            writeJson(response, 200, await updateWorkerStatusForRole(route.threadId, route.workerId, await readJsonBody(request)));
            return true;
          case "human-resolve-worker":
            writeJson(response, 200, await humanResolveWorkerForRole(route.threadId, route.workerId, await readJsonBody(request)));
            return true;
          case "reconcile":
            writeJson(response, 200, await reconcileActiveDispatcher());
            return true;
          case "patch-config":
            writeJson(response, 200, await handlers.patchConfig(route.threadId, await readJsonBody(request)));
            return true;
          case "delete-role":
            writeJson(response, 200, await deleteRole(route.threadId));
            return true;
          case "hub-relay": {
            const hubMessage = HubMessageSchema.parse(await readJsonBody(request));
            // GUI talk-to-thread fires `intent: "run"` at a long-running
            // bridge worker; the hub does not reply until the agent run
            // resolves, so the request socket would otherwise hang for the
            // full 30s ATTACH_RESPONSE_TIMEOUT and surface as
            // "Attach request timed out" even though the message reached
            // the worker. When the caller asks for fire-and-forget (via
            // `suppress_reply: true`), bypass the request/response path
            // and just enqueue.
            if (hubMessage.suppress_reply === true) {
              await sendHubFireAndForget(hubMessage);
              writeJson(response, 200, {
                ok: true,
                queued: true,
                trace_id: hubMessage.trace_id,
                thread_id: hubMessage.thread_id
              });
              return true;
            }
            const result = await sendHubRequestImpl(hubMessage);
            writeJson(response, 200, result);
            return true;
          }
        }
      } catch (error) {
        log.warn("Role handler request failed", {
          route: route.kind,
          error: getErrorMessage(error)
        });
        writeJson(response, getStatusCode(error), { error: getErrorMessage(error) });
        return true;
      }
    }
  };

  return handlers;

  async function startAgentDispatcher(body: unknown): Promise<{
    ok: true;
    dispatcher_id: string;
    dispatcher_thread_id: string;
  }> {
    const { threadId, roleType, role } = await activateRole(body, "agent-dispatcher");
    if (roleType !== "agent-dispatcher") {
      activeRoles.delete(threadId);
      await options.runner.deactivate(threadId).catch(() => undefined);
      throw createHttpError(500, `Expected agent-dispatcher role for thread_id=${threadId}`);
    }

    const dispatcherThreadId = extractDispatcherThreadId(role);
    if (!dispatcherThreadId) {
      activeRoles.delete(threadId);
      await options.runner.deactivate(threadId).catch(() => undefined);
      throw createHttpError(500, `Dispatcher thread was not recorded for thread_id=${threadId}`);
    }

    return {
      ok: true,
      dispatcher_id: threadId,
      dispatcher_thread_id: dispatcherThreadId
    };
  }

  async function startAgentDispatcherHubSession(threadId: string): Promise<StartAgentDispatcherHubSessionResponse> {
    const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
    if (context.roleType !== "agent-dispatcher") {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    if (!await hasRecoverableDispatchWorkForConfig(context.effectiveConfig, log)) {
      return {
        ok: true,
        status: "still_blocked",
        message: "still blocked: waiting on human/PM gate or unmet dependency"
      };
    }

    const activeRole = resolveActiveRoleBinding(threadId);
    if (activeRole && activeRole.roleType === "agent-dispatcher") {
      const result = await options.runner.relaunchAgentDispatcherHub(threadId);
      return { ok: true, dispatcher_thread_id: result.dispatcher_thread_id };
    }

    const result = await reactivatePersistedAgentDispatcher(threadId);
    return { ok: true, dispatcher_thread_id: result.dispatcher_thread_id };
  }

  async function setAgentDispatcherStatus(
    threadId: string,
    status: "active" | "paused"
  ): Promise<{ ok: true; status: "active" | "paused" }> {
    let activeRole = resolveActiveRoleBinding(threadId);
    if (!activeRole || activeRole.roleType !== "agent-dispatcher") {
      await reactivatePersistedAgentDispatcher(threadId);
      activeRole = resolveActiveRoleBinding(threadId);
      if (!activeRole || activeRole.roleType !== "agent-dispatcher") {
        throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
      }
    }

    const updated = status === "paused"
      ? await options.runner.pauseRole(threadId)
      : await options.runner.resumeRole(threadId);
    if (!updated) {
      activeRoles.delete(threadId);
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    return {
      ok: true,
      status
    };
  }

  async function reconcileActiveDispatcher() {
    syncActiveRolesFromRunner();

    const agentDispatcherConfig = await resolveReconciliableAgentDispatcherConfig(stateStore, activeRoles);
    if (!agentDispatcherConfig) {
      throw createHttpError(404, "No active agent dispatcher is running");
    }

    const lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(agentDispatcherConfig.dispatch_plan_path));
    return reconcile(lifecycleStore, {
      serviceId: ROLES_SERVICE_ID,
      sendRequest: sendHubRequestImpl
    } as unknown as A2AClient);
  }

  async function resumeWorkerForRole(
    threadId: string,
    workerId: string,
    body: unknown
  ): Promise<{ ok: true; result: Awaited<ReturnType<typeof executeResumeWorkerAction>> }> {
    const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
    if (context.roleType !== "agent-dispatcher") {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    const parsed = ResumeWorkerActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw createHttpError(400, "Invalid resume worker payload");
    }

    if (parsed.data.action === "force-complete" && !parsed.data.force) {
      throw createHttpError(400, "force-complete requires force=true");
    }

    return {
      ok: true,
      result: await executeResumeWorkerAction({
        planPath: context.effectiveConfig.dispatch_plan_path,
        workerId,
        action: parsed.data.action,
        force: parsed.data.force ?? false
      })
    };
  }

  async function hasRecoverableDispatchWorkForConfig(config: AgentDispatcherConfig, log: Logger): Promise<boolean> {
    try {
      const dispatchPlan = await loadDispatchPlanData(config.dispatch_plan_path, log);
      const lifecycleState = await loadDispatchLifecycleState(config.dispatch_plan_path, log);
      return hasRecoverableDispatchWork(dispatchPlan.rows, lifecycleState);
    } catch {
      return true;
    }
  }

  async function continueDispatcherForRole(threadId: string, workerId?: string): Promise<ContinueDispatcherResponse> {
    const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
    if (context.roleType !== "agent-dispatcher") {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    const dispatchPlanPath = context.effectiveConfig.dispatch_plan_path;
    const dispatchPlanData = await loadDispatchPlanData(dispatchPlanPath, log);
    let lifecycleState = await loadDispatchLifecycleState(dispatchPlanPath, log);
    let effectiveWorkerId = workerId
      ?? resolveServiceContinueWorker(dispatchPlanData.rows, lifecycleState);
    const shouldActivateAfterContinue = context.status !== ACTIVE_ROLE_STATUS;

    const initialManualInterventionWorkerId = resolveManualInterventionWorker(dispatchPlanData.rows, lifecycleState);
    if (initialManualInterventionWorkerId) {
      return buildManualInterventionResponse(initialManualInterventionWorkerId, lifecycleState);
    }

    const preValidationRunningWorkers = findBlockingRunningNonHumanWorkers(
      dispatchPlanData.rows,
      lifecycleState,
      effectiveWorkerId
    );
    if (preValidationRunningWorkers.length > 0) {
      return {
        ok: true,
        status: "still_blocked",
        message: `still blocked: running worker(s): ${preValidationRunningWorkers.join(", ")}`,
        ...(effectiveWorkerId ? { worker: effectiveWorkerId } : {}),
        running_workers: preValidationRunningWorkers
      };
    }

    // ─── Validation processing ────────────────────────────────────────────
    const validatorConfig = context.effectiveConfig.validator;
    if (validatorConfig?.enabled) {
      const validatorResult = await processValidationQueue(
        context.effectiveConfig,
        dispatchPlanData.rows as DispatchContinuationPlanRow[],
        lifecycleState,
        log,
        attachToThread,
        options.meridianApi,
        effectiveWorkerId
      );
      if (validatorResult) {
        return validatorResult;
      }
      // Reload lifecycle state after validation may have mutated it
      lifecycleState = await loadDispatchLifecycleState(dispatchPlanPath, log);
      effectiveWorkerId = workerId
        ?? resolveServiceContinueWorker(dispatchPlanData.rows, lifecycleState);
    }

    const manualInterventionWorkerId = resolveManualInterventionWorker(dispatchPlanData.rows, lifecycleState);
    if (manualInterventionWorkerId) {
      return buildManualInterventionResponse(manualInterventionWorkerId, lifecycleState);
    }

    const runningWorkers = findBlockingRunningNonHumanWorkers(
      dispatchPlanData.rows,
      lifecycleState,
      effectiveWorkerId
    );
    if (runningWorkers.length > 0) {
      return {
        ok: true,
        status: "still_blocked",
        message: `still blocked: running worker(s): ${runningWorkers.join(", ")}`,
        ...(effectiveWorkerId ? { worker: effectiveWorkerId } : {}),
        running_workers: runningWorkers
      };
    }

    // Don't relaunch a worker while a PM resolver is actively trying to
    // unblock it. Without this guard, the watchdog and the dispatcher AI
    // can both spawn fresh worker threads against the same row while the
    // PM is still mid-resolution — observed on agent-dispatcher-4db5c870
    // where a stale `running` PM (left over after a service restart) sat
    // in dispatch_threads.json while a brand-new C-01 worker was spawned
    // every continue tick. The startup PM probe demotes truly-dead PM
    // threads to `failed`, and the on-recovery reconciler promotes them
    // to `completed`, so a still-running PM here means a live (or at
    // least dispatcher-believed-live) resolution is in flight.
    if (effectiveWorkerId) {
      const activePmResolvers = findActivePmResolversForWorker(lifecycleState, effectiveWorkerId);
      if (activePmResolvers.length > 0) {
        const pmThreadIds = activePmResolvers.map((entry) => entry.thread_id);
        return {
          ok: true,
          status: "still_blocked",
          message: `still blocked: PM resolver(s) ${pmThreadIds.join(", ")} resolving worker ${effectiveWorkerId}`,
          worker: effectiveWorkerId,
          pm_resolver_thread_ids: pmThreadIds
        };
      }
    }

    let effectiveDispatcherThreadId = (() => {
      const activeRole = options.runner.getRole(threadId);
      if (activeRole?.roleType === "agent-dispatcher") {
        return extractDispatcherThreadId(activeRole) ?? lifecycleState.dispatcher.thread_id ?? undefined;
      }

      return lifecycleState.dispatcher.thread_id ?? undefined;
    })();
    effectiveDispatcherThreadId = await validateDispatcherThreadForContinue(
      dispatchPlanPath,
      threadId,
      effectiveDispatcherThreadId,
      attachToThread,
      log,
      async () => {
        await persistAgentDispatcherRoleStatus(stateStore, threadId, NEEDS_REACTIVATION_ROLE_STATUS);
      }
    );

    try {
      if (effectiveWorkerId) {
        const continued = await continueDispatchWorker(
          context.effectiveConfig,
          dispatchPlanData.rows,
          effectiveWorkerId,
          launchDispatchWorkerImpl
        );
        if (!continued.ok) {
          if (continued.localToolBootstrapFailure) {
            return {
              ok: true,
              status: "local_tool_bootstrap_failed",
              message: `local tool bootstrap failed: ${continued.error}`,
              worker: effectiveWorkerId,
              error: continued.error
            };
          }

          throw new Error(continued.error ?? "Failed to launch dispatch worker");
        }

        if (shouldActivateAfterContinue) {
          await setAgentDispatcherStatus(threadId, ACTIVE_ROLE_STATUS);
        }

        return {
          ok: true,
          status: "continued",
          message: `continued: ${effectiveWorkerId}`,
          ...(effectiveDispatcherThreadId ? { dispatcher_thread_id: effectiveDispatcherThreadId } : {}),
          worker: effectiveWorkerId,
          ...(continued.resumeResult ? { resume_result: continued.resumeResult } : {})
        };
      }

      // No eligible worker found and no running workers blocking. Check if
      // all non-human workers have reached a terminal state. If so, the plan
      // is complete — return a distinct status so the dispatcher AI can send
      // the final completion notify and stop, instead of relaunching the hub
      // session in an infinite loop.
      if (isDispatchPlanComplete(dispatchPlanData.rows, lifecycleState, validatorConfig)) {
        return {
          ok: true,
          status: "plan_complete",
          message: "plan complete: all non-human workers are terminal",
          ...(effectiveDispatcherThreadId ? { dispatcher_thread_id: effectiveDispatcherThreadId } : {})
        };
      }

      if (!hasRecoverableDispatchWork(dispatchPlanData.rows, lifecycleState)) {
        return {
          ok: true,
          status: "still_blocked",
          message: "still blocked: waiting on human/PM gate or unmet dependency",
          ...(effectiveDispatcherThreadId ? { dispatcher_thread_id: effectiveDispatcherThreadId } : {})
        };
      }

      const started = await startAgentDispatcherHubSession(threadId);
      if (shouldActivateAfterContinue) {
        await setAgentDispatcherStatus(threadId, ACTIVE_ROLE_STATUS);
      }

      return {
        ok: true,
        status: "continued",
        message: "continued: dispatcher",
        dispatcher_thread_id: started.dispatcher_thread_id
      };
    } catch (error) {
      const message = getErrorMessage(error);
      if (isLocalToolBootstrapFailure(message)) {
        return {
          ok: true,
          status: "local_tool_bootstrap_failed",
          message: `local tool bootstrap failed: ${message}`,
          ...(effectiveWorkerId ? { worker: effectiveWorkerId } : {}),
          error: message
        };
      }

      throw error;
    }
  }

  async function startPmResolverForRole(threadId: string, body: unknown): Promise<PmResolverResult> {
    const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
    if (context.roleType !== "agent-dispatcher") {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    const parsed = PmResolveRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw createHttpError(400, "Invalid PM resolver payload");
    }

    return startPmResolverImpl({
      dispatcherId: threadId,
      config: context.effectiveConfig,
      issue: {
        status: parsed.data.status,
        workerId: parsed.data.worker_id ?? parsed.data.worker,
        message: parsed.data.message,
        error: parsed.data.error,
        source: parsed.data.source ?? "dispatcher"
      }
    });
  }

  async function updateWorkerStatusForRole(
    threadId: string,
    workerId: string,
    body: unknown
  ): Promise<{ ok: true; result: Awaited<ReturnType<typeof executeUpdateWorkerStatusAction>> }> {
    const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
    if (context.roleType !== "agent-dispatcher") {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    const parsed = UpdateWorkerStatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw createHttpError(400, "Invalid worker status payload");
    }

    try {
      return {
        ok: true,
        result: await executeUpdateWorkerStatusAction({
          planPath: context.effectiveConfig.dispatch_plan_path,
          workerId,
          status: parsed.data.status,
          threadId: parsed.data.thread_id ?? null,
          modelId: parsed.data.model,
          reasoningEffort: parsed.data.reasoning_effort
        })
      };
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.startsWith("Unsupported status:")) {
        throw createHttpError(400, message);
      }
      if (message.includes("Worker not found")) {
        throw createHttpError(404, message);
      }

      throw error;
    }
  }

  async function humanResolveWorkerForRole(
    threadId: string,
    workerId: string,
    body: unknown
  ): Promise<{
    ok: true;
    worker_id: string;
    status: LifecycleStatus;
    human_resolution: { resolved_at: string; note: string | null };
  }> {
    const context = await loadRoleConfigContext(threadId, stateStore, resolveActiveRoleBinding);
    if (context.roleType !== "agent-dispatcher") {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    const parsed = HumanResolveWorkerRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw createHttpError(400, "Invalid human-resolve payload");
    }

    const planPath = context.effectiveConfig.dispatch_plan_path;
    const lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(planPath), {
      dispatchPlanPath: planPath
    });

    try {
      lifecycleStore.markHumanResolved(workerId, parsed.data.note ?? null);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("Worker not found")) {
        throw createHttpError(404, message);
      }
      throw error;
    }

    const after = lifecycleStore.load();
    const updated = after.workers[workerId];
    if (!updated?.human_resolution) {
      throw createHttpError(500, `Worker ${workerId} did not record human_resolution`);
    }

    return {
      ok: true,
      worker_id: workerId,
      status: updated.status,
      human_resolution: {
        resolved_at: updated.human_resolution.resolved_at,
        note: updated.human_resolution.note ?? null
      }
    };
  }

  async function getChannels(): Promise<{
    channels: ReplyChannel[];
    telegram_bot_numeric_ids: string[];
    telegram_allowed_user_ids: string[];
  }> {
    let hubChannels: ReplyChannel[] = [];

    try {
      hubChannels = ReplyChannelSchema.array().parse(await listReplyChannels());
    } catch (error) {
      log.warn("Reply channel lookup failed; merging env presets only", {
        error: getErrorMessage(error)
      });
    }

    const envPresets = buildEnvReplyChannelPresets();
    const merged = mergeReplyChannelLists(hubChannels, envPresets);

    return {
      channels: ReplyChannelSchema.array().parse(merged),
      telegram_bot_numeric_ids: listTelegramBotNumericIdsFromEnv(),
      telegram_allowed_user_ids: listAllowedUserIdsFromEnv()
    };
  }

  async function getHealth(): Promise<{
    ok: true;
    version: string;
    uptime: number;
    agents_count: number;
    roles_count: number;
  }> {
    const state = await loadState(stateStore);
    const count = state.roles.length;

    return {
      ok: true,
      version: PACKAGE_VERSION,
      uptime: Math.floor(process.uptime()),
      agents_count: count,
      roles_count: count
    };
  }

  async function reactivatePersistedAgentDispatcher(
    threadId: string
  ): Promise<{ dispatcher_thread_id: string }> {
    const state = await loadState(stateStore);
    const persistedRole = resolvePersistedAgentDispatcherRoleState(state, threadId);
    if (!persistedRole) {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
    }

    const role = options.registry.create("agent-dispatcher", threadId, persistedRole.config);
    activeRoles.set(threadId, {
      roleType: role.roleType,
      config: role.config
    });

    try {
      await options.runner.activate(role, { needsReactivation: true });
    } catch (error) {
      activeRoles.delete(threadId);
      throw error;
    }

    const dispatcherThreadId = extractDispatcherThreadId(role);
    if (!dispatcherThreadId) {
      throw createHttpError(
        500,
        `Dispatcher thread was not recorded after reactivation for thread_id=${threadId}`
      );
    }

    return { dispatcher_thread_id: dispatcherThreadId };
  }

  async function activateRole(
    body: unknown,
    forcedRoleType?: RoleType
  ): Promise<{ threadId: string; roleType: RoleType; role: ReturnType<RoleRegistry["create"]> }> {
    const { threadId, roleType, config } = forcedRoleType
      ? normalizeCreateBody(body, forcedRoleType)
      : normalizeCreateBody(body);
    if (resolveActiveRoleBinding(threadId)) {
      throw createHttpError(409, `Role already active for thread_id=${threadId}`);
    }

    const role = options.registry.create(roleType, threadId, config);
    const actualRoleType = role.roleType;
    activeRoles.set(threadId, {
      roleType: actualRoleType,
      config: role.config
    });

    try {
      await options.runner.activate(role);
    } catch (error) {
      activeRoles.delete(threadId);
      throw error;
    }

    return {
      threadId,
      roleType: actualRoleType,
      role
    };
  }

  async function deleteRole(threadId: string): Promise<{ ok: true }> {
    syncActiveRolesFromRunner();

    const state = await loadState(stateStore);
    const exists = state.roles.some((role) => role.threadId === threadId);
    if (!exists && !activeRoles.has(threadId)) {
      throw createHttpError(404, `Role not found for thread_id=${threadId}`);
    }

    await options.runner.deactivate(threadId);
    activeRoles.delete(threadId);

    const nextState: AppState = {
      roles: state.roles.filter((role) => role.threadId !== threadId),
      promptStore: state.promptStore
    };
    await stateStore.save(AppStateSchema.parse(nextState));

    return { ok: true };
  }
}

async function listRoles(stateStore: PersistableStateStore, log: Logger): Promise<
  Array<{ thread_id: string; role_type: string; status: string; task_count: number }>
> {
  const state = await loadState(stateStore);

  return Promise.all(state.roles.map(async (role) => {
    const status = await resolvePresentedRoleStatus(role, log);
    return {
      thread_id: role.threadId,
      role_type: role.roleType,
      status,
      task_count: await resolveRoleTaskCount(role, log)
    };
  }));
}

async function getRole(
  stateStore: PersistableStateStore,
  threadId: string,
  options: {
    log: Logger;
    getThreadDetail?: (threadId: string) => Promise<string>;
    attachToThread?: (threadId: string) => Promise<void>;
  }
): Promise<RoleDetailResponse> {
  const state = await loadState(stateStore);
  const role = state.roles.find((entry) => entry.threadId === threadId);
  if (!role) {
    throw createHttpError(404, `Role not found for thread_id=${threadId}`);
  }

  const config = parseDispatcherConfig(role.config);
  const explicitTasks = (config?.tasks ?? []).map((task) => ({
    task_id: task.task_id,
    status: task.status,
    depends_on: [...task.depends_on],
    trace_id: task.result_trace_id?.slice(0, 8),
    result_summary: task.result_summary,
    instruction: task.instruction
  }));

  const response: RoleDetailResponse = {
    thread_id: role.threadId,
    role_type: role.roleType,
    status: role.status,
    taskspec: config?.taskspec,
    system_prompt: config?.system_prompt,
    tasks: explicitTasks
  };

  if (role.roleType !== "agent-dispatcher") {
    return response;
  }

  const agentDispatcherConfig = parseAgentDispatcherConfig(role.config);
  if (!agentDispatcherConfig) {
    return response;
  }

  const dispatchPlan = await loadDispatchPlanData(agentDispatcherConfig.dispatch_plan_path, options.log);
  let lifecycleState = await loadDispatchLifecycleState(agentDispatcherConfig.dispatch_plan_path, options.log);
  let effectiveRoleStatus = deriveAgentDispatcherRoleStatus(
    role.status,
    lifecycleState,
    dispatchPlan.rows,
    agentDispatcherConfig.validator
  );
  if (effectiveRoleStatus !== role.status) {
    await persistAgentDispatcherRoleStatus(stateStore, role.threadId, effectiveRoleStatus);
  }
  const dispatchPlanRows = await enrichDispatchPlanRows(
    agentDispatcherConfig.dispatch_plan_path,
    dispatchPlan.rows,
    options.log
  );
  if (response.tasks.length === 0 && dispatchPlanRows.length > 0) {
    response.tasks = buildSyntheticDispatchTasks(dispatchPlanRows);
  }
  let dispatcherThreadId = resolveVisibleDispatcherThreadId(lifecycleState, effectiveRoleStatus);
  let dispatcherEntry = lifecycleState.workers[DISPATCHER_WORKER_ID] ?? null;
  let continueWorker = resolveServiceContinueWorker(dispatchPlanRows, lifecycleState);
  let currentWorker = resolveCurrentWorker(dispatchPlanRows, lifecycleState);
  let currentWorkerEntry = currentWorker ? lifecycleState.workers[currentWorker] ?? null : null;
  const sessionLogResult = await loadDispatcherSessionLog(
    dispatcherThreadId,
    options.getThreadDetail,
    options.attachToThread,
    {
      currentWorker,
      currentWorkerEntry,
      dispatcherEntry,
      dispatchPlanPath: agentDispatcherConfig.dispatch_plan_path,
      roleId: role.threadId,
      roleStatus: effectiveRoleStatus
    },
    options.log,
    async () => {
      effectiveRoleStatus = NEEDS_REACTIVATION_ROLE_STATUS;
      await persistAgentDispatcherRoleStatus(stateStore, role.threadId, NEEDS_REACTIVATION_ROLE_STATUS);
    }
  );
  let sessionLog = sessionLogResult.lines;
  if (sessionLogResult.dispatcherMissing) {
    lifecycleState = await loadDispatchLifecycleState(agentDispatcherConfig.dispatch_plan_path, options.log);
    effectiveRoleStatus = deriveAgentDispatcherRoleStatus(
      effectiveRoleStatus,
      lifecycleState,
      dispatchPlan.rows,
      agentDispatcherConfig.validator
    );
    dispatcherThreadId = resolveVisibleDispatcherThreadId(lifecycleState, effectiveRoleStatus);
    dispatcherEntry = lifecycleState.workers[DISPATCHER_WORKER_ID] ?? null;
    continueWorker = resolveServiceContinueWorker(dispatchPlanRows, lifecycleState);
    currentWorker = resolveCurrentWorker(dispatchPlanRows, lifecycleState);
    currentWorkerEntry = currentWorker ? lifecycleState.workers[currentWorker] ?? null : null;
    sessionLog = buildPersistedDispatcherSessionLog(
      {
        currentWorker,
        currentWorkerEntry,
        dispatcherEntry,
        dispatchPlanPath: agentDispatcherConfig.dispatch_plan_path,
        roleStatus: effectiveRoleStatus
      },
      dispatcherThreadId
    ) ?? buildMissingDispatcherSessionLog({
      currentWorker,
      currentWorkerEntry,
      dispatcherEntry,
      dispatchPlanPath: agentDispatcherConfig.dispatch_plan_path,
      roleStatus: effectiveRoleStatus
    });
  }

  const workerDetails = buildDispatchWorkerDetails(
    lifecycleState,
    dispatchPlanRows,
    dispatchPlan.modelLegend,
    {
      roleId: role.threadId,
      dispatcherThreadId,
      dispatcherAgentType: agentDispatcherConfig.agent_type
    }
  );
  const pmResolverDetails = await buildPmResolverDetails(lifecycleState, {
    roleId: role.threadId,
    getThreadDetail: options.getThreadDetail,
    log: options.log
  });
  const validatorCycleDetails = buildValidatorCycleDetails(lifecycleState, {
    roleId: role.threadId
  });

  return {
    ...response,
    status: effectiveRoleStatus,
    dispatch_plan_path: agentDispatcherConfig.dispatch_plan_path,
    command_file_path: agentDispatcherConfig.command_file_path,
    dispatch_repo_root: resolveConfiguredDispatchRepoRoot(agentDispatcherConfig),
    docs_root: resolveConfiguredDocsRoot(agentDispatcherConfig),
    dispatcher_thread_id: dispatcherThreadId,
    continue_worker: continueWorker,
    current_worker: currentWorker,
    last_log_line: extractLastLogLine(sessionLog),
    user_reply_channels: agentDispatcherConfig.user_reply_channels.map((replyChannel) => ({ ...replyChannel })),
    agent_type: agentDispatcherConfig.agent_type,
    ...(agentDispatcherConfig.model_id ? { model_id: agentDispatcherConfig.model_id } : {}),
    mode: agentDispatcherConfig.mode,
    kill_policy: agentDispatcherConfig.kill_policy,
    auto_approve: agentDispatcherConfig.auto_approve,
    session_log: sessionLog,
    dispatch_details: [
      ...workerDetails,
      ...validatorCycleDetails,
      ...pmResolverDetails
    ],
    dispatch_plan: {
      rows: dispatchPlanRows
    }
  };
}

async function resolveRoleTaskCount(role: RoleState, log: Logger): Promise<number> {
  const config = parseDispatcherConfig(role.config);
  const explicitTaskCount = config?.tasks.length ?? 0;
  if (explicitTaskCount > 0) {
    return explicitTaskCount;
  }

  if (role.roleType === "agent-dispatcher") {
    const agentDispatcherConfig = parseAgentDispatcherConfig(role.config);
    if (!agentDispatcherConfig) {
      return explicitTaskCount;
    }

    const dispatchPlan = await loadDispatchPlanData(agentDispatcherConfig.dispatch_plan_path, log);
    return dispatchPlan.rows.length;
  }

  if (role.roleType === "scheduler") {
    const schedulerConfig = parseSchedulerConfig(role.config);
    if (!schedulerConfig) {
      return explicitTaskCount;
    }

    const dispatchPlan = await loadDispatchPlanData(schedulerConfig.dispatch_plan_path, log);
    return dispatchPlan.rows.length;
  }

  return explicitTaskCount;
}

function buildSyntheticDispatchTasks(rows: DispatchPlanRow[]): RoleDetailResponse["tasks"] {
  return rows.map((row) => ({
    task_id: row.worker,
    status: toSyntheticTaskStatus(row.lifecycle_status ?? row.status),
    depends_on: normalizeSyntheticTaskDependencies(row.depends_on),
    result_summary: normalizeSyntheticTaskSummary(row.notes),
    instruction: buildSyntheticTaskInstruction(row)
  }));
}

function toSyntheticTaskStatus(status: string | null | undefined): string {
  const normalized = status?.trim();
  switch (normalized) {
    case "completed":
    case "✅":
      return "done";
    case "running":
    case "🔄":
      return "running";
    case "failed":
    case "❌":
      return "failed";
    case "blocked":
    case "⛔ BLOCKED":
      return "blocked";
    case "abandoned":
    case "⚠️ ABANDONED":
      return "failed";
    case "skipped":
    case "⛔ SKIPPED":
      return "done";
    case "pending":
    case "⬜":
    default:
      return "pending";
  }
}

function normalizeSyntheticTaskDependencies(dependsOn: string | null | undefined): string[] {
  if (!dependsOn) {
    return [];
  }

  const normalized = dependsOn.trim();
  if (!normalized || normalized === "—") {
    return [];
  }

  return normalized
    .split(/,|\s+\+\s+/)
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entry.length > 0 && entry !== "—" && entries.indexOf(entry) === index);
}

function normalizeSyntheticTaskSummary(notes: string | null | undefined): string | undefined {
  const normalized = notes?.trim();
  return normalized ? normalized : undefined;
}

function buildSyntheticTaskInstruction(row: DispatchPlanRow): string {
  const summary = [row.task, row.notes].map((part) => part?.trim()).filter(Boolean).join(" — ");
  return summary || row.worker;
}

async function loadState(stateStore: PersistableStateStore): Promise<AppState> {
  return AppStateSchema.parse((await stateStore.load()) ?? { roles: [], promptStore: {} });
}

function normalizeCreateBody(body: unknown): {
  threadId: string;
  roleType: RoleType;
  config: DispatcherConfig | AgentDispatcherConfig;
}
function normalizeCreateBody(body: unknown, forcedRoleType: RoleType): {
  threadId: string;
  roleType: RoleType;
  config: DispatcherConfig | AgentDispatcherConfig;
}
function normalizeCreateBody(body: unknown, forcedRoleType?: RoleType): {
  threadId: string;
  roleType: RoleType;
  config: DispatcherConfig | AgentDispatcherConfig;
} {
  const parsed = CreateRoleBodySchema.safeParse(body);
  if (!parsed.success) {
    throw createHttpError(400, "Invalid body for role creation");
  }

  const requestedRoleType = parsed.data.role_type ?? parsed.data.roleType;
  if (forcedRoleType && requestedRoleType && requestedRoleType !== forcedRoleType) {
    throw createHttpError(400, `role_type must be ${forcedRoleType}`);
  }

  const roleType = forcedRoleType ?? requestedRoleType ?? "agent-dispatcher";
  if (roleType !== "dispatcher" && roleType !== "agent-dispatcher") {
    throw createHttpError(400, `Unsupported role_type=${roleType}`);
  }
  const threadId = parsed.data.thread_id ?? parsed.data.threadId ?? `${roleType}-${randomUUID().slice(0, 8)}`;

  const nestedConfig = typeof parsed.data.config === "object" && parsed.data.config !== null
    ? parsed.data.config
    : {};

  const rawConfig = {
    ...(nestedConfig as Record<string, unknown>),
    tasks: parsed.data.tasks ?? (nestedConfig as { tasks?: unknown }).tasks,
    taskspec: parsed.data.taskspec ?? (nestedConfig as { taskspec?: unknown }).taskspec,
    system_prompt: parsed.data.system_prompt ?? (nestedConfig as { system_prompt?: unknown }).system_prompt,
    dispatch_plan_path:
      parsed.data.dispatch_plan_path ?? (nestedConfig as { dispatch_plan_path?: unknown }).dispatch_plan_path,
    command_file_path:
      parsed.data.command_file_path ?? (nestedConfig as { command_file_path?: unknown }).command_file_path,
    dispatch_repo_root:
      parsed.data.dispatch_repo_root ?? (nestedConfig as { dispatch_repo_root?: unknown }).dispatch_repo_root,
    docs_root:
      parsed.data.docs_root ?? (nestedConfig as { docs_root?: unknown }).docs_root,
    user_reply_channel:
      parsed.data.user_reply_channel ?? (nestedConfig as { user_reply_channel?: unknown }).user_reply_channel,
    user_reply_channels:
      parsed.data.user_reply_channels ?? (nestedConfig as { user_reply_channels?: unknown }).user_reply_channels,
    agent_type: parsed.data.agent_type ?? (nestedConfig as { agent_type?: unknown }).agent_type,
    model_id: parsed.data.model_id ?? (nestedConfig as { model_id?: unknown }).model_id,
    mode: parsed.data.mode ?? (nestedConfig as { mode?: unknown }).mode,
    kill_policy: parsed.data.kill_policy ?? (nestedConfig as { kill_policy?: unknown }).kill_policy,
    auto_approve: parsed.data.auto_approve ?? (nestedConfig as { auto_approve?: unknown }).auto_approve,
    validator: parsed.data.validator ?? (nestedConfig as { validator?: unknown }).validator,
    pm_resolver: parsed.data.pm_resolver ?? (nestedConfig as { pm_resolver?: unknown }).pm_resolver,
    use_agent_dispatcher:
      parsed.data.use_agent_dispatcher
      ?? (nestedConfig as { use_agent_dispatcher?: unknown }).use_agent_dispatcher
  };

  const config = AgentDispatcherConfigSchema.safeParse(rawConfig);
  if (!config.success) {
    throw createHttpError(400, "Invalid dispatcher config");
  }

  const normalizedConfig = materializeAgentDispatcherConfigSystemPrompt(config.data as AgentDispatcherConfig, threadId);

  return {
    threadId,
    roleType,
    config: normalizedConfig
  };
}

function parseDispatcherConfig(config: unknown): DispatcherConfig | null {
  const parsed = DispatcherConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

function parseAgentDispatcherConfig(config: unknown): AgentDispatcherConfig | null {
  const parsed = AgentDispatcherConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

function parseSchedulerConfig(config: unknown): SchedulerConfig | null {
  const parsed = SchedulerConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

function resolveActiveAgentDispatcherConfig(
  activeRoles: ReadonlyMap<string, PromptStoreRoleBinding>
): AgentDispatcherConfig | null {
  for (const role of activeRoles.values()) {
    if (role.roleType !== "agent-dispatcher") {
      continue;
    }

    const config = parseAgentDispatcherConfig(role.config);
    if (config) {
      return config;
    }
  }

  return null;
}

async function resolveReconciliableAgentDispatcherConfig(
  stateStore: PersistableStateStore,
  activeRoles: ReadonlyMap<string, PromptStoreRoleBinding>
): Promise<AgentDispatcherConfig | null> {
  const activeConfig = resolveActiveAgentDispatcherConfig(activeRoles);
  if (activeConfig) {
    return activeConfig;
  }

  const state = await loadState(stateStore);
  return resolvePersistedAgentDispatcherConfig(state);
}

function resolvePersistedAgentDispatcherConfig(state: AppState): AgentDispatcherConfig | null {
  for (const role of state.roles) {
    if (role.roleType !== "agent-dispatcher" || !isReconcilableAgentDispatcherRoleStatus(role.status)) {
      continue;
    }

    const config = parseAgentDispatcherConfig(role.config);
    if (config) {
      return config;
    }
  }

  return null;
}

function resolvePersistedAgentDispatcherRoleState(
  state: AppState,
  threadId: string
): RoleState | null {
  for (const role of state.roles) {
    if (
      role.threadId === threadId &&
      role.roleType === "agent-dispatcher" &&
      isReconcilableAgentDispatcherRoleStatus(role.status)
    ) {
      return role;
    }
  }

  return null;
}

async function resolvePresentedRoleStatus(role: RoleState, log: Logger): Promise<string> {
  if (role.roleType === "scheduler") {
    return resolvePresentedSchedulerRoleStatus(role, log);
  }

  if (role.roleType !== "agent-dispatcher") {
    return role.status;
  }

  const config = parseAgentDispatcherConfig(role.config);
  if (!config) {
    return role.status;
  }

  const lifecycleState = await loadDispatchLifecycleState(config.dispatch_plan_path, log);
  const dispatchPlan = await loadDispatchPlanData(config.dispatch_plan_path, log);
  return deriveAgentDispatcherRoleStatus(role.status, lifecycleState, dispatchPlan.rows, config.validator);
}

function resolvePresentedSchedulerRoleStatus(role: RoleState, log: Logger): string {
  const parsed = SchedulerConfigSchema.safeParse(role.config);
  if (!parsed.success) {
    return role.status;
  }

  try {
    return new SchedulerStateStore(parsed.data.dispatch_plan_path).load().status;
  } catch (error) {
    log.warn("Failed to resolve scheduler run state for role list", {
      threadId: role.threadId,
      error: getErrorMessage(error)
    });
    return role.status;
  }
}

function deriveAgentDispatcherRoleStatus(
  roleStatus: string,
  lifecycleState: DispatchThreadStateV2,
  rows: DispatchPlanRow[] = [],
  validatorConfig?: ValidatorConfig
): string {
  const terminalStatus = resolveDispatchPlanTerminalRoleStatus(rows, lifecycleState, validatorConfig);
  if (terminalStatus) {
    return terminalStatus;
  }

  const hasRecoverableWork = hasRecoverableDispatchWork(rows, lifecycleState);

  if (roleStatus === NEEDS_REACTIVATION_ROLE_STATUS && !hasRecoverableWork) {
    return ACTIVE_ROLE_STATUS;
  }

  if (roleStatus === NEEDS_REACTIVATION_ROLE_STATUS) {
    return roleStatus;
  }

  if (REACTIVATION_REQUIRED_DISPATCHER_STATUSES.has(lifecycleState.dispatcher.status) && hasRecoverableWork) {
    return NEEDS_REACTIVATION_ROLE_STATUS;
  }

  if (isTerminalAgentDispatcherRoleStatus(roleStatus)) {
    return ACTIVE_ROLE_STATUS;
  }

  return roleStatus;
}

function resolveDispatchPlanTerminalRoleStatus(
  rows: DispatchPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  validatorConfig?: ValidatorConfig
): "completed" | "failed" | null {
  const nonHumanRows = rows.filter((row) => !isHumanDispatchRow(row) && row.worker.trim().length > 0);
  if (nonHumanRows.length === 0) {
    return null;
  }

  const statuses = nonHumanRows.map((row) => resolveDispatchRowTerminalStatus(row, lifecycleState, validatorConfig));
  if (statuses.some((status) => status === null)) {
    return null;
  }

  return statuses.some((status) => status === "failed") ? "failed" : "completed";
}

function resolveDispatchRowTerminalStatus(
  row: DispatchPlanRow,
  lifecycleState: DispatchThreadStateV2,
  validatorConfig?: ValidatorConfig
): "completed" | "failed" | null {
  const planStatus = row.status.trim();
  const lifecycleStatus = lifecycleState.workers[row.worker]?.status;

  if (lifecycleStatus === "failed" || lifecycleStatus === "blocked" || lifecycleStatus === "abandoned") {
    return "failed";
  }
  if (planStatus === "❌" || planStatus === "⛔ BLOCKED" || planStatus === "⚠️ ABANDONED") {
    return "failed";
  }
  if (planStatus === "⛔ SKIPPED" || lifecycleStatus === "skipped") {
    return "completed";
  }
  if (
    (planStatus === "✅" || lifecycleStatus === "completed")
    && isCompletedWorkerValidationSatisfied(row, lifecycleState, validatorConfig)
  ) {
    return "completed";
  }

  return null;
}

function isCompletedWorkerValidationSatisfied(
  row: DispatchPlanRow,
  lifecycleState: DispatchThreadStateV2,
  validatorConfig?: ValidatorConfig
): boolean {
  if (!validatorConfig?.enabled || !isValidationEnabledForWorker(validatorConfig, row)) {
    return true;
  }

  const worker = lifecycleState.workers[row.worker];
  if (!worker || worker.status !== "completed") {
    return false;
  }

  const score = worker.validation?.last_score;
  if (typeof score !== "number") {
    return false;
  }

  return isValidatorResultPassing(validatorConfig, row, score);
}

async function persistAgentDispatcherRoleStatus(
  stateStore: PersistableStateStore,
  threadId: string,
  status: string
): Promise<void> {
  const state = await loadState(stateStore);
  const role = state.roles.find((entry) => entry.threadId === threadId);
  if (!role || role.roleType !== "agent-dispatcher" || role.status === status) {
    return;
  }

  role.status = status;
  await stateStore.save(state);
}

function extractDispatcherThreadId(role: ReturnType<RoleRegistry["create"]>): string | null {
  if (!("getDispatcherThreadId" in role)) {
    return null;
  }

  const dispatcherThreadId = (role as DispatcherThreadAwareRole).getDispatcherThreadId();
  return typeof dispatcherThreadId === "string" && dispatcherThreadId.trim().length > 0
    ? dispatcherThreadId
    : null;
}

interface RoleConfigContext {
  roleType: "agent-dispatcher";
  state: AppState;
  roleState: RoleState | null;
  activeConfig: AgentDispatcherConfig | null;
  persistedConfig: AgentDispatcherConfig | null;
  effectiveConfig: AgentDispatcherConfig;
  status: string;
}

async function loadRoleConfigContext(
  threadId: string,
  stateStore: PersistableStateStore,
  resolveActiveRole: (threadId: string) => PromptStoreRoleBinding | null
): Promise<RoleConfigContext> {
  const state = await loadState(stateStore);
  const roleState = state.roles.find((role) => role.threadId === threadId) ?? null;
  const activeRole = resolveActiveRole(threadId);

  if (!activeRole && !roleState) {
    throw createHttpError(404, `Role not found for thread_id=${threadId}`);
  }

  const activeConfig = parseMutableAgentDispatcherConfig(activeRole?.config);
  const persistedConfig = roleState ? parseMutableAgentDispatcherConfig(roleState.config) : null;
  const effectiveConfig = activeConfig ?? persistedConfig;

  if (!effectiveConfig) {
    throw createHttpError(500, `Invalid agent dispatcher config for thread_id=${threadId}`);
  }

  return {
    roleType: "agent-dispatcher",
    state,
    roleState,
    activeConfig,
    persistedConfig,
    effectiveConfig,
    status: roleState?.status ?? "active"
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    throw createHttpError(400, "Request body must be valid JSON");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw createHttpError(400, "Request body must be valid JSON");
  }
}

function matchRoleRoute(request: IncomingMessage): RoleRouteMatch | null {
  const method = request.method?.toUpperCase();
  const url = request.url;
  if (!method || !url) {
    return null;
  }

  const pathname = new URL(url, "http://127.0.0.1").pathname;
  const parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

  if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "health") {
    return { kind: "health" };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "roles") {
    return { kind: "list-roles" };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "channels") {
    return { kind: "list-channels" };
  }

  if (
    method === "POST"
    && parts.length === 3
    && parts[0] === "api"
    && parts[1] === "agent-dispatcher"
    && parts[2] === "prompt-preview"
  ) {
    return { kind: "preview-agent-dispatcher-prompt" };
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "role") {
    return { kind: "get-role", threadId: parts[2] };
  }

  if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "role" && parts[3] === "config") {
    return { kind: "get-config", threadId: parts[2] };
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "api" && parts[1] === "agent-dispatcher" && parts[2] === "start") {
    return { kind: "start-agent-dispatcher" };
  }

  if (
    method === "POST"
    && parts.length === 6
    && parts[0] === "api"
    && parts[1] === "roles"
    && parts[3] === "worker"
    && parts[5] === "resume"
  ) {
    return { kind: "resume-worker", threadId: parts[2], workerId: parts[4] };
  }

  if (
    method === "POST"
    && parts.length === 6
    && parts[0] === "api"
    && parts[1] === "roles"
    && parts[3] === "worker"
    && parts[5] === "continue"
  ) {
    return { kind: "continue-worker", threadId: parts[2], workerId: parts[4] };
  }

  if (
    method === "PATCH"
    && parts.length === 6
    && parts[0] === "api"
    && parts[1] === "roles"
    && parts[3] === "worker"
    && parts[5] === "status"
  ) {
    return { kind: "update-worker-status", threadId: parts[2], workerId: parts[4] };
  }

  if (
    method === "POST"
    && parts.length === 6
    && parts[0] === "api"
    && parts[1] === "roles"
    && parts[3] === "worker"
    && parts[5] === "human-resolve"
  ) {
    return { kind: "human-resolve-worker", threadId: parts[2], workerId: parts[4] };
  }

  if (
    method === "POST"
    && parts.length === 4
    && parts[0] === "api"
    && parts[1] === "agent-dispatcher"
    && parts[3] === "pause"
  ) {
    return { kind: "pause-dispatcher", threadId: parts[2] };
  }

  if (
    method === "POST"
    && parts.length === 4
    && parts[0] === "api"
    && parts[1] === "agent-dispatcher"
    && parts[3] === "resume"
  ) {
    return { kind: "resume-dispatcher", threadId: parts[2] };
  }

  if (
    method === "POST"
    && parts.length === 4
    && parts[0] === "api"
    && parts[1] === "agent-dispatcher"
    && parts[3] === "continue"
  ) {
    return { kind: "continue-dispatcher", threadId: parts[2] };
  }

  if (
    method === "POST"
    && parts.length === 4
    && parts[0] === "api"
    && parts[1] === "agent-dispatcher"
    && parts[3] === "pm-resolve"
  ) {
    return { kind: "pm-resolve", threadId: parts[2] };
  }

  if (
    method === "POST"
    && parts.length === 4
    && parts[0] === "api"
    && parts[1] === "agent-dispatcher"
    && parts[3] === "start-hub"
  ) {
    return { kind: "start-dispatcher-hub", threadId: parts[2] };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "reconcile") {
    return { kind: "reconcile" };
  }

  if (method === "PATCH" && parts.length === 4 && parts[0] === "api" && parts[1] === "role" && parts[3] === "config") {
    return { kind: "patch-config", threadId: parts[2] };
  }

  if (method === "DELETE" && parts.length === 3 && parts[0] === "api" && parts[1] === "role") {
    return { kind: "delete-role", threadId: parts[2] };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "hub-relay") {
    return { kind: "hub-relay" };
  }

  return null;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (!response.headersSent) {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
  }

  response.end(`${JSON.stringify(body)}\n`);
}

function createHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(fsSync.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" && packageJson.version.trim().length > 0
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildAgentDispatcherPromptPreview(body: unknown): { system_prompt: string } {
  const parsed = AgentDispatcherPromptPreviewBodySchema.safeParse(body);
  if (!parsed.success) {
    throw createHttpError(400, "Invalid agent dispatcher prompt preview payload");
  }

  const userReplyChannels = parsed.data.user_reply_channels
    ?? (parsed.data.user_reply_channel ? [parsed.data.user_reply_channel] : [{
      channel: "web" as const,
      chat_id: "web:ops"
    }]);
  const previewPmResolver = (() => {
    const pmResolver = PmResolverConfigSchema.parse(parsed.data.pm_resolver ?? {});
    return {
      ...pmResolver,
      user_reply_channels: pmResolver.user_reply_channels ?? userReplyChannels
    };
  })();

  return {
    system_prompt: buildSystemPrompt({
      dispatch_plan_path: parsed.data.dispatch_plan_path ?? "/abs/path/to/dispatch_plan.md",
      command_file_path: parsed.data.command_file_path ?? "/abs/path/to/agent_dispatch_command.md",
      dispatcher_role_id: AGENT_DISPATCHER_ROLE_ID_PLACEHOLDER,
      dispatch_repo_root: resolveConfiguredDispatchRepoRoot({
        dispatch_plan_path: parsed.data.dispatch_plan_path ?? "/abs/path/to/dispatch_plan.md",
        command_file_path: parsed.data.command_file_path ?? "/abs/path/to/agent_dispatch_command.md",
        dispatch_repo_root: parsed.data.dispatch_repo_root
      }),
      docs_root: resolveConfiguredDocsRoot({
        dispatch_plan_path: parsed.data.dispatch_plan_path ?? "/abs/path/to/dispatch_plan.md",
        command_file_path: parsed.data.command_file_path ?? "/abs/path/to/agent_dispatch_command.md",
        dispatch_repo_root: parsed.data.dispatch_repo_root,
        docs_root: parsed.data.docs_root
      }),
      user_reply_channels: JSON.stringify(userReplyChannels),
      default_agent_type: parsed.data.agent_type ?? "claude",
      default_mode: parsed.data.mode ?? "bridge",
      kill_policy: parsed.data.kill_policy ?? "always",
      auto_approve: parsed.data.auto_approve ?? false,
      pm_resolver_config_json: JSON.stringify(previewPmResolver)
    })
  };
}


function materializeAgentDispatcherConfigSystemPrompt(
  config: AgentDispatcherConfig,
  threadId: string
): AgentDispatcherConfig {
  const systemPrompt = config.system_prompt?.trim();
  if (!systemPrompt) {
    return config;
  }

  return {
    ...config,
    system_prompt: materializeDispatcherSystemPrompt(systemPrompt, threadId)
  };
}

function getStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }

  return 500;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

function buildManualInterventionResponse(
  workerId: string,
  lifecycleState: DispatchThreadStateV2
): ContinueDispatcherResponse {
  const manualInterventionWorker = lifecycleState.workers[workerId];
  const hubResult = manualInterventionWorker?.hub_result ?? null;
  const markerReason = resolveMarkerInterventionReason(hubResult, workerId);
  const interventionSummary = summarizeManualInterventionResult(hubResult, markerReason);
  const interventionReason = markerReason
    ?? (hubResult && hubResultContainsHitLimit(hubResult)
      ? "reported hit limit"
      : hubResult
        ? "reported a blocking failure"
        : "is blocked");

  return {
    ok: true,
    status: "manual_intervention_required",
    message: `manual intervention required: ${workerId} ${interventionReason}`,
    worker: workerId,
    ...(interventionSummary ? { error: interventionSummary } : {})
  };
}

// MeridianStatusMarker (Phase A) is the authoritative signal — when the
// worker emitted one, derive the human-readable reason from its `outcome`
// rather than re-running narrative-regex heuristics over the same content.
// Returns null when no marker is present so callers fall back to the
// existing heuristic strings.
function resolveMarkerInterventionReason(
  hubResult: HubResult | null,
  workerId: string
): string | null {
  if (!hubResult) {
    return null;
  }

  const markerSource = hubResult.content || hubResult.summary_text || hubResult.details_text || "";
  const marker = parseMeridianStatusMarker(markerSource);
  if (!marker || marker.role !== "worker" || marker.worker_id !== workerId) {
    return null;
  }

  switch (marker.outcome) {
    case "hit_limit":
      return "reported hit limit";
    case "blocked":
      return "reported a blocking outcome";
    case "needs_pm":
      return "requested PM resolution";
    case "failed":
      return "reported a failed outcome";
    case "complete":
      // Marker-claimed success that still landed here means the lifecycle
      // store deferred the success (e.g. expected_outputs missing). Surface
      // that explicitly instead of pretending the worker is blocked.
      return "claimed completion without expected outputs";
    default:
      return null;
  }
}

function summarizeManualInterventionResult(
  hubResult: HubResult | null,
  markerReason: string | null
): string | null {
  if (
    !hubResult
    || (
      !markerReason
      && !hubResultContainsHitLimit(hubResult)
      && !hubResultContainsBlockSignal(hubResult)
      && !hubResultContainsFailureSignal(hubResult)
    )
  ) {
    return null;
  }

  const rawSummary = hubResult.summary_text?.trim()
    || hubResult.content?.trim()
    || hubResult.details_text?.trim()
    || "";
  if (rawSummary.length === 0) {
    if (markerReason) {
      return `worker ${markerReason}`;
    }
    return hubResultContainsHitLimit(hubResult)
      ? "worker reported hit limit"
      : "worker reported a blocking failure";
  }

  const normalized = rawSummary.replace(/\s+/g, " ");
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 200)}…`;
}

function findRunningNonHumanWorkers(rows: DispatchPlanRow[]): string[] {
  return rows
    .filter((row) => row.status === "🔄" && !isHumanDispatchRow(row))
    .map((row) => row.worker)
    .filter((worker) => worker.trim().length > 0);
}

function findBlockingRunningNonHumanWorkers(
  rows: DispatchPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  effectiveWorkerId: string | null | undefined
): string[] {
  return findRunningNonHumanWorkers(rows)
    .filter((candidate) => candidate !== effectiveWorkerId)
    .filter((candidate) => !isLifecycleTerminal(lifecycleState, candidate));
}

function isLifecycleTerminal(lifecycleState: DispatchThreadStateV2, workerId: string): boolean {
  const worker = lifecycleState.workers[workerId];
  if (!worker) {
    return false;
  }

  return worker.status === "completed" || worker.status === "skipped" || worker.status === "failed" || worker.status === "blocked";
}

/**
 * Returns true when every non-human worker row in the dispatch plan has reached
 * a terminal status — either in the plan markdown itself or (as a fallback) in
 * the lifecycle store. This detects the "all done" condition so the dispatcher
 * can stop instead of infinitely relaunching its hub session.
 */
function isDispatchPlanComplete(
  rows: DispatchPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  validatorConfig?: ValidatorConfig
): boolean {
  const nonHumanRows = rows.filter((row) => !isHumanDispatchRow(row) && row.worker.trim().length > 0);
  if (nonHumanRows.length === 0) {
    return false;
  }

  return nonHumanRows.every((row) => {
    const planStatus = row.status.trim();
    if (planStatus === "✅" || planStatus === "⛔ SKIPPED") {
      return planStatus === "⛔ SKIPPED"
        || isCompletedWorkerValidationSatisfied(row, lifecycleState, validatorConfig);
    }

    // Plan markdown may be stale. Cross-reference lifecycle store.
    if (planStatus === "❌" || planStatus === "⚠️ ABANDONED") {
      return isLifecycleTerminal(lifecycleState, row.worker);
    }

    // A 🔄 row whose lifecycle is terminal means the plan sync lagged behind
    if (planStatus === "🔄") {
      return isLifecycleTerminal(lifecycleState, row.worker);
    }

    return false;
  });
}

// ─── Validation queue processing ──────────────────────────────────────────────

async function processValidationQueue(
  config: AgentDispatcherConfig,
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  log: Logger,
  attachToThread?: (threadId: string) => Promise<void>,
  meridianApi?: MeridianApiClient,
  preferredWorkerId?: string | null
): Promise<ContinueDispatcherResponse | null> {
  const validatorConfig = config.validator;
  if (!validatorConfig?.enabled) {
    return null;
  }

  const dispatchPlanPath = config.dispatch_plan_path;
  const lifecycleStore = new LifecycleStore(
    path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json"),
    { dispatchPlanPath, log }
  );

  // Phase 1: Intercept completed workers that still require validation.
  for (const row of rows) {
    const workerId = row.worker.trim();
    if (!workerId) continue;

    const worker = lifecycleState.workers[workerId];
    const disposition = resolveCompletedWorkerValidationDisposition(validatorConfig, row, worker);
    if (disposition === "awaiting_validation") {
      interceptCompletionForValidation(lifecycleStore, validatorConfig, workerId, row);
    } else if (disposition === "failed") {
      lifecycleStore.transitionToValidationFailed(workerId, "max_cycles_exhausted_after_rework");
      return {
        ok: true,
        status: "manual_intervention_required",
        message: `manual intervention required: ${workerId} ${describeValidationMaxCycleFailure(validatorConfig)} after max cycles`,
        worker: workerId,
        ...(worker?.validation?.last_feedback ? { error: worker.validation.last_feedback } : {})
      };
    }
  }

  const preferredFixWorkerId = preferredWorkerId?.trim();
  if (preferredFixWorkerId) {
    const preferredWorker = lifecycleStore.load().workers[preferredFixWorkerId];
    if (preferredWorker?.status === "fix_requested" && preferredWorker.thread_id?.trim()) {
      const deps = buildValidatorDeps(config, lifecycleStore, validatorConfig, dispatchPlanPath, log, meridianApi);
      const response = await buildValidatorFeedbackDeliveryResponse(deps, preferredFixWorkerId, log);
      if (response) {
        return response;
      }
      // null = thread was cleared for relaunch; fall through to launch path.
    }
  }

  // Phase 2: Process awaiting_validation workers
  for (const row of rows) {
    const workerId = row.worker.trim();
    if (!workerId) continue;

    const worker = lifecycleStore.load().workers[workerId];
    if (worker?.status !== "awaiting_validation") continue;

    const validatorThreadId = worker.validation?.validator_thread_id?.trim();
    if (validatorThreadId) {
      const validatorStillActive = await isRecordedValidatorThreadActive(
        workerId,
        validatorThreadId,
        attachToThread,
        log
      );
      if (validatorStillActive) {
        return {
          ok: true,
          status: "validation_in_progress",
          message: `validation already running for ${workerId}`,
          worker: workerId,
          validation_outcome: "running"
        };
      }

      lifecycleStore.clearValidatorStart(workerId, validatorThreadId);
    }

    // Skip workers that are in validator spawn-failure backoff. The watchdog
    // and queue both honor this so a broken spawn transport (e.g. codex cwd
    // not in trusted projects, hub FD pressure) cannot drive a tight retry
    // loop. The worker remains in awaiting_validation; the next tick after
    // the backoff window expires will attempt again.
    const latestWorker = lifecycleStore.load().workers[workerId];
    if (isValidatorSpawnBackoffActive(latestWorker?.validation)) {
      log.info("Validator spawn backoff active; skipping respawn for now", {
        event: "validator_spawn_backoff_active",
        worker_id: workerId,
        spawn_failure_count: latestWorker?.validation?.spawn_failure_count ?? 0,
        last_spawn_failure_at: latestWorker?.validation?.last_spawn_failure_at ?? null
      });
      return {
        ok: true,
        status: "validation_in_progress",
        message: `validation backoff active for ${workerId} after repeated spawn failures`,
        worker: workerId,
        validation_outcome: "backoff"
      };
    }

    const deps = buildValidatorDeps(config, lifecycleStore, validatorConfig, dispatchPlanPath, log, meridianApi);

    void runValidationCycleWithFeedbackLoop(deps, workerId, row, log)
      .catch((error) => {
        log.warn("Validator cycle failed unexpectedly", {
          event: "validator_cycle_unhandled_error",
          worker_id: workerId,
          error: error instanceof Error ? error.message : String(error)
        });
      });

    return {
      ok: true,
      status: "validation_in_progress",
      message: `validation started for ${workerId}`,
      worker: workerId,
      validation_outcome: "started"
    };
  }

  // Phase 3: Deliver feedback to fix_requested workers
  for (const row of rows) {
    const workerId = row.worker.trim();
    if (!workerId) continue;

    const worker = lifecycleStore.load().workers[workerId];
    if (worker?.status !== "fix_requested") continue;

    // Worker thread was cleared (e.g. by a prior validator_feedback_undeliverable
    // relaunch trigger). Don't try to deliver feedback to a dead thread —
    // skip this row so processValidationQueue returns null and the standard
    // launch path picks up the 🔁 row (service-continuation marks fix_requested
    // rows eligible). continueWorker then falls through to launchWorker because
    // the thread id is empty, and validation feedback surfaces to the new
    // thread via buildPreviousAttemptContext.
    if (!worker.thread_id?.trim()) continue;

    const deps = buildValidatorDeps(config, lifecycleStore, validatorConfig, dispatchPlanPath, log, meridianApi);

    const response = await buildValidatorFeedbackDeliveryResponse(deps, workerId, log);
    if (response === null) {
      // Delivery failed and the thread was cleared for relaunch. Skip this
      // row and fall through to the launch path within this same tick.
      continue;
    }

    if (response.status === "validation_feedback_delivered") {
      const latestWorker = lifecycleStore.load().workers[workerId];
      if (latestWorker?.status === "awaiting_validation" && !latestWorker.validation?.validator_thread_id) {
        void runValidationCycleWithFeedbackLoop(deps, workerId, row, log).catch((error) => {
          log.warn("Validator cycle failed unexpectedly", {
            event: "validator_cycle_unhandled_error",
            worker_id: workerId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }

    return response;
  }

  return null;
}

async function buildValidatorFeedbackDeliveryResponse(
  deps: ValidatorOrchestratorDeps,
  workerId: string,
  log: Logger
): Promise<ContinueDispatcherResponse | null> {
  const outcome = await deliverValidatorFeedback(deps, workerId);
  if (outcome.delivered) {
    return {
      ok: true,
      status: "validation_feedback_delivered",
      message: `validator feedback delivered to ${workerId}`,
      worker: workerId
    };
  }

  if (outcome.reason === "delivery_error") {
    // The retained worker thread is unreachable (expired, killed, hub
    // disconnect). Validator feedback is preserved in worker.validation;
    // clear the dead thread id so the standard launch path relaunches the
    // row in the same continue-dispatcher tick. continueWorker (called
    // downstream) sees fix_requested with empty thread_id and falls through
    // to launchWorkerFromDispatchPlan; the new thread reads the preserved
    // feedback through buildPreviousAttemptContext. Only escalate to PM if
    // that relaunch also fails. Return null to let processValidationQueue
    // fall through to the launch path.
    log.warn("Validator feedback undeliverable; relaunching worker row", {
      event: "validator_feedback_relaunch",
      worker_id: workerId,
      error: outcome.error
    });
    deps.lifecycleStore.clearWorkerThreadForRelaunch(workerId, "validator_feedback_undeliverable");
    return null;
  }

  return {
    ok: true,
    status: "manual_intervention_required",
    message: `manual intervention required: ${workerId} validator feedback could not be delivered (${outcome.detail})`,
    worker: workerId
  };
}

function buildValidatorDeps(
  config: AgentDispatcherConfig,
  lifecycleStore: LifecycleStore,
  validatorConfig: ValidatorConfig,
  dispatchPlanPath: string,
  log: Logger,
  meridianApi?: MeridianApiClient
): ValidatorOrchestratorDeps {
  return {
    lifecycleStore,
    validatorConfig,
    meridianApi: meridianApi ?? createMeridianApiClient(),
    killPolicy: config.kill_policy,
    spawnDir: resolveConfiguredDispatchRepoRoot(config) ?? path.dirname(dispatchPlanPath),
    dispatchPlanPath,
    taskspecPath: resolveTaskspecPath(config),
    log
  };
}

function resolveCompletedWorkerValidationDisposition(
  validatorConfig: ValidatorConfig,
  row: DispatchContinuationPlanRow,
  worker: DispatchWorkerState | undefined
): "awaiting_validation" | "failed" | null {
  if (!worker || worker.status !== "completed" || !isValidationEnabledForWorker(validatorConfig, row)) {
    return null;
  }

  // A validator is currently in flight for this worker. If the lifecycle has
  // silently flipped the worker back to "completed" (e.g. a late hub_result
  // update on the worker thread, or a reconciler pass on the same artifact)
  // while the validator we just spawned is still running, do NOT re-intercept.
  // Re-intercepting would call transitionToAwaitingValidation a second time,
  // which historically cleared validator_thread_id and let Phase 2 spawn a
  // duplicate validator (observed: BATCH-3-GATE codex_74 + codex_75 both
  // running cycle 1 in dispatcher a9a66025). Trust the in-flight validator.
  if (worker.validation?.validator_thread_id?.trim()) {
    return null;
  }

  if (!worker.validation) {
    return "awaiting_validation";
  }

  const lastScore = worker.validation.last_score;
  if (typeof lastScore !== "number") {
    return "awaiting_validation";
  }

  if (isValidatorResultPassing(validatorConfig, row, lastScore)) {
    return null;
  }

  return worker.validation.current_cycle >= worker.validation.max_fix_cycles
    ? "failed"
    : "awaiting_validation";
}

function describeValidationMaxCycleFailure(validatorConfig: ValidatorConfig): string {
  return (validatorConfig.threshold_type ?? "score") === "binary"
    ? "validator returned a failing verdict"
    : "validator score remained below threshold";
}

async function isRecordedValidatorThreadActive(
  workerId: string,
  validatorThreadId: string,
  attachToThread: ((threadId: string) => Promise<void>) | undefined,
  log: Logger
): Promise<boolean> {
  if (!attachToThread) {
    return true;
  }

  try {
    await attachToThread(validatorThreadId);
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    if (isMissingThreadEvidence(message)) {
      log.warn("Clearing stale validator thread id before continue", {
        event: "validator_thread_missing",
        worker_id: workerId,
        validator_thread_id: validatorThreadId,
        error: message
      });
      return false;
    }

    log.warn("Failed to verify validator thread before continue", {
      event: "validator_thread_attach_error",
      worker_id: workerId,
      validator_thread_id: validatorThreadId,
      error: message
    });
    return true;
  }
}

async function runValidationCycleWithFeedbackLoop(
  deps: ValidatorOrchestratorDeps,
  workerId: string,
  row: DispatchContinuationPlanRow,
  log: Logger
): Promise<void> {
  const maxIterations = Math.max(1, deps.validatorConfig.max_fix_cycles + 1);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const outcome = await executeValidationCycle(deps, workerId, row);
    log.info("Validator cycle finished", {
      event: "validator_cycle_finished",
      worker_id: workerId,
      status: outcome.status
    });

    if (outcome.status !== "fix_requested") {
      return;
    }

    const delivered = await deliverValidatorFeedback(deps, workerId);
    if (!delivered.delivered) {
      log.warn("Validator feedback was not delivered after fix request", {
        event: "validator_feedback_not_delivered",
        worker_id: workerId,
        reason: delivered.reason,
        ...(delivered.reason === "delivery_error"
          ? { error: delivered.error }
          : { detail: delivered.detail })
      });
      return;
    }

    const latestWorker = deps.lifecycleStore.load().workers[workerId];
    if (latestWorker?.status !== "awaiting_validation" || latestWorker.validation?.validator_thread_id) {
      return;
    }
  }
}

function resolveTaskspecPath(config: AgentDispatcherConfig): string | null {
  const docsRoot = resolveConfiguredDocsRoot(config);
  if (!docsRoot) return null;

  const taskspecPath = path.join(docsRoot, "taskspec.md");
  try {
    fsSync.accessSync(taskspecPath, fsSync.constants.R_OK);
    return taskspecPath;
  } catch {
    return null;
  }
}

function isLocalToolBootstrapFailure(message: string): boolean {
  return /(?:^|[\s:])(EACCES|ENOENT|EPERM)(?:[\s:]|$)/i.test(message)
    || message.includes("/tmp/tsx-")
    || /\btsx\b/i.test(message)
    || /\brun launch failed\b/i.test(message)
    || /\bspawn failed: Command failed\b/i.test(message)
    || /\bspawn failed: spawn\b/i.test(message)
    || /\bNode (?:CLI )?(?:startup|loader)\b/i.test(message);
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

export async function loadDispatchLifecycleState(dispatchPlanPath: string, log: Logger): Promise<DispatchThreadStateV2> {
  try {
    return new LifecycleStore(resolveDispatchThreadPath(dispatchPlanPath)).load();
  } catch (error) {
    log.warn("Failed to read agent-dispatcher sidecar", {
      dispatchPlanPath,
      error: getErrorMessage(error)
    });

    return {
      version: 2,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "pending"
      },
      workers: {},
      pm_resolvers: [],
      last_reconciled_at: null
    };
  }
}

export async function loadDispatchPlanData(dispatchPlanPath: string, log: Logger): Promise<DispatchPlanData> {
  try {
    const markdown = await fs.readFile(dispatchPlanPath, "utf8");
    return {
      rows: parseDispatchPlanRows(markdown),
      modelLegend: parseDispatchPlanModelLegend(markdown)
    };
  } catch (error) {
    log.warn("Failed to read dispatch plan for agent-dispatcher detail", {
      dispatchPlanPath,
      error: getErrorMessage(error)
    });
    return {
      rows: [],
      modelLegend: {}
    };
  }
}

export async function enrichDispatchPlanRows(
  dispatchPlanPath: string,
  rows: DispatchPlanRow[],
  log: Logger
): Promise<DispatchPlanRow[]> {
  try {
    const report = await buildDispatchStatusReport(dispatchPlanPath);
    const statusByWorker = new Map(report.workers.map((worker) => [worker.worker_id, worker]));

    return rows.map((row) => {
      const workerStatus = statusByWorker.get(row.worker);
      if (!workerStatus) {
        return row;
      }

      return {
        ...row,
        status: workerStatus.status,
        lifecycle_status: workerStatus.lifecycle_status,
        thread_id: workerStatus.thread_id,
        last_seen_at: workerStatus.last_seen_at,
        stale: workerStatus.stale,
        stale_label: workerStatus.stale_label,
        stale_duration_minutes: workerStatus.stale_duration_minutes,
        stale_duration_human: workerStatus.stale_duration_human,
        progress: workerStatus.progress,
        active_owner_kind: workerStatus.active_owner_kind,
        active_owner_thread_id: workerStatus.active_owner_thread_id
      };
    });
  } catch (error) {
    log.warn("Failed to enrich dispatch plan rows with stale status", {
      dispatchPlanPath,
      error: getErrorMessage(error)
    });
    return rows;
  }
}

async function loadDispatcherSessionLog(
  dispatcherThreadId: string | null,
  getThreadDetail: ((threadId: string) => Promise<string>) | undefined,
  attachToThread: ((threadId: string) => Promise<void>) | undefined,
  fallbackContext: {
    currentWorker: string | null;
    currentWorkerEntry: DispatchWorkerState | null;
    dispatcherEntry: DispatchWorkerState | null;
    dispatchPlanPath: string;
    roleId: string;
    roleStatus: string;
  },
  log: Logger,
  onDispatcherMissing?: () => Promise<void>
): Promise<{ lines: string[]; dispatcherMissing: boolean }> {
  const fallbackLog = buildFallbackSessionLog(fallbackContext, dispatcherThreadId);
  if (!dispatcherThreadId || !getThreadDetail) {
    return {
      lines: fallbackLog,
      dispatcherMissing: false
    };
  }

  if (attachToThread) {
    try {
      await attachToThread(dispatcherThreadId);
    } catch (error) {
      const message = getErrorMessage(error);
      log.warn("Failed to attach dispatcher session before detail fetch", {
        thread_id: dispatcherThreadId,
        role_id: fallbackContext.roleId,
        error: message
      });
      if (handleMissingDispatcherThreadEvidence(
        fallbackContext.dispatchPlanPath,
        dispatcherThreadId,
        message,
        fallbackContext.roleId,
        "detail-attach",
        log
      )) {
        await onDispatcherMissing?.();
        return {
          lines: buildPersistedDispatcherSessionLog(fallbackContext, dispatcherThreadId) ?? buildMissingDispatcherSessionLog(fallbackContext),
          dispatcherMissing: true
        };
      }
    }
  }

  try {
    const detail = await getThreadDetail(dispatcherThreadId);
    const lines = splitLogLines(detail);
    if (handleMissingDispatcherThreadEvidence(
      fallbackContext.dispatchPlanPath,
      dispatcherThreadId,
      detail,
      fallbackContext.roleId,
      "detail-response",
      log
    )) {
      await onDispatcherMissing?.();
      return {
        lines: buildPersistedDispatcherSessionLog(fallbackContext, dispatcherThreadId) ?? buildMissingDispatcherSessionLog(fallbackContext),
        dispatcherMissing: true
      };
    }
    if (isEmptyCachedDetailResponse(lines)) {
      return {
        lines: buildEmptyCachedDetailLog(fallbackContext, dispatcherThreadId),
        dispatcherMissing: false
      };
    }
    return {
      lines: lines.length > 0 ? lines : fallbackLog,
      dispatcherMissing: false
    };
  } catch (error) {
    const message = getErrorMessage(error);
    log.warn("Failed to fetch dispatcher session detail", {
      dispatcherThreadId,
      error: message
    });
    if (handleMissingDispatcherThreadEvidence(
      fallbackContext.dispatchPlanPath,
      dispatcherThreadId,
      message,
      fallbackContext.roleId,
      "detail-fetch",
      log
    )) {
      await onDispatcherMissing?.();
      return {
        lines: buildPersistedDispatcherSessionLog(fallbackContext, dispatcherThreadId) ?? buildMissingDispatcherSessionLog(fallbackContext),
        dispatcherMissing: true
      };
    }
    return {
      lines: buildPersistedDispatcherSessionLog(fallbackContext, dispatcherThreadId) ?? fallbackLog,
      dispatcherMissing: false
    };
  }
}

function resolveDispatcherThreadId(lifecycleState: DispatchThreadStateV2): string | null {
  return lifecycleState.dispatcher.status === "running"
    ? lifecycleState.dispatcher.thread_id ?? null
    : null;
}

function resolveVisibleDispatcherThreadId(lifecycleState: DispatchThreadStateV2, roleStatus: string): string | null {
  if (roleStatus === NEEDS_REACTIVATION_ROLE_STATUS) {
    return null;
  }

  return resolveDispatcherThreadId(lifecycleState);
}

async function validateDispatcherThreadForContinue(
  dispatchPlanPath: string,
  roleId: string,
  dispatcherThreadId: string | undefined,
  attachToThread: ((threadId: string) => Promise<void>) | undefined,
  log: Logger,
  onDispatcherMissing?: () => Promise<void>
): Promise<string | undefined> {
  const candidate = dispatcherThreadId?.trim();
  if (!candidate || !attachToThread) {
    return candidate || undefined;
  }

  try {
    await attachToThread(candidate);
    return candidate;
  } catch (error) {
    const message = getErrorMessage(error);
    log.warn("Failed to attach dispatcher session before continue", {
      thread_id: candidate,
      role_id: roleId,
      error: message
    });
    if (handleMissingDispatcherThreadEvidence(
      dispatchPlanPath,
      candidate,
      message,
      roleId,
      "continue-attach",
      log
    )) {
      await onDispatcherMissing?.();
      return undefined;
    }

    return candidate;
  }
}

function handleMissingDispatcherThreadEvidence(
  dispatchPlanPath: string,
  dispatcherThreadId: string,
  evidence: string | null | undefined,
  roleId: string,
  source: "continue-attach" | "detail-attach" | "detail-fetch" | "detail-response",
  log: Logger
): boolean {
  if (!isMissingThreadEvidence(evidence)) {
    return false;
  }

  const lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(dispatchPlanPath));
  const lifecycleState = lifecycleStore.load();
  if (lifecycleState.dispatcher.status !== "running" || lifecycleState.dispatcher.thread_id !== dispatcherThreadId) {
    return true;
  }

  lifecycleState.dispatcher = {
    ...lifecycleState.dispatcher,
    status: "abandoned"
  };
  lifecycleStore.logTransition("dispatcher", "running", "abandoned", "dispatcher_thread_missing");
  lifecycleStore.save(lifecycleState);
  log.warn("Demoted dispatcher lifecycle state after missing-thread evidence", {
    role_id: roleId,
    dispatch_plan_path: dispatchPlanPath,
    thread_id: dispatcherThreadId,
    source
  });
  return true;
}

export function buildDispatchWorkerDetails(
  lifecycleState: DispatchThreadStateV2,
  dispatchPlanRows: DispatchPlanRow[],
  modelLegend: DispatchPlanModelLegend,
  context: {
    roleId: string;
    dispatcherThreadId: string | null;
    dispatcherAgentType: string;
  }
): DispatchWorkerDetail[] {
  const dispatchPlanByWorker = new Map(dispatchPlanRows.map((row) => [row.worker, row]));
  const details = dispatchPlanRows
    .filter((row) => shouldIncludeDispatchWorkerDetail(row, lifecycleState.workers[row.worker]))
    .map((row) => buildDispatchWorkerDetail(
      row.worker,
      row,
      lifecycleState.workers[row.worker] ?? null,
      modelLegend,
      context
    ));

  const orphanDetails = Object.entries(lifecycleState.workers)
    .filter(([workerId]) => workerId !== DISPATCHER_WORKER_ID && !dispatchPlanByWorker.has(workerId))
    .sort((left, right) => Date.parse(left[1].started_at) - Date.parse(right[1].started_at))
    .map(([workerId, worker]) => buildDispatchWorkerDetail(
      workerId,
      null,
      worker,
      modelLegend,
      context
    ));

  return [...details, ...orphanDetails];
}

// Emit a separate DispatchWorkerDetail for every validation cycle every
// worker has gone through. The Phase A marker protocol stores per-cycle
// score+feedback in `worker.validation.history`, so each cycle becomes
// its own bar grouped under the validated worker. The validator's full
// system prompt and reply text are NOT persisted (only the marker's
// `feedback` field is), so the bar synthesizes a command from the
// available context and uses the feedback as the reply.
function buildValidatorCycleDetails(
  lifecycleState: DispatchThreadStateV2,
  context: { roleId: string }
): DispatchWorkerDetail[] {
  const cycleDetails: DispatchWorkerDetail[] = [];

  for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
    if (workerId === DISPATCHER_WORKER_ID) {
      continue;
    }
    const history = worker.validation?.history ?? [];
    if (history.length === 0) {
      continue;
    }

    const passThreshold = worker.validation?.max_fix_cycles ?? 0;
    void passThreshold;

    for (const entry of history) {
      const isLast = entry === history[history.length - 1];
      const inferredOutcome: "pass" | "fix_requested" | "fail" =
        entry.score >= 1
          ? "pass"
          : entry.score <= 0
            ? "fail"
            : "fix_requested";
      const status = inferredOutcome === "pass"
        ? "completed"
        : inferredOutcome === "fail"
          ? "failed"
          : isLast && worker.status === "fix_requested"
            ? "fix_requested"
            : "completed";

      const commandContent = [
        `Validate worker ${workerId} (cycle ${entry.cycle}).`,
        worker.expected_outputs.length > 0
          ? `Expected outputs: ${worker.expected_outputs.join(", ")}`
          : null,
        `Threshold: cycle accepts when score is ≥ pass_threshold; fix_requested when partial; fail otherwise.`,
        "Note: only the validator's marker feedback is persisted; full prompt/reply text is not retained yet."
      ].filter((line): line is string => Boolean(line)).join("\n");

      const replyContent = [
        `Outcome: ${inferredOutcome}`,
        `Score: ${entry.score}`,
        "",
        entry.feedback
      ].join("\n");

      cycleDetails.push({
        detail_kind: "validator",
        worker_id: `VALIDATOR:${workerId}:cycle-${entry.cycle}`,
        task_id: workerId,
        status,
        task: `Validate ${workerId} cycle ${entry.cycle}`,
        model: "VALIDATOR",
        applied_model: null,
        applied_reasoning_effort: null,
        worker_thread_id: entry.validator_thread_id,
        trace_id: null,
        command: {
          trace_id: null,
          sender_name: context.roleId,
          sender_agent_type: "dispatcher",
          sender_model: null,
          sender_thread_id: context.roleId,
          timestamp: worker.last_seen_at,
          content: commandContent
        },
        reply: {
          trace_id: null,
          sender_name: entry.validator_thread_id,
          sender_agent_type: "validator",
          sender_model: null,
          sender_thread_id: entry.validator_thread_id,
          timestamp: entry.timestamp,
          content: replyContent
        },
        validation: null,
        validator_cycle: entry.cycle,
        validator_score: entry.score,
        validator_outcome: inferredOutcome
      });
    }
  }

  cycleDetails.sort((left, right) => {
    const leftTs = left.reply?.timestamp ?? "";
    const rightTs = right.reply?.timestamp ?? "";
    return leftTs.localeCompare(rightTs);
  });

  return cycleDetails;
}

async function buildPmResolverDetails(
  lifecycleState: DispatchThreadStateV2,
  context: {
    roleId: string;
    getThreadDetail?: (threadId: string) => Promise<string>;
    log: Logger;
  }
): Promise<DispatchWorkerDetail[]> {
  const pmResolvers = [...(lifecycleState.pm_resolvers ?? [])]
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
  const pmResolverWorkerIds = new Set(pmResolvers
    .map((entry) => entry.issue.worker_id)
    .filter((workerId): workerId is string => Boolean(workerId)));

  const explicitDetails = await Promise.all(pmResolvers.map(async (entry) => {
    const liveDetail = await loadPmResolverLiveDetail(entry, context);
    return buildPmResolverDetail(entry, {
      roleId: context.roleId,
      liveDetail
    });
  }));
  const recoveredDetails = buildRecoveredPmResolverDetails(lifecycleState, {
    roleId: context.roleId,
    skipWorkerIds: pmResolverWorkerIds
  });

  return [
    ...explicitDetails,
    ...recoveredDetails
  ];
}

async function loadPmResolverLiveDetail(
  entry: PmResolverLifecycleState,
  context: {
    getThreadDetail?: (threadId: string) => Promise<string>;
    log: Logger;
  }
): Promise<string | null> {
  if (!context.getThreadDetail) {
    return null;
  }

  if (entry.status !== "running") {
    return null;
  }

  try {
    const detail = await withTimeout(
      context.getThreadDetail(entry.thread_id),
      PM_RESOLVER_DETAIL_TIMEOUT_MS,
      `PM resolver detail timed out after ${PM_RESOLVER_DETAIL_TIMEOUT_MS}ms`
    );
    const lines = splitLogLines(detail);
    return isEmptyCachedDetailResponse(lines) ? null : detail;
  } catch (error) {
    context.log.warn("Failed to fetch PM resolver detail", {
      thread_id: entry.thread_id,
      error: getErrorMessage(error)
    });
    return null;
  }
}

function buildPmResolverDetail(
  entry: PmResolverLifecycleState,
  context: {
    roleId: string;
    liveDetail: string | null;
  }
): DispatchWorkerDetail {
  const liveConversation = parseDispatchConversation(context.liveDetail ?? undefined);
  const resultConversation = parseDispatchConversation(entry.result?.details_text ?? undefined);
  const replyContent =
    liveConversation.reply
    ?? resultConversation.reply
    ?? normalizeConversationSection(entry.result?.summary_text ?? undefined)
    ?? normalizeConversationSection(entry.result?.content ?? undefined)
    ?? normalizeConversationSection(entry.error ?? undefined)
    ?? (entry.status === "running" && entry.transport_error
      ? `PM resolver run rejected (transport): ${entry.transport_error}\nThread retained — talk into the PM session via the bar's talk-box, or HUMAN-resolve the worker to unblock.`
      : null)
    ?? (entry.status === "running" ? "PM resolver is running; waiting for its reply." : null);
  const commandContent =
    liveConversation.command
    ?? resultConversation.command
    ?? formatPmResolverIssueContext(entry);
  const workerId = entry.issue.worker_id ?? entry.thread_id;
  const timestamp = entry.result?.timestamp ?? entry.last_seen_at;
  const status = resolvePmResolverDetailStatus(entry, replyContent);

  return {
    detail_kind: "pm_resolver",
    worker_id: `PM:${workerId}`,
    task_id: workerId,
    status,
    task: `Resolve ${workerId}: ${entry.issue.status}`,
    model: "PM",
    applied_model: entry.model_id ?? entry.agent_type ?? "PM",
    applied_reasoning_effort: null,
    worker_thread_id: entry.thread_id,
    trace_id: entry.result?.trace_id ?? null,
    command: commandContent
      ? {
          trace_id: null,
          sender_name: context.roleId,
          sender_agent_type: "dispatcher",
          sender_model: null,
          sender_thread_id: context.roleId,
          timestamp: entry.started_at,
          content: commandContent
        }
      : null,
    reply: replyContent
      ? {
          trace_id: entry.result?.trace_id ?? null,
          sender_name: entry.thread_id,
          sender_agent_type: entry.agent_type ?? "pm",
          sender_model: entry.model_id ?? entry.mode,
          sender_thread_id: entry.thread_id,
          timestamp,
          content: replyContent
        }
      : null,
    validation: null,
    is_alive: status === "running" && Boolean(entry.thread_id?.trim())
  };
}

function resolvePmResolverDetailStatus(
  entry: PmResolverLifecycleState,
  replyContent: string | null
): PmResolverLifecycleState["status"] {
  if (entry.status !== "running" || !replyContent) {
    return entry.status;
  }

  const marker = parseMeridianStatusMarker(replyContent);
  if (!marker || marker.role !== "pm-resolver") {
    return entry.status;
  }

  const targetWorkerId = entry.issue.worker_id;
  if (targetWorkerId && marker.worker_id !== targetWorkerId) {
    return entry.status;
  }

  return marker.outcome === "resolved" ? "completed" : "failed";
}

function buildRecoveredPmResolverDetails(
  lifecycleState: DispatchThreadStateV2,
  context: {
    roleId: string;
    skipWorkerIds: Set<string>;
  }
): DispatchWorkerDetail[] {
  return Object.entries(lifecycleState.workers)
    .filter(([workerId, worker]) => {
      return !context.skipWorkerIds.has(workerId) && isPmResolverHubResult(worker.hub_result);
    })
    .sort((left, right) => Date.parse(left[1].last_seen_at) - Date.parse(right[1].last_seen_at))
    .map(([workerId, worker]) => buildPmResolverDetail({
      thread_id: worker.hub_result?.thread_id ?? worker.thread_id,
      status: worker.status === "failed" || worker.status === "blocked" || worker.status === "abandoned"
        ? "failed"
        : "completed",
      started_at: worker.started_at,
      last_seen_at: worker.hub_result?.timestamp ?? worker.last_seen_at,
      agent_type: worker.hub_result?.source ?? "pm-resolver",
      model_id: null,
      mode: null,
      auto_approve: null,
      issue: {
        status: "recovered_pm_resolution",
        worker_id: workerId,
        message: "Recovered from worker result recorded before PM resolver history was available.",
        error: null,
        source: "worker_result"
      },
      result: worker.hub_result
        ? {
            status: worker.hub_result.status,
            run_state: worker.hub_result.run_state ?? null,
            content: worker.hub_result.content,
            summary_text: worker.hub_result.summary_text ?? null,
            details_text: worker.hub_result.details_text ?? null,
            trace_id: worker.hub_result.trace_id,
            timestamp: worker.hub_result.timestamp
          }
        : null,
      error: null,
      transport_error: null
    }, {
      roleId: context.roleId,
      liveDetail: null
    }));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function formatPmResolverIssueContext(entry: PmResolverLifecycleState): string {
  return [
    `Issue status: ${entry.issue.status}`,
    entry.issue.worker_id ? `Worker: ${entry.issue.worker_id}` : null,
    `Source: ${entry.issue.source}`,
    entry.issue.message ? `Message: ${entry.issue.message}` : null,
    entry.issue.error ? `Error: ${entry.issue.error}` : null
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function shouldIncludeDispatchWorkerDetail(
  dispatchPlanRow: DispatchPlanRow,
  worker: DispatchWorkerState | undefined
): boolean {
  if (worker) {
    return true;
  }

  return mapDispatchPlanStatusToLifecycleStatus(dispatchPlanRow.status) !== "pending";
}

function buildDispatchWorkerDetail(
  workerId: string,
  dispatchPlanRow: DispatchPlanRow | null,
  worker: DispatchWorkerState | null,
  modelLegend: DispatchPlanModelLegend,
  context: {
    roleId: string;
    dispatcherThreadId: string | null;
    dispatcherAgentType: string;
  }
): DispatchWorkerDetail {
  const workerHubResult = getWorkerOwnedHubResult(worker);
  const conversation = parseDispatchConversation(workerHubResult?.details_text);
  const commandFallback = conversation.command ?? worker?.command_preamble ?? null;
  const replyContent = resolveDispatchReply(workerHubResult, conversation.reply);
  const appliedModel = resolveAppliedModelForWorker(
    worker,
    dispatchPlanRow?.model ?? null,
    modelLegend
  );
  const appliedReasoningEffort = resolveAppliedReasoningEffortForWorker(
    worker,
    dispatchPlanRow?.model ?? null,
    modelLegend
  );
  const status = resolveDispatchWorkerDetailStatus(worker, dispatchPlanRow);

  return {
    detail_kind: "worker",
    worker_id: workerId,
    task_id: workerId,
    status,
    task: dispatchPlanRow?.task ?? null,
    model: dispatchPlanRow?.model ?? null,
    applied_model: appliedModel,
    applied_reasoning_effort: appliedReasoningEffort,
    worker_thread_id: worker?.thread_id ?? dispatchPlanRow?.thread_id ?? "",
    trace_id: workerHubResult?.trace_id ?? worker?.trace_id ?? null,
    command: commandFallback
      ? {
          trace_id: worker?.trace_id ?? null,
          sender_name: context.dispatcherThreadId ?? context.roleId,
          sender_agent_type: context.dispatcherAgentType,
          sender_model: null,
          sender_thread_id: context.dispatcherThreadId,
          timestamp: worker?.started_at ?? null,
          content: commandFallback
        }
      : null,
    reply: replyContent
      ? {
          trace_id: workerHubResult?.trace_id ?? worker?.trace_id ?? null,
          sender_name: workerHubResult?.thread_id ?? worker?.thread_id ?? workerId,
          sender_agent_type: workerHubResult?.source ?? null,
          sender_model: appliedModel,
          sender_thread_id: workerHubResult?.thread_id ?? worker?.thread_id ?? null,
          timestamp: workerHubResult?.timestamp ?? worker?.last_seen_at ?? null,
          content: replyContent
        }
      : null,
    validation: buildDispatchValidationDetail(worker?.validation),
    retry_count: worker?.retry_count ?? 0,
    is_alive: isWorkerSessionAlive(worker, status),
    human_resolution: worker?.human_resolution
      ? {
          resolved_at: worker.human_resolution.resolved_at,
          note: worker.human_resolution.note ?? null
        }
      : null
  };
}

function isWorkerSessionAlive(
  worker: DispatchWorkerState | null,
  effectiveStatus: string
): boolean {
  if (!worker?.thread_id?.trim()) {
    return false;
  }
  const status = (effectiveStatus || worker.status || "").toString().toLowerCase();
  return status === "running"
    || status === "blocked"
    || status === "awaiting_validation"
    || status === "fix_requested";
}

function resolveAppliedModelForWorker(
  worker: DispatchWorkerState | null,
  modelCode: string | null,
  modelLegend: DispatchPlanModelLegend
): string | null {
  const overriddenModel = worker?.applied_model_id?.trim();
  if (overriddenModel && overriddenModel.length > 0) {
    return overriddenModel;
  }

  return resolveAppliedModel(modelCode, modelLegend);
}

function resolveAppliedReasoningEffortForWorker(
  worker: DispatchWorkerState | null,
  modelCode: string | null,
  modelLegend: DispatchPlanModelLegend
): string | null {
  const overriddenEffort = worker?.applied_reasoning_effort?.trim();
  if (overriddenEffort && overriddenEffort.length > 0) {
    return overriddenEffort;
  }

  return resolveAppliedReasoningEffort(modelCode, modelLegend);
}

function resolveDispatchWorkerDetailStatus(
  worker: DispatchWorkerState | null,
  dispatchPlanRow: DispatchPlanRow | null
): LifecycleStatus {
  const workerHubResult = getWorkerOwnedHubResult(worker);
  const workerLifecycleStatus = worker?.status ?? normalizeLifecycleStatus(dispatchPlanRow?.lifecycle_status);

  if (workerLifecycleStatus === "completed" || workerLifecycleStatus === "skipped") {
    return workerLifecycleStatus;
  }

  if (workerHubResult && hubResultContainsBlockSignal(workerHubResult)) {
    return "blocked";
  }

  if (workerHubResult && hubResultContainsFailureSignal(workerHubResult)) {
    return "failed";
  }

  const enrichedLifecycleStatus = normalizeLifecycleStatus(dispatchPlanRow?.lifecycle_status);
  if (enrichedLifecycleStatus) {
    return enrichedLifecycleStatus;
  }

  return workerLifecycleStatus ?? mapDispatchPlanStatusToLifecycleStatus(dispatchPlanRow?.status) ?? "pending";
}

function getWorkerOwnedHubResult(worker: DispatchWorkerState | null | undefined): HubResult | null {
  if (!worker?.hub_result || isPmResolverHubResult(worker.hub_result)) {
    return null;
  }

  return worker.hub_result;
}

function normalizeLifecycleStatus(status: string | null | undefined): LifecycleStatus | null {
  switch (status) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "blocked":
    case "abandoned":
    case "skipped":
    case "awaiting_validation":
    case "fix_requested":
      return status;
    default:
      return null;
  }
}

function buildDispatchValidationDetail(
  validation: DispatchWorkerState["validation"] | undefined
): DispatchValidationDetail | null {
  if (!validation) {
    return null;
  }

  return {
    current_cycle: validation.current_cycle,
    max_fix_cycles: validation.max_fix_cycles,
    validator_thread_id: validation.validator_thread_id,
    last_score: validation.last_score,
    last_feedback: validation.last_feedback,
    history: validation.history.map((entry) => ({
      cycle: entry.cycle,
      score: entry.score,
      feedback: entry.feedback,
      validator_thread_id: entry.validator_thread_id,
      timestamp: entry.timestamp
    }))
  };
}

function mapDispatchPlanStatusToLifecycleStatus(status: string | null | undefined): LifecycleStatus | null {
  switch (status?.trim()) {
    case "🔄":
      return "running";
    case "✅":
      return "completed";
    case "❌":
      return "failed";
    case "⛔ BLOCKED":
      return "blocked";
    case "⚠️ ABANDONED":
      return "abandoned";
    case "⛔ SKIPPED":
      return "skipped";
    case "⬜":
      return "pending";
    default:
      return null;
  }
}

function parseDispatchConversation(detailsText: string | null | undefined): { command: string | null; reply: string | null } {
  if (!detailsText) {
    return {
      command: null,
      reply: null
    };
  }

  const normalized = detailsText.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      command: null,
      reply: null
    };
  }

  const conversationMatch = normalized.match(/^Your message:\n([\s\S]*?)(?:\n{2,}Agent reply:\n([\s\S]*))?$/);
  if (conversationMatch) {
    return {
      command: normalizeConversationSection(conversationMatch[1]),
      reply: normalizeConversationSection(conversationMatch[2])
    };
  }

  const replyMatch = normalized.match(/(?:^|\n)Agent reply:\n([\s\S]*)$/);
  return {
    command: null,
    reply: normalizeConversationSection(replyMatch?.[1])
  };
}

function resolveDispatchReply(hubResult: HubResult | null | undefined, parsedReply: string | null): string | null {
  if (parsedReply) {
    return parsedReply;
  }

  if (!hubResult) {
    return null;
  }

  return normalizeConversationSection(hubResult.summary_text)
    ?? normalizeConversationSection(hubResult.content)
    ?? normalizeConversationSection(hubResult.details_text);
}

function normalizeConversationSection(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveCurrentWorker(rows: DispatchPlanRow[], trackerState: DispatchThreadStateV2): string | null {
  const inProgressWorker = rows.find((row) => row.status === "🔄")?.worker;
  if (inProgressWorker) {
    return inProgressWorker;
  }

  const trackedWorkers = Object.entries(trackerState.workers)
    .filter(([workerId, worker]) => workerId !== DISPATCHER_WORKER_ID && worker.status === "running")
    .sort((left, right) => {
      return Date.parse(right[1].started_at) - Date.parse(left[1].started_at);
    });

  return trackedWorkers[0]?.[0] ?? null;
}

function extractLastLogLine(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) {
      return line;
    }
  }

  return null;
}

function buildFallbackSessionLog(
  context: {
    currentWorker: string | null;
    currentWorkerEntry: DispatchWorkerState | null;
    dispatcherEntry: DispatchWorkerState | null;
    dispatchPlanPath: string;
    roleStatus: string;
  },
  dispatcherThreadId: string | null
): string[] {
  const lines = [
    `Role status: ${context.roleStatus}`,
    `Dispatch plan: ${context.dispatchPlanPath}`,
    `Dispatcher thread: ${dispatcherThreadId ?? "pending"}`,
    `Current worker: ${context.currentWorker ?? "idle"}`
  ];

  if (context.currentWorkerEntry) {
    lines.push(`Worker thread: ${context.currentWorkerEntry.thread_id}`);
    lines.push(`Worker started: ${context.currentWorkerEntry.started_at}`);
  }

  return lines;
}

function buildEmptyCachedDetailLog(
  context: {
    currentWorker: string | null;
    currentWorkerEntry: DispatchWorkerState | null;
    dispatcherEntry: DispatchWorkerState | null;
    dispatchPlanPath: string;
    roleStatus: string;
  },
  dispatcherThreadId: string | null
): string[] {
  return buildPersistedDispatcherSessionLog(context, dispatcherThreadId)
    ?? [
      ...buildFallbackSessionLog(context, dispatcherThreadId),
      "Dispatcher detail cache is empty. Send a new request to the dispatcher, then refresh this page."
    ];
}

function buildMissingDispatcherSessionLog(
  context: {
    currentWorker: string | null;
    currentWorkerEntry: DispatchWorkerState | null;
    dispatcherEntry: DispatchWorkerState | null;
    dispatchPlanPath: string;
    roleStatus: string;
  }
): string[] {
  return [
    ...buildFallbackSessionLog(context, null),
    "Dispatcher lifecycle was demoted after Hub reported the thread missing."
  ];
}

function buildPersistedDispatcherSessionLog(
  context: {
    currentWorker: string | null;
    currentWorkerEntry: DispatchWorkerState | null;
    dispatcherEntry: DispatchWorkerState | null;
    dispatchPlanPath: string;
    roleStatus: string;
  },
  dispatcherThreadId: string | null
): string[] | null {
  const dispatcherEntry = context.dispatcherEntry;
  if (!dispatcherEntry) {
    return null;
  }

  const detailsText = normalizeConversationSection(dispatcherEntry.hub_result?.details_text);
  if (detailsText) {
    return [
      ...buildFallbackSessionLog(context, dispatcherThreadId),
      "Persisted dispatcher history:",
      ...splitLogLines(detailsText)
    ];
  }

  const conversation = parseDispatchConversation(dispatcherEntry.hub_result?.details_text);
  const command = conversation.command ?? dispatcherEntry.command_preamble ?? null;
  const reply = resolveDispatchReply(dispatcherEntry.hub_result, conversation.reply);
  if (!command && !reply) {
    return null;
  }

  const lines = [
    ...buildFallbackSessionLog(context, dispatcherThreadId),
    "Persisted dispatcher history:"
  ];
  if (command) {
    lines.push("Your message:");
    lines.push(...splitLogLines(command));
  }
  if (reply) {
    if (command) {
      lines.push("");
    }
    lines.push("Agent reply:");
    lines.push(...splitLogLines(reply));
  }

  return lines;
}

function isEmptyCachedDetailResponse(lines: string[]): boolean {
  return lines.length === 1 && lines[0] === "No cached detail found. Send a new request first, then run /detail again.";
}

function splitLogLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ""));
}

function parseDispatchPlanRows(markdown: string): DispatchPlanRow[] {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const columnIndex = indexDispatchPlanColumns(headerCells);
    if (!columnIndex) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    const rows: DispatchPlanRow[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      rows.push({
        status: rowCells[columnIndex.status],
        batch: rowCells[columnIndex.batch],
        worker: rowCells[columnIndex.worker],
        task: rowCells[columnIndex.task],
        model: rowCells[columnIndex.model],
        depends_on: rowCells[columnIndex.depends_on],
        prds_to_attach: columnIndex.prds_to_attach === -1 ? undefined : rowCells[columnIndex.prds_to_attach],
        notes: columnIndex.notes === -1 ? undefined : rowCells[columnIndex.notes]
      });
    }

    return rows;
  }

  return [];
}

function parseDispatchPlanModelLegend(markdown: string): DispatchPlanModelLegend {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const columnIndex = indexDispatchModelLegendColumns(headerCells);
    if (!columnIndex) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    const modelLegend: DispatchPlanModelLegend = {};
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      const code = rowCells[columnIndex.code];
      if (!code) {
        continue;
      }

      modelLegend[code] = {
        provider: columnIndex.provider === -1 ? null : readOptionalTableCell(rowCells[columnIndex.provider]),
        model_id: readOptionalTableCell(rowCells[columnIndex.model_id]),
        reasoning_effort: columnIndex.reasoning_effort === -1
          ? null
          : normalizeReasoningEffort(readOptionalTableCell(rowCells[columnIndex.reasoning_effort]) ?? undefined) ?? null
      };
    }

    return modelLegend;
  }

  return {};
}

function indexDispatchPlanColumns(headerCells: string[]): {
  status: number;
  batch: number;
  worker: number;
  task: number;
  model: number;
  depends_on: number;
  prds_to_attach: number;
  notes: number;
} | null {
  const normalizedHeaders = headerCells.map(normalizeTableHeader);
  const status = normalizedHeaders.indexOf("status");
  const batch = normalizedHeaders.indexOf("batch");
  const worker = normalizedHeaders.indexOf("worker");
  const task = findNormalizedTableHeaderIndex(normalizedHeaders, ["task", "function_group", "headline", "action"]);
  const model = findNormalizedTableHeaderIndex(normalizedHeaders, ["model", "agent", "model_tier"]);
  const dependsOn = findNormalizedTableHeaderIndex(normalizedHeaders, ["depends_on", "depends", "dependencies"]);

  if ([status, batch, worker, task, model, dependsOn].some((index) => index === -1)) {
    return null;
  }

  return {
    status,
    batch,
    worker,
    task,
    model,
    depends_on: dependsOn,
    prds_to_attach: findNormalizedTableHeaderIndex(normalizedHeaders, ["prds_to_attach", "prds", "prd"]),
    notes: findNormalizedTableHeaderIndex(normalizedHeaders, ["notes", "note"])
  };
}

function indexDispatchModelLegendColumns(headerCells: string[]): {
  code: number;
  provider: number;
  model_id: number;
  reasoning_effort: number;
} | null {
  const normalizedHeaders = headerCells.map(normalizeTableHeader);
  const code = normalizedHeaders.indexOf("code");
  const modelId = normalizedHeaders.indexOf("model_id");

  if (code === -1 || modelId === -1) {
    return null;
  }

  return {
    code,
    provider: normalizedHeaders.indexOf("provider"),
    model_id: modelId,
    reasoning_effort: normalizedHeaders.indexOf("reasoning_effort")
  };
}

function resolveAppliedModel(modelCode: string | null, modelLegend: DispatchPlanModelLegend): string | null {
  if (!modelCode) {
    return null;
  }

  const parsedModel = parseDispatchModelCode(modelCode);
  const normalizedModelCode = (parsedModel?.modelCode ?? modelCode).trim();
  if (!normalizedModelCode) {
    return null;
  }

  const resolved = modelLegend[normalizedModelCode]?.model_id;
  if (typeof resolved === "string" && resolved.trim().length > 0) {
    return resolved.trim();
  }

  // Fall back to the raw model code when the legend has no mapping.
  return normalizedModelCode;
}

function resolveAppliedReasoningEffort(modelCode: string | null, modelLegend: DispatchPlanModelLegend): string | null {
  const parsedModel = parseDispatchModelCode(modelCode ?? undefined);
  if (parsedModel?.reasoningEffort) {
    return parsedModel.reasoningEffort;
  }

  const normalizedModelCode = (parsedModel?.modelCode ?? (modelCode ?? "").trim());
  if (!normalizedModelCode) {
    return null;
  }

  const legendEffort = modelLegend[normalizedModelCode]?.reasoning_effort;
  return legendEffort ? normalizeReasoningEffort(legendEffort) ?? null : null;
}

function readOptionalTableCell(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "—" ? trimmed : null;
}

function normalizeTableHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function findNormalizedTableHeaderIndex(normalizedHeaders: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = normalizedHeaders.indexOf(candidate);
    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }

  const withoutLeadingPipe = trimmed.slice(1);
  const normalized = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return normalized.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

const ATTACH_CONNECT_TIMEOUT_MS = 5_000;
const ATTACH_RESPONSE_TIMEOUT_MS = 30_000;

function sendHubFireAndForget(message: HubMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(HUB_SOCKET_PATH);
    const connectTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy(new Error(`Hub fire-and-forget connect timed out after ${ATTACH_CONNECT_TIMEOUT_MS}ms`));
    }, ATTACH_CONNECT_TIMEOUT_MS);

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    socket.once("connect", () => {
      if (settled) return;
      clearTimeout(connectTimeout);
      try {
        socket.end(JSON.stringify(wrapForHub(message)), () => {
          if (settled) return;
          settled = true;
          resolve();
        });
      } catch (error) {
        fail(error);
      }
    });
    socket.once("error", fail);
  });
}

async function defaultAttachToThread(threadId: string): Promise<void> {
  const result = await sendHubRequest(buildAttachMessage(threadId));
  if (result.status !== "success") {
    throw new Error(`attach failed: ${result.content}`);
  }
}

function buildAttachMessage(threadId: string): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: threadId,
    actor_id: ROLES_SERVICE_ID,
    intent: "attach",
    target: threadId,
    priority: 5,
    mode: "bridge",
    reply_channel: {
      channel: "web",
      chat_id: ROLES_SERVICE_ID
    },
    payload: {
      content: "",
      attachments: []
    }
  };
}

function sendHubRequest(message: HubMessage): Promise<z.infer<typeof HubResultSchema>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rawResponse = "";
    const socket = net.createConnection(HUB_SOCKET_PATH);
    const connectTimeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy(new Error(`Attach connect timed out after ${ATTACH_CONNECT_TIMEOUT_MS}ms`));
    }, ATTACH_CONNECT_TIMEOUT_MS);

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(connectTimeout);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });
    socket.once("connect", () => {
      if (settled) {
        return;
      }

      clearTimeout(connectTimeout);
      socket.setTimeout(ATTACH_RESPONSE_TIMEOUT_MS);

      try {
        socket.write(JSON.stringify(wrapForHub(message)));
        socket.end();
      } catch (error) {
        fail(error);
      }
    });
    socket.once("timeout", () => {
      fail(new Error(`Attach request timed out after ${ATTACH_RESPONSE_TIMEOUT_MS}ms`));
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(connectTimeout);

      if (!rawResponse.trim()) {
        reject(new Error("Attach request completed without a response body"));
        return;
      }

      try {
        resolve(HubResultSchema.parse(JSON.parse(rawResponse)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
