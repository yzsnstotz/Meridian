import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import { z } from "zod";

import type { A2AClient } from "../a2a/client";
import { HUB_SOCKET_PATH, ROLES_SERVICE_ID } from "../config";
import { LifecycleStore } from "../roles/agent-dispatcher/lifecycle-store";
import { buildSystemPrompt } from "../roles/agent-dispatcher/prompt-builder";
import { reconcile } from "../roles/agent-dispatcher/reconciler";
import { executeResumeWorkerAction, ResumeWorkerActionRequestSchema } from "../tool-gateway/tools/resume-worker";
import {
  applyEditableDispatcherConfig,
  cloneDispatcherConfig,
  hasRunningDispatcherTask,
  mergeEditableDispatcherConfig,
  parseMutableAgentDispatcherConfig,
  parseMutableDispatcherConfig,
  toEditableAgentDispatcherConfig,
  toEditableDispatcherConfig
} from "../roles/dispatcher-config-editor";
import type { PromptStoreRoleBinding } from "../roles/prompt-store";
import { RoleRegistry } from "../roles/role-registry";
import { RoleRunner } from "../roles/role-runner";
import {
  ACTIVE_ROLE_STATUS,
  NEEDS_REACTIVATION_ROLE_STATUS,
  PAUSED_ROLE_STATUS,
  StateStore
} from "../state-store";
import {
  AgentDispatcherConfigSchema,
  AgentTypeSchema,
  AppStateSchema,
  BridgeModeSchema,
  type DispatchThreadStateV2,
  type DispatchWorkerState,
  DispatchTaskSchema,
  DispatcherConfigSchema,
  DispatcherEditorConfigPatchSchema,
  HubResultSchema,
  KillPolicySchema,
  ReplyChannelSchema,
  RoleTypeSchema,
  shouldUseAgentDispatcherConfig,
  type AgentDispatcherEditorConfig,
  type AppState,
  type AgentDispatcherConfig,
  type DispatcherConfig,
  type DispatcherEditorConfig,
  type HubMessage,
  type HubResult,
  type ReplyChannel,
  type RoleType,
  type RoleState
} from "../types";
import type { Logger } from "../roles/base-role";

type PersistableStateStore = Pick<StateStore, "load" | "save">;
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
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
  agent_type: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  kill_policy: z.string().min(1).optional(),
  use_agent_dispatcher: z.boolean().optional(),
  config: z.unknown().optional()
});

const AgentDispatcherPromptPreviewBodySchema = z.object({
  dispatch_plan_path: z.string().min(1).optional(),
  command_file_path: z.string().min(1).optional(),
  user_reply_channel: ReplyChannelSchema.optional(),
  user_reply_channels: z.array(ReplyChannelSchema).min(1).optional(),
  agent_type: AgentTypeSchema.optional(),
  mode: BridgeModeSchema.optional(),
  kill_policy: KillPolicySchema.optional()
});

type RoleRouteMatch =
  | { kind: "health" }
  | { kind: "list-channels" }
  | { kind: "list-roles" }
  | { kind: "preview-agent-dispatcher-prompt" }
  | { kind: "get-role"; threadId: string }
  | { kind: "get-config"; threadId: string }
  | { kind: "create-role" }
  | { kind: "start-agent-dispatcher" }
  | { kind: "pause-dispatcher"; threadId: string }
  | { kind: "resume-dispatcher"; threadId: string }
  | { kind: "start-dispatcher-hub"; threadId: string }
  | { kind: "resume-worker"; threadId: string; workerId: string }
  | { kind: "reconcile" }
  | { kind: "patch-config"; threadId: string }
  | { kind: "delete-role"; threadId: string };

const PACKAGE_VERSION = readPackageVersion();

export interface RoleHandlersOptions {
  runner: RoleRunner;
  registry: RoleRegistry;
  stateStore?: PersistableStateStore;
  listReplyChannels?: () => Promise<ReplyChannel[]>;
  getThreadDetail?: (threadId: string) => Promise<string>;
  attachToThread?: (threadId: string) => Promise<void>;
  sendHubRequest?: (message: HubMessage) => Promise<HubResult>;
  log?: Logger;
}

export interface RoleHandlers {
  getConfig(threadId: string): Promise<RoleConfigResponse>;
  patchConfig(threadId: string, body: unknown): Promise<RoleConfigResponse>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  resolveRole(threadId: string): PromptStoreRoleBinding | null;
}

export interface RoleConfigResponse {
  thread_id: string;
  status: string;
  can_edit: boolean;
  blocked_reason?: string;
  config: DispatcherEditorConfig | AgentDispatcherEditorConfig;
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
  worker_id: string;
  status: string;
  task: string | null;
  model: string | null;
  applied_model: string | null;
  worker_thread_id: string;
  trace_id: string | null;
  command: DispatchMessageDetail | null;
  reply: DispatchMessageDetail | null;
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
  dispatcher_thread_id?: string | null;
  current_worker?: string | null;
  last_log_line?: string | null;
  user_reply_channels?: ReplyChannel[];
  agent_type?: string;
  mode?: string;
  kill_policy?: string;
  session_log?: string[];
  dispatch_details?: DispatchWorkerDetail[];
  dispatch_plan?: {
    rows: DispatchPlanRow[];
  };
}

interface DispatchPlanData {
  rows: DispatchPlanRow[];
  modelLegend: DispatchPlanModelLegend;
}

type DispatchPlanModelLegend = Record<string, {
  provider: string | null;
  model_id: string | null;
}>;

export function createRoleHandlers(options: RoleHandlersOptions): RoleHandlers {
  const stateStore = options.stateStore ?? new StateStore();
  const log = options.log ?? console;
  const listReplyChannels = options.listReplyChannels ?? (async () => []);
  const getThreadDetail = options.getThreadDetail;
  const attachToThread = options.attachToThread ?? defaultAttachToThread;
  const sendHubRequestImpl = options.sendHubRequest ?? sendHubRequest;
  const activeRoles = new Map<string, PromptStoreRoleBinding>();

  const handlers: RoleHandlers = {
    async getConfig(threadId: string): Promise<RoleConfigResponse> {
      const context = await loadRoleConfigContext(threadId, stateStore, activeRoles);
      if (context.roleType === "agent-dispatcher") {
        return {
          thread_id: threadId,
          status: context.status,
          can_edit: false,
          blocked_reason: getAgentDispatcherConfigEditBlockedReason(),
          config: toEditableAgentDispatcherConfig(context.effectiveConfig)
        };
      }

      const canEdit = !hasRunningDispatcherTask(context.effectiveConfig);

      return {
        thread_id: threadId,
        status: context.status,
        can_edit: canEdit,
        blocked_reason: canEdit ? undefined : getDispatcherConfigEditBlockedReason(),
        config: toEditableDispatcherConfig(context.effectiveConfig)
      };
    },
    async patchConfig(threadId: string, body: unknown): Promise<RoleConfigResponse> {
      const context = await loadRoleConfigContext(threadId, stateStore, activeRoles);
      if (context.roleType === "agent-dispatcher") {
        throw createHttpError(409, getAgentDispatcherConfigEditBlockedReason());
      }

      const parsed = DispatcherEditorConfigPatchSchema.safeParse(body);
      if (!parsed.success) {
        throw createHttpError(400, "Invalid dispatcher config edit payload");
      }

      if (hasRunningDispatcherTask(context.effectiveConfig)) {
        throw createHttpError(409, getDispatcherConfigEditBlockedReason());
      }

      const nextEditableConfig = mergeEditableDispatcherConfig(context.effectiveConfig, parsed.data);

      if (context.activeConfig) {
        applyEditableDispatcherConfig(context.activeConfig, nextEditableConfig);
      }

      const persistedConfig = context.persistedConfig
        ? context.persistedConfig
        : cloneDispatcherConfig(context.activeConfig ?? DispatcherConfigSchema.parse({}));
      applyEditableDispatcherConfig(persistedConfig, nextEditableConfig);
      upsertDispatcherRoleState(context.state, context.roleState, threadId, persistedConfig);

      await stateStore.save(AppStateSchema.parse(context.state));

      return handlers.getConfig(threadId);
    },
    resolveRole(threadId: string): PromptStoreRoleBinding | null {
      return activeRoles.get(threadId) ?? null;
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
            writeJson(response, 200, await listRoles(stateStore));
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
          case "create-role": {
            const created = await createRole(await readJsonBody(request));
            writeJson(response, 201, created);
            return true;
          }
          case "start-agent-dispatcher":
            writeJson(response, 201, await startAgentDispatcher(await readJsonBody(request)));
            return true;
          case "pause-dispatcher":
            writeJson(response, 200, await setAgentDispatcherStatus(route.threadId, "paused"));
            return true;
          case "resume-dispatcher":
            writeJson(response, 200, await setAgentDispatcherStatus(route.threadId, "active"));
            return true;
          case "start-dispatcher-hub":
            writeJson(response, 200, await startAgentDispatcherHubSession(route.threadId));
            return true;
          case "resume-worker":
            writeJson(response, 200, await resumeWorkerForRole(route.threadId, route.workerId, await readJsonBody(request)));
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

  async function createRole(body: unknown): Promise<{ ok: true; thread_id: string; role_type: RoleType }> {
    const { threadId, roleType } = await activateRole(body);
    return { ok: true, thread_id: threadId, role_type: roleType };
  }

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

  async function startAgentDispatcherHubSession(threadId: string): Promise<{
    ok: true;
    dispatcher_thread_id: string;
  }> {
    try {
      const result = await options.runner.relaunchAgentDispatcherHub(threadId);
      return { ok: true, dispatcher_thread_id: result.dispatcher_thread_id };
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("not active") || message.includes("not an AgentDispatcherRole")) {
        throw createHttpError(404, message);
      }

      throw error;
    }
  }

  async function setAgentDispatcherStatus(
    threadId: string,
    status: "active" | "paused"
  ): Promise<{ ok: true; status: "active" | "paused" }> {
    const activeRole = activeRoles.get(threadId);
    if (!activeRole || activeRole.roleType !== "agent-dispatcher") {
      throw createHttpError(404, `Agent dispatcher not found for thread_id=${threadId}`);
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
    const context = await loadRoleConfigContext(threadId, stateStore, activeRoles);
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

  async function getChannels(): Promise<{ channels: ReplyChannel[] }> {
    try {
      return {
        channels: ReplyChannelSchema.array().parse(await listReplyChannels())
      };
    } catch (error) {
      log.warn("Reply channel lookup failed; returning empty list", {
        error: getErrorMessage(error)
      });

      return { channels: [] };
    }
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

  async function activateRole(
    body: unknown,
    forcedRoleType?: RoleType
  ): Promise<{ threadId: string; roleType: RoleType; role: ReturnType<RoleRegistry["create"]> }> {
    const { threadId, roleType, config } = forcedRoleType
      ? normalizeCreateBody(body, forcedRoleType)
      : normalizeCreateBody(body);
    if (activeRoles.has(threadId)) {
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

async function listRoles(stateStore: PersistableStateStore): Promise<
  Array<{ thread_id: string; role_type: string; status: string; task_count: number }>
> {
  const state = await loadState(stateStore);

  return state.roles.map((role) => {
    const config = parseDispatcherConfig(role.config);
    return {
      thread_id: role.threadId,
      role_type: role.roleType,
      status: role.status,
      task_count: config?.tasks.length ?? 0
    };
  });
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

  const response: RoleDetailResponse = {
    thread_id: role.threadId,
    role_type: role.roleType,
    status: role.status,
    taskspec: config?.taskspec,
    system_prompt: config?.system_prompt,
    tasks: (config?.tasks ?? []).map((task) => ({
      task_id: task.task_id,
      status: task.status,
      depends_on: [...task.depends_on],
      trace_id: task.result_trace_id?.slice(0, 8),
      result_summary: task.result_summary,
      instruction: task.instruction
    }))
  };

  if (role.roleType !== "agent-dispatcher") {
    return response;
  }

  const agentDispatcherConfig = parseAgentDispatcherConfig(role.config);
  if (!agentDispatcherConfig) {
    return response;
  }

  const lifecycleState = await loadDispatchLifecycleState(agentDispatcherConfig.dispatch_plan_path, options.log);
  const dispatchPlan = await loadDispatchPlanData(agentDispatcherConfig.dispatch_plan_path, options.log);
  const dispatchPlanRows = dispatchPlan.rows;
  const dispatcherThreadId = resolveDispatcherThreadId(lifecycleState);
  const currentWorker = resolveCurrentWorker(dispatchPlanRows, lifecycleState);
  const currentWorkerEntry = currentWorker ? lifecycleState.workers[currentWorker] ?? null : null;
  const sessionLog = await loadDispatcherSessionLog(
    dispatcherThreadId,
    options.getThreadDetail,
    options.attachToThread,
    {
      currentWorker,
      currentWorkerEntry,
      dispatchPlanPath: agentDispatcherConfig.dispatch_plan_path,
      roleId: role.threadId,
      roleStatus: role.status
    },
    options.log
  );

  return {
    ...response,
    dispatch_plan_path: agentDispatcherConfig.dispatch_plan_path,
    command_file_path: agentDispatcherConfig.command_file_path,
    dispatcher_thread_id: dispatcherThreadId,
    current_worker: currentWorker,
    last_log_line: extractLastLogLine(sessionLog),
    user_reply_channels: agentDispatcherConfig.user_reply_channels.map((replyChannel) => ({ ...replyChannel })),
    agent_type: agentDispatcherConfig.agent_type,
    mode: agentDispatcherConfig.mode,
    kill_policy: agentDispatcherConfig.kill_policy,
    session_log: sessionLog,
    dispatch_details: buildDispatchWorkerDetails(
      lifecycleState,
      dispatchPlanRows,
      dispatchPlan.modelLegend,
      {
        roleId: role.threadId,
        dispatcherThreadId,
        dispatcherAgentType: agentDispatcherConfig.agent_type
      }
    ),
    dispatch_plan: {
      rows: dispatchPlanRows
    }
  };
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

  const roleType = forcedRoleType ?? requestedRoleType ?? "dispatcher";
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
    user_reply_channel:
      parsed.data.user_reply_channel ?? (nestedConfig as { user_reply_channel?: unknown }).user_reply_channel,
    user_reply_channels:
      parsed.data.user_reply_channels ?? (nestedConfig as { user_reply_channels?: unknown }).user_reply_channels,
    agent_type: parsed.data.agent_type ?? (nestedConfig as { agent_type?: unknown }).agent_type,
    mode: parsed.data.mode ?? (nestedConfig as { mode?: unknown }).mode,
    kill_policy: parsed.data.kill_policy ?? (nestedConfig as { kill_policy?: unknown }).kill_policy,
    use_agent_dispatcher:
      parsed.data.use_agent_dispatcher
      ?? (nestedConfig as { use_agent_dispatcher?: unknown }).use_agent_dispatcher
  };

  const config = (roleType === "agent-dispatcher" || shouldUseAgentDispatcherConfig(rawConfig))
    ? AgentDispatcherConfigSchema.safeParse(rawConfig)
    : DispatcherConfigSchema.safeParse(rawConfig);
  if (!config.success) {
    throw createHttpError(400, "Invalid dispatcher config");
  }

  return {
    threadId,
    roleType,
    config: config.data
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
  const eligibleStatuses = new Set([ACTIVE_ROLE_STATUS, PAUSED_ROLE_STATUS, NEEDS_REACTIVATION_ROLE_STATUS]);

  for (const role of state.roles) {
    if (role.roleType !== "agent-dispatcher" || !eligibleStatuses.has(role.status)) {
      continue;
    }

    const config = parseAgentDispatcherConfig(role.config);
    if (config) {
      return config;
    }
  }

  return null;
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

interface DispatcherRoleConfigContext {
  roleType: "dispatcher";
  state: AppState;
  roleState: RoleState | null;
  activeConfig: DispatcherConfig | null;
  persistedConfig: DispatcherConfig | null;
  effectiveConfig: DispatcherConfig;
  status: string;
}

interface AgentDispatcherRoleConfigContext {
  roleType: "agent-dispatcher";
  state: AppState;
  roleState: RoleState | null;
  activeConfig: AgentDispatcherConfig | null;
  persistedConfig: AgentDispatcherConfig | null;
  effectiveConfig: AgentDispatcherConfig;
  status: string;
}

type RoleConfigContext = DispatcherRoleConfigContext | AgentDispatcherRoleConfigContext;

async function loadRoleConfigContext(
  threadId: string,
  stateStore: PersistableStateStore,
  activeRoles: ReadonlyMap<string, PromptStoreRoleBinding>
): Promise<RoleConfigContext> {
  const state = await loadState(stateStore);
  const roleState = state.roles.find((role) => role.threadId === threadId) ?? null;
  const activeRole = activeRoles.get(threadId) ?? null;
  const resolvedRoleType = activeRole?.roleType === "agent-dispatcher" || roleState?.roleType === "agent-dispatcher"
    ? "agent-dispatcher"
    : activeRole?.roleType === "dispatcher" || roleState?.roleType === "dispatcher"
      ? "dispatcher"
      : null;

  if (!resolvedRoleType) {
    throw createHttpError(404, `Role not found for thread_id=${threadId}`);
  }

  if (resolvedRoleType === "agent-dispatcher") {
    const activeConfig = parseMutableAgentDispatcherConfig(activeRole?.config);
    const persistedConfig = roleState ? parseMutableAgentDispatcherConfig(roleState.config) : null;
    const effectiveConfig = activeConfig ?? persistedConfig;

    if (!effectiveConfig) {
      throw createHttpError(500, `Invalid agent dispatcher config for thread_id=${threadId}`);
    }

    return {
      roleType: resolvedRoleType,
      state,
      roleState,
      activeConfig,
      persistedConfig,
      effectiveConfig,
      status: roleState?.status ?? "active"
    };
  }

  const activeConfig = parseMutableDispatcherConfig(activeRole?.config);
  const persistedConfig = roleState ? parseMutableDispatcherConfig(roleState.config) : null;
  const effectiveConfig = activeConfig ?? persistedConfig;

  if (!effectiveConfig) {
    throw createHttpError(500, `Invalid dispatcher config for thread_id=${threadId}`);
  }

  return {
    roleType: resolvedRoleType,
    state,
    roleState,
    activeConfig,
    persistedConfig,
    effectiveConfig,
    status: roleState?.status ?? "active"
  };
}

function upsertDispatcherRoleState(
  state: AppState,
  roleState: RoleState | null,
  threadId: string,
  config: DispatcherConfig
): void {
  const persistedConfig = cloneDispatcherConfig(config);

  if (roleState) {
    roleState.roleType = "dispatcher";
    roleState.status = "active";
    roleState.config = persistedConfig;
    return;
  }

  state.roles.push({
    threadId,
    roleType: "dispatcher",
    config: persistedConfig,
    status: "active"
  });
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

  if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "role") {
    return { kind: "create-role" };
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

  return {
    system_prompt: buildSystemPrompt({
      dispatch_plan_path: parsed.data.dispatch_plan_path ?? "/abs/path/to/dispatch_plan.md",
      command_file_path: parsed.data.command_file_path ?? "/abs/path/to/agent_dispatch_command.md",
      user_reply_channels: JSON.stringify(userReplyChannels),
      default_agent_type: parsed.data.agent_type ?? "claude",
      default_mode: parsed.data.mode ?? "bridge",
      kill_policy: parsed.data.kill_policy ?? "always"
    })
  };
}

function getDispatcherConfigEditBlockedReason(): string {
  return "Cannot edit dispatcher config while tasks are running";
}

function getAgentDispatcherConfigEditBlockedReason(): string {
  return "Agent dispatcher launch config is view-only here. Start a new dispatcher to change launch settings.";
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

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

async function loadDispatchLifecycleState(dispatchPlanPath: string, log: Logger): Promise<DispatchThreadStateV2> {
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
      last_reconciled_at: null
    };
  }
}

async function loadDispatchPlanData(dispatchPlanPath: string, log: Logger): Promise<DispatchPlanData> {
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

async function loadDispatcherSessionLog(
  dispatcherThreadId: string | null,
  getThreadDetail: ((threadId: string) => Promise<string>) | undefined,
  attachToThread: ((threadId: string) => Promise<void>) | undefined,
  fallbackContext: {
    currentWorker: string | null;
    currentWorkerEntry: DispatchWorkerState | null;
    dispatchPlanPath: string;
    roleId: string;
    roleStatus: string;
  },
  log: Logger
): Promise<string[]> {
  const fallbackLog = buildFallbackSessionLog(fallbackContext, dispatcherThreadId);
  if (!dispatcherThreadId || !getThreadDetail) {
    return fallbackLog;
  }

  if (attachToThread) {
    try {
      await attachToThread(dispatcherThreadId);
    } catch (error) {
      log.warn("Failed to attach dispatcher session before detail fetch", {
        thread_id: dispatcherThreadId,
        role_id: fallbackContext.roleId,
        error: getErrorMessage(error)
      });
    }
  }

  try {
    const detail = await getThreadDetail(dispatcherThreadId);
    const lines = splitLogLines(detail);
    if (isEmptyCachedDetailResponse(lines)) {
      return buildEmptyCachedDetailLog(fallbackContext, dispatcherThreadId);
    }
    return lines.length > 0 ? lines : fallbackLog;
  } catch (error) {
    log.warn("Failed to fetch dispatcher session detail", {
      dispatcherThreadId,
      error: getErrorMessage(error)
    });
    return fallbackLog;
  }
}

function resolveDispatcherThreadId(lifecycleState: DispatchThreadStateV2): string | null {
  return lifecycleState.dispatcher.thread_id ?? null;
}

function buildDispatchWorkerDetails(
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

  return Object.entries(lifecycleState.workers)
    .sort((left, right) => Date.parse(left[1].started_at) - Date.parse(right[1].started_at))
    .map(([workerId, worker]) => {
      const dispatchPlanRow = dispatchPlanByWorker.get(workerId);
      const conversation = parseDispatchConversation(worker.hub_result?.details_text);
      const commandFallback = conversation.command ?? worker.command_preamble ?? null;
      const replyContent = resolveDispatchReply(worker.hub_result, conversation.reply);
      const appliedModel = resolveAppliedModel(dispatchPlanRow?.model ?? null, modelLegend);

      return {
        worker_id: workerId,
        status: worker.status,
        task: dispatchPlanRow?.task ?? null,
        model: dispatchPlanRow?.model ?? null,
        applied_model: appliedModel,
        worker_thread_id: worker.thread_id,
        trace_id: worker.hub_result?.trace_id ?? worker.trace_id,
        command: commandFallback
          ? {
              trace_id: worker.trace_id,
              sender_name: context.dispatcherThreadId ?? context.roleId,
              sender_agent_type: context.dispatcherAgentType,
              sender_model: null,
              sender_thread_id: context.dispatcherThreadId,
              timestamp: worker.started_at,
              content: commandFallback
            }
          : null,
        reply: replyContent
          ? {
              trace_id: worker.hub_result?.trace_id ?? worker.trace_id,
              sender_name: worker.hub_result?.thread_id ?? worker.thread_id,
              sender_agent_type: worker.hub_result?.source ?? null,
              sender_model: appliedModel,
              sender_thread_id: worker.hub_result?.thread_id ?? worker.thread_id,
              timestamp: worker.hub_result?.timestamp ?? worker.last_seen_at,
              content: replyContent
            }
          : null
      };
    });
}

function parseDispatchConversation(detailsText: string | undefined): { command: string | null; reply: string | null } {
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

function normalizeConversationSection(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveCurrentWorker(rows: DispatchPlanRow[], trackerState: DispatchThreadStateV2): string | null {
  const inProgressWorker = rows.find((row) => row.status === "🔄")?.worker;
  if (inProgressWorker) {
    return inProgressWorker;
  }

  const trackedWorkers = Object.entries(trackerState.workers)
    .filter(([, worker]) => worker.status === "running")
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
    dispatchPlanPath: string;
    roleStatus: string;
  },
  dispatcherThreadId: string | null
): string[] {
  return [
    ...buildFallbackSessionLog(context, dispatcherThreadId),
    "Dispatcher detail cache is empty. Send a new request to the dispatcher, then refresh this page."
  ];
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
        model_id: readOptionalTableCell(rowCells[columnIndex.model_id])
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
  const task = normalizedHeaders.indexOf("task");
  const model = normalizedHeaders.indexOf("model");
  const dependsOn = normalizedHeaders.indexOf("depends_on");

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
    prds_to_attach: normalizedHeaders.indexOf("prds_to_attach"),
    notes: normalizedHeaders.indexOf("notes")
  };
}

function indexDispatchModelLegendColumns(headerCells: string[]): {
  code: number;
  provider: number;
  model_id: number;
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
    model_id: modelId
  };
}

function resolveAppliedModel(modelCode: string | null, modelLegend: DispatchPlanModelLegend): string | null {
  if (!modelCode) {
    return null;
  }

  const resolved = modelLegend[modelCode]?.model_id;
  return typeof resolved === "string" && resolved.trim().length > 0 ? resolved.trim() : null;
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
        socket.write(JSON.stringify(message));
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
