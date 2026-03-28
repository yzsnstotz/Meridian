import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  applyEditableDispatcherConfig,
  cloneDispatcherConfig,
  hasRunningDispatcherTask,
  mergeEditableDispatcherConfig,
  parseMutableDispatcherConfig,
  toEditableDispatcherConfig
} from "../roles/dispatcher-config-editor";
import type { PromptStoreRoleBinding } from "../roles/prompt-store";
import { RoleRegistry } from "../roles/role-registry";
import { RoleRunner } from "../roles/role-runner";
import { StateStore } from "../state-store";
import {
  AppStateSchema,
  DispatchTaskSchema,
  DispatcherConfigSchema,
  DispatcherEditorConfigPatchSchema,
  ReplyChannelSchema,
  RoleTypeSchema,
  type AppState,
  type DispatcherConfig,
  type DispatcherEditorConfig,
  type RoleType,
  type RoleState
} from "../types";
import type { Logger } from "../roles/base-role";

type PersistableStateStore = Pick<StateStore, "load" | "save">;

const CreateRoleBodySchema = z.object({
  thread_id: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  role_type: RoleTypeSchema.optional(),
  roleType: RoleTypeSchema.optional(),
  tasks: z.array(DispatchTaskSchema).optional(),
  taskspec: z.string().optional(),
  system_prompt: z.string().optional(),
  user_reply_channel: ReplyChannelSchema.optional(),
  config: z.unknown().optional()
});

type RoleRouteMatch =
  | { kind: "list-roles" }
  | { kind: "get-role"; threadId: string }
  | { kind: "get-config"; threadId: string }
  | { kind: "create-role" }
  | { kind: "patch-config"; threadId: string }
  | { kind: "delete-role"; threadId: string };

export interface RoleHandlersOptions {
  runner: RoleRunner;
  registry: RoleRegistry;
  stateStore?: PersistableStateStore;
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
  config: DispatcherEditorConfig;
}

export function createRoleHandlers(options: RoleHandlersOptions): RoleHandlers {
  const stateStore = options.stateStore ?? new StateStore();
  const log = options.log ?? console;
  const activeRoles = new Map<string, PromptStoreRoleBinding>();

  const handlers: RoleHandlers = {
    async getConfig(threadId: string): Promise<RoleConfigResponse> {
      const context = await loadRoleConfigContext(threadId, stateStore, activeRoles);
      const canEdit = !hasRunningDispatcherTask(context.effectiveConfig);

      return {
        thread_id: threadId,
        status: context.status,
        can_edit: canEdit,
        blocked_reason: canEdit ? undefined : getConfigEditBlockedReason(),
        config: toEditableDispatcherConfig(context.effectiveConfig)
      };
    },
    async patchConfig(threadId: string, body: unknown): Promise<RoleConfigResponse> {
      const parsed = DispatcherEditorConfigPatchSchema.safeParse(body);
      if (!parsed.success) {
        throw createHttpError(400, "Invalid dispatcher config edit payload");
      }

      const context = await loadRoleConfigContext(threadId, stateStore, activeRoles);
      if (hasRunningDispatcherTask(context.effectiveConfig)) {
        throw createHttpError(409, getConfigEditBlockedReason());
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
          case "list-roles":
            writeJson(response, 200, await listRoles(stateStore));
            return true;
          case "get-role":
            writeJson(response, 200, await getRole(stateStore, route.threadId));
            return true;
          case "get-config":
            writeJson(response, 200, await handlers.getConfig(route.threadId));
            return true;
          case "create-role": {
            const created = await createRole(await readJsonBody(request));
            writeJson(response, 201, created);
            return true;
          }
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
    const { threadId, roleType, config } = normalizeCreateBody(body);
    if (activeRoles.has(threadId)) {
      throw createHttpError(409, `Role already active for thread_id=${threadId}`);
    }

    const role = options.registry.create(roleType, threadId, config);
    activeRoles.set(threadId, {
      roleType,
      config: role.config
    });

    try {
      await options.runner.activate(role);
    } catch (error) {
      activeRoles.delete(threadId);
      throw error;
    }

    return { ok: true, thread_id: threadId, role_type: roleType };
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
  threadId: string
): Promise<{
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
}> {
  const state = await loadState(stateStore);
  const role = state.roles.find((entry) => entry.threadId === threadId);
  if (!role) {
    throw createHttpError(404, `Role not found for thread_id=${threadId}`);
  }

  const config = parseDispatcherConfig(role.config);

  return {
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
}

async function loadState(stateStore: PersistableStateStore): Promise<AppState> {
  return AppStateSchema.parse((await stateStore.load()) ?? { roles: [], promptStore: {} });
}

function normalizeCreateBody(body: unknown): {
  threadId: string;
  roleType: RoleType;
  config: DispatcherConfig;
} {
  const parsed = CreateRoleBodySchema.safeParse(body);
  if (!parsed.success) {
    throw createHttpError(400, "Invalid body for role creation");
  }

  const roleType = parsed.data.role_type ?? parsed.data.roleType ?? "dispatcher";
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
    user_reply_channel:
      parsed.data.user_reply_channel ?? (nestedConfig as { user_reply_channel?: unknown }).user_reply_channel
  };

  const config = DispatcherConfigSchema.safeParse(rawConfig);
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

interface RoleConfigContext {
  state: AppState;
  roleState: RoleState | null;
  activeConfig: DispatcherConfig | null;
  persistedConfig: DispatcherConfig | null;
  effectiveConfig: DispatcherConfig;
  status: string;
}

async function loadRoleConfigContext(
  threadId: string,
  stateStore: PersistableStateStore,
  activeRoles: ReadonlyMap<string, PromptStoreRoleBinding>
): Promise<RoleConfigContext> {
  const state = await loadState(stateStore);
  const roleState = state.roles.find((role) => role.threadId === threadId && role.roleType === "dispatcher") ?? null;
  const activeConfig = parseMutableDispatcherConfig(activeRoles.get(threadId)?.config);
  const persistedConfig = roleState ? parseMutableDispatcherConfig(roleState.config) : null;
  const effectiveConfig = activeConfig ?? persistedConfig;

  if (!effectiveConfig) {
    if (roleState || activeRoles.has(threadId)) {
      throw createHttpError(500, `Invalid dispatcher config for thread_id=${threadId}`);
    }

    throw createHttpError(404, `Role not found for thread_id=${threadId}`);
  }

  return {
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

  if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "roles") {
    return { kind: "list-roles" };
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

function getConfigEditBlockedReason(): string {
  return "Cannot edit dispatcher config while tasks are running";
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
