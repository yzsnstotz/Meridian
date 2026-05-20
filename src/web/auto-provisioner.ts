import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  ForbiddenProjectError,
  assertCallerMayAccessProject,
  requireCallerAuth,
  type CallerAuthMiddleware,
  type CallerAuthenticatedRequest
} from "./caller-auth-middleware";
import {
  ProjectNotRegisteredError,
  interpolatePolicyForUser,
  loadProjectPolicy
} from "./project-policy-loader";
import type { InterpolatedProjectPolicy } from "./project-policy-schema";
import { AppStateSchema, type AppState, type ChatterRoleConfig } from "../types";

type PersistableStateStore = {
  load(): Promise<AppState | null>;
  save(state: AppState): Promise<void>;
};

export interface AutoProvisionerHandlers {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export interface AutoProvisionerHandlersOptions {
  stateStore: PersistableStateStore;
  createRole(body: unknown): Promise<unknown>;
  deactivateRole(threadId: string): Promise<void>;
  resolveActiveRole?: (threadId: string) => { roleType?: string; config?: unknown } | null;
  callerAuth?: CallerAuthMiddleware;
  repoRoot?: string;
}

type AutoProvisionerRoute =
  | { action: "ensure"; projectId: string; userId: string }
  | { action: "archive"; projectId: string; userId: string }
  | { action: "get"; projectId: string; userId: string };

const EmptyAutoProvisionerBodySchema = z.object({}).strict();
const EMPTY_APP_STATE: AppState = { roles: [], promptStore: {} };
const ensureLocks = new Map<string, Promise<unknown>>();

export function createAutoProvisionerHandlers(options: AutoProvisionerHandlersOptions): AutoProvisionerHandlers {
  const callerAuth = options.callerAuth ?? requireCallerAuth;

  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const route = matchAutoProvisionerRoute(request);
      if (!route) {
        return false;
      }

      let authNextCalled = false;
      let authNextError: unknown;
      await callerAuth(request as CallerAuthenticatedRequest, response, (error?: unknown) => {
        authNextCalled = true;
        authNextError = error;
      }).catch((error) => {
        authNextCalled = true;
        authNextError = error;
      });

      if (authNextError) {
        writeJson(response, 500, { error: getErrorMessage(authNextError) });
        return true;
      }

      if (response.headersSent || !authNextCalled) {
        return true;
      }

      try {
        const callerId = (request as CallerAuthenticatedRequest).caller?.caller_id;
        if (!callerId) {
          writeJson(response, 401, { error: "denied_caller_auth", reason: "missing_caller" });
          return true;
        }

        assertCallerMayAccessProject(callerId, route.projectId);
        validateEmptyBody(request as CallerAuthenticatedRequest);

        switch (route.action) {
          case "ensure":
            writeJson(response, 200, await ensureChatter(route.projectId, route.userId));
            return true;
          case "archive":
            writeJson(response, 200, await archiveChatter(route.projectId, route.userId));
            return true;
          case "get": {
            const result = await getChatter(route.projectId, route.userId);
            if (!result) {
              writeJson(response, 404, { error: "chatter_not_found" });
              return true;
            }
            writeJson(response, 200, result);
            return true;
          }
        }
      } catch (error) {
        if (error instanceof ForbiddenProjectError) {
          writeJson(response, 403, { error: "forbidden_project" });
          return true;
        }
        if (error instanceof ProjectNotRegisteredError) {
          writeJson(response, 404, { error: "project_not_registered" });
          return true;
        }
        if (error instanceof CallerPolicyOverrideError) {
          writeJson(response, 422, {
            error: "denied_caller_policy_override",
            offending_keys: error.offendingKeys
          });
          return true;
        }
        if (isHttpError(error)) {
          writeJson(response, error.statusCode, error.publicBody ?? { error: error.message });
          return true;
        }

        writeJson(response, 500, { error: getErrorMessage(error) });
        return true;
      }
    }
  };

  async function ensureChatter(
    projectId: string,
    userId: string
  ): Promise<{ thread_id: string; status: "existing" | "created" }> {
    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);

    const existing = await findChatter(interpolated.thread_id);
    if (existing) {
      return { thread_id: interpolated.thread_id, status: "existing" };
    }

    return withEnsureLock(interpolated.thread_id, async () => {
      const rechecked = await findChatter(interpolated.thread_id);
      if (rechecked) {
        return { thread_id: interpolated.thread_id, status: "existing" };
      }

      const body = buildChatterCreateBody(interpolated);

      try {
        await fs.mkdir(interpolated.memory_folder, { recursive: true });
        await options.createRole(body);
      } catch (error) {
        if (!isHttpError(error) || error.statusCode >= 500) {
          const upstreamStatus = isHttpError(error) ? error.statusCode : 500;
          throw createHttpError(upstreamStatus, "role_creation_failed", {
            error: "role_creation_failed",
            upstream_status: upstreamStatus
          });
        }
        throw error;
      }

      await persistChatterRole(interpolated.thread_id, body.config, "active");
      return { thread_id: interpolated.thread_id, status: "created" };
    });
  }

  async function archiveChatter(projectId: string, userId: string): Promise<{ archived: boolean }> {
    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);
    const existing = await findChatter(interpolated.thread_id);
    if (!existing) {
      return { archived: false };
    }

    await options.deactivateRole(interpolated.thread_id);
    await removeChatterRole(interpolated.thread_id);
    return { archived: true };
  }

  async function getChatter(
    projectId: string,
    userId: string
  ): Promise<{ thread_id: string; status: string; last_active_at?: string } | null> {
    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);
    const existing = await findChatter(interpolated.thread_id);
    if (!existing) {
      return null;
    }

    return {
      thread_id: interpolated.thread_id,
      status: existing.status
    };
  }

  async function findChatter(threadId: string): Promise<{ status: string } | null> {
    const activeRole = options.resolveActiveRole?.(threadId);
    if (activeRole?.roleType === "chatter") {
      return { status: "active" };
    }

    const state = await loadState();
    const role = state.roles.find((entry) => entry.threadId === threadId && entry.roleType === "chatter");
    return role ? { status: role.status } : null;
  }

  async function persistChatterRole(threadId: string, config: ChatterRoleConfig, status: string): Promise<void> {
    const state = await loadState();
    const roles = state.roles.filter((role) => role.threadId !== threadId);
    roles.push({
      threadId,
      roleType: "chatter",
      config,
      status
    });
    await options.stateStore.save(AppStateSchema.parse({ roles, promptStore: state.promptStore }));
  }

  async function removeChatterRole(threadId: string): Promise<void> {
    const state = await loadState();
    await options.stateStore.save(AppStateSchema.parse({
      roles: state.roles.filter((role) => !(role.threadId === threadId && role.roleType === "chatter")),
      promptStore: state.promptStore
    }));
  }

  async function loadState(): Promise<AppState> {
    return AppStateSchema.parse((await options.stateStore.load()) ?? EMPTY_APP_STATE);
  }
}

function validateEmptyBody(request: CallerAuthenticatedRequest): void {
  const rawBody = request.body_bytes ?? Buffer.alloc(0);
  const body = rawBody.length === 0 ? {} : parseJsonBody(rawBody);
  const parsed = EmptyAutoProvisionerBodySchema.safeParse(body);
  if (parsed.success) {
    return;
  }

  throw new CallerPolicyOverrideError(readOffendingKeys(body));
}

function parseJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw createHttpError(400, "Request body must be valid JSON");
  }
}

function readOffendingKeys(body: unknown): string[] {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return Object.keys(body);
  }
  return [];
}

function buildChatterCreateBody(policy: InterpolatedProjectPolicy): {
  role_type: "chatter";
  thread_id: string;
  config: ChatterRoleConfig;
} {
  const seedsInit = buildChatterSeedsInit(policy);
  return {
    role_type: "chatter",
    thread_id: policy.thread_id,
    config: {
      chatter_id: policy.thread_id,
      memory_folder: policy.memory_folder,
      manifest_path: policy.manifest_path,
      allowed_modes: policy.allowed_modes,
      skill_allowlist: policy.skill_allowlist,
      llm_agent_kind: policy.llm_agent_kind,
      ...(policy.credential_id ? { credential_id: policy.credential_id } : {}),
      ...(seedsInit ? { seeds_init: seedsInit } : {}),
      user_reply_channel: policy.user_reply_channel
    }
  };
}

function buildChatterSeedsInit(policy: InterpolatedProjectPolicy): ChatterRoleConfig["seeds_init"] | undefined {
  if (policy.seeds_init.mode !== "copy_on_provision") {
    return undefined;
  }
  const sourcePath = policy.seeds_init.source_path ?? policy.seeds_source_path;
  return {
    mode: "copy_on_provision",
    ...(sourcePath ? { source_path: sourcePath } : {})
  };
}

async function withEnsureLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
  const previous = ensureLocks.get(threadId) ?? Promise.resolve();
  const current = (async () => {
    await previous.catch(() => undefined);
    return operation();
  })();
  ensureLocks.set(threadId, current);
  try {
    return await current;
  } finally {
    if (ensureLocks.get(threadId) === current) {
      ensureLocks.delete(threadId);
    }
  }
}

function matchAutoProvisionerRoute(request: IncomingMessage): AutoProvisionerRoute | null {
  const method = request.method?.toUpperCase();
  const url = request.url;
  if (!method || !url) {
    return null;
  }

  const parts = new URL(url, "http://127.0.0.1").pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  if (parts.length !== 6 || parts[0] !== "api" || parts[1] !== "projects" || parts[3] !== "users") {
    return null;
  }

  if (method === "POST" && parts[5] === "ensure-chatter") {
    return { action: "ensure", projectId: parts[2]!, userId: parts[4]! };
  }
  if (method === "POST" && parts[5] === "archive-chatter") {
    return { action: "archive", projectId: parts[2]!, userId: parts[4]! };
  }
  if (method === "GET" && parts[5] === "chatter") {
    return { action: "get", projectId: parts[2]!, userId: parts[4]! };
  }

  return null;
}

class CallerPolicyOverrideError extends Error {
  constructor(readonly offendingKeys: string[]) {
    super("denied_caller_policy_override");
    this.name = "CallerPolicyOverrideError";
  }
}

function createHttpError(statusCode: number, message: string, publicBody?: unknown): Error & { statusCode: number; publicBody?: unknown } {
  const error = new Error(message) as Error & { statusCode: number; publicBody?: unknown };
  error.statusCode = statusCode;
  error.publicBody = publicBody;
  return error;
}

function isHttpError(error: unknown): error is Error & { statusCode: number; publicBody?: unknown } {
  return error instanceof Error && typeof (error as { statusCode?: unknown }).statusCode === "number";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (!response.headersSent) {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
  }
  response.end(`${JSON.stringify(body)}\n`);
}
