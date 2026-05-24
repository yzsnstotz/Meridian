import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

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
import { ensureCodexTrustEntry, llmAgentKindUsesCodexTrust } from "./codex-auto-trust";
import {
  ChatterStateStore,
  type ChatterProvisionError,
  type ChatterTurnError
} from "../roles/chatter/chatter-state-store";
import { incrementMumuArchiveProvisionTotal } from "../roles/chatter/observability";
import {
  getDefaultMumuMemoryGitSyncQueue,
  type MumuMemoryGitEventKind,
  type MumuMemoryRemoteArchive,
  type MumuMemoryGitSyncQueueLike
} from "../roles/chatter/mumu-memory-git-sync";
import {
  MumuMemorySavepointError,
  createMumuMemorySavepoint,
  listMumuMemorySavepoints,
  readMumuMemorySnapshot,
  type MumuMemorySavepointSyncStatus
} from "../roles/chatter/mumu-memory-savepoints";
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
  memoryGitSyncQueue?: MumuMemoryGitSyncQueueLike;
}

type AutoProvisionerRoute =
  | { action: "ensure"; projectId: string; userId: string }
  | { action: "archive"; projectId: string; userId: string }
  | { action: "get"; projectId: string; userId: string }
  | { action: "memory-archive-enqueue"; projectId: string; userId: string }
  | { action: "memory-savepoint-create"; projectId: string; userId: string }
  | { action: "memory-savepoint-list"; projectId: string; userId: string }
  | { action: "memory-savepoint-read"; projectId: string; userId: string; savepointId: string };

const EmptyAutoProvisionerBodySchema = z.object({}).strict();
const ArchiveRemoteSchema = z.object({
  push_enabled: z.boolean(),
  state: z.enum(["ready", "blocked", "disabled"]),
  owner: z.string().min(1),
  repo_name: z.string().min(1),
  repo_full_name: z.string().min(1),
  private: z.boolean().nullable(),
  status_callback_url: z.string().url().optional()
}).strict();
const ArchiveEnqueueBodySchema = z.object({
  event_kind: z.enum(["structured_write", "structured_delete", "turn_write", "direct_write", "restore_write"]),
  repo_root: z.string().min(1).optional(),
  record_type: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  archive: ArchiveRemoteSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (
    (value.event_kind === "structured_write"
      || value.event_kind === "structured_delete"
      || value.event_kind === "direct_write"
      || value.event_kind === "restore_write")
    && (!value.record_type || !value.key)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "record_type and key are required for structured archive events"
    });
  }
});
const SavepointCreateBodySchema = z.object({
  label: z.string().max(160).optional(),
  archive: ArchiveRemoteSchema.optional()
}).strict();
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
        if (route.action !== "memory-archive-enqueue" && route.action !== "memory-savepoint-create") {
          validateEmptyBody(request as CallerAuthenticatedRequest);
        }

        switch (route.action) {
          case "ensure": {
            const result = await ensureChatterWithTelemetry(route.projectId, route.userId);
            writeJson(response, 200, result);
            return true;
          }
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
          case "memory-archive-enqueue":
            writeJson(
              response,
              200,
              await enqueueMemoryArchive(route.projectId, route.userId, request as CallerAuthenticatedRequest)
            );
            return true;
          case "memory-savepoint-create":
            writeJson(
              response,
              200,
              await createMemorySavepoint(route.projectId, route.userId, request as CallerAuthenticatedRequest)
            );
            return true;
          case "memory-savepoint-list":
            writeJson(response, 200, await listMemorySavepoints(route.projectId, route.userId));
            return true;
          case "memory-savepoint-read":
            writeJson(response, 200, await readMemorySavepoint(route.projectId, route.userId, route.savepointId));
            return true;
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
        if (error instanceof MumuMemorySavepointError) {
          writeJson(response, statusForSavepointError(error), { error: publicSavepointErrorCode(error) });
          return true;
        }

        writeJson(response, 500, { error: getErrorMessage(error) });
        return true;
      }
    }
  };

  async function ensureChatterWithTelemetry(
    projectId: string,
    userId: string
  ): Promise<{ thread_id: string; status: "existing" | "created" }> {
    try {
      const result = await ensureChatter(projectId, userId);
      incrementMumuArchiveProvisionTotal(result.status);
      return result;
    } catch (error) {
      incrementMumuArchiveProvisionTotal("error");
      throw error;
    }
  }

  async function ensureChatter(
    projectId: string,
    userId: string
  ): Promise<{ thread_id: string; status: "existing" | "created" }> {
    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);

    const existing = await findChatter(interpolated.thread_id);
    if (existing) {
      new ChatterStateStore(interpolated.memory_folder).clearProvisionError();
      return { thread_id: interpolated.thread_id, status: "existing" };
    }

    return withEnsureLock(interpolated.thread_id, async () => {
      const rechecked = await findChatter(interpolated.thread_id);
      if (rechecked) {
        new ChatterStateStore(interpolated.memory_folder).clearProvisionError();
        return { thread_id: interpolated.thread_id, status: "existing" };
      }

      const body = buildChatterCreateBody(interpolated);

      try {
        await fs.mkdir(interpolated.memory_folder, { recursive: true });
        // Append a `[projects."<memory_folder>"]` block to ~/.codex/config.toml
        // when the chatter is codex-backed, so the first turn doesn't hang
        // at codex's "Do you trust this directory?" prompt. Belt-and-
        // suspenders today (the hub spawns codex with
        // --dangerously-bypass-approvals-and-sandbox which masks the prompt
        // anyway), but cheap insurance for when the sandbox tightens.
        // Idempotent + never-throws — see codex-auto-trust.ts.
        if (llmAgentKindUsesCodexTrust(interpolated.llm_agent_kind)) {
          await ensureCodexTrustEntry({
            memoryFolder: interpolated.memory_folder,
            disabled: process.env.MUMU_DISABLE_CODEX_AUTO_TRUST?.toLowerCase() === "true"
          });
        }
        await options.createRole(body);
      } catch (error) {
        if (!isHttpError(error) || error.statusCode >= 500) {
          const upstreamStatus = isHttpError(error) ? error.statusCode : 500;
          new ChatterStateStore(interpolated.memory_folder).recordProvisionError(
            "role_creation_failed",
            error
          );
          throw createHttpError(upstreamStatus, "role_creation_failed", {
            error: "role_creation_failed",
            upstream_status: upstreamStatus
          });
        }
        throw error;
      }

      await persistChatterRole(interpolated.thread_id, body.config, "active");
      new ChatterStateStore(interpolated.memory_folder).clearProvisionError();
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
  ): Promise<{
    thread_id: string;
    status: string;
    last_active_at?: string;
    last_provision_error?: ChatterProvisionError;
    last_turn_error?: ChatterTurnError;
  } | null> {
    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);
    const existing = await findChatter(interpolated.thread_id);
    if (!existing) {
      return null;
    }

    const chatterState = new ChatterStateStore(interpolated.memory_folder).load();
    return {
      thread_id: interpolated.thread_id,
      status: existing.status,
      ...(chatterState.last_provision_error ? { last_provision_error: chatterState.last_provision_error } : {}),
      ...(chatterState.last_turn_error ? { last_turn_error: chatterState.last_turn_error } : {})
    };
  }

  async function enqueueMemoryArchive(
    projectId: string,
    userId: string,
    request: CallerAuthenticatedRequest
  ): Promise<{ queued: true }> {
    const rawBody = request.body_bytes ?? Buffer.alloc(0);
    const parsed = ArchiveEnqueueBodySchema.safeParse(rawBody.length === 0 ? {} : parseJsonBody(rawBody));
    if (!parsed.success) {
      throw createHttpError(422, "invalid_archive_enqueue_body", {
        error: "invalid_archive_enqueue_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message
        }))
      });
    }

    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);
    if (
      parsed.data.repo_root
      && path.resolve(parsed.data.repo_root) !== path.resolve(interpolated.memory_folder)
    ) {
      throw createHttpError(422, "repo_root_mismatch", { error: "repo_root_mismatch" });
    }

    const queue = options.memoryGitSyncQueue ?? getDefaultMumuMemoryGitSyncQueue();
    queue.enqueue({
      memoryRoot: interpolated.memory_folder,
      userId,
      eventKind: parsed.data.event_kind as MumuMemoryGitEventKind,
      source: "ads_direct",
      ...(parsed.data.record_type ? { recordType: parsed.data.record_type } : {}),
      ...(parsed.data.key ? { key: parsed.data.key } : {}),
      ...(parsed.data.archive ? { remoteArchive: parsed.data.archive as MumuMemoryRemoteArchive } : {})
    });
    return { queued: true };
  }

  async function createMemorySavepoint(
    projectId: string,
    userId: string,
    request: CallerAuthenticatedRequest
  ): Promise<{ ok: true; savepoint: Awaited<ReturnType<typeof createMumuMemorySavepoint>>; queued: boolean }> {
    const rawBody = request.body_bytes ?? Buffer.alloc(0);
    const parsed = SavepointCreateBodySchema.safeParse(rawBody.length === 0 ? {} : parseJsonBody(rawBody));
    if (!parsed.success) {
      throw createHttpError(422, "invalid_savepoint_create_body", {
        error: "invalid_savepoint_create_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message
        }))
      });
    }

    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);
    const savepoint = await createMumuMemorySavepoint(interpolated.memory_folder, {
      label: parsed.data.label,
      syncStatus: syncStatusForArchive(parsed.data.archive)
    });

    if (parsed.data.archive) {
      const queue = options.memoryGitSyncQueue ?? getDefaultMumuMemoryGitSyncQueue();
      queue.enqueue({
        memoryRoot: interpolated.memory_folder,
        userId,
        eventKind: "direct_write",
        source: "ads_direct",
        recordType: "savepoint",
        key: savepoint.id,
        remoteArchive: parsed.data.archive as MumuMemoryRemoteArchive
      });
    }

    return { ok: true, savepoint, queued: Boolean(parsed.data.archive) };
  }

  async function listMemorySavepoints(
    projectId: string,
    userId: string
  ): Promise<{ ok: true; savepoints: Awaited<ReturnType<typeof listMumuMemorySavepoints>> }> {
    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);
    return { ok: true, savepoints: await listMumuMemorySavepoints(interpolated.memory_folder) };
  }

  async function readMemorySavepoint(
    projectId: string,
    userId: string,
    savepointId: string
  ): Promise<{ ok: true; snapshot: Awaited<ReturnType<typeof readMumuMemorySnapshot>> }> {
    const policy = await loadProjectPolicy(projectId, { repoRoot: options.repoRoot });
    const interpolated = interpolatePolicyForUser(policy, userId);
    return { ok: true, snapshot: await readMumuMemorySnapshot(interpolated.memory_folder, savepointId) };
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

  if (
    (parts.length !== 6 && parts.length !== 7 && parts.length !== 8)
    || parts[0] !== "api"
    || parts[1] !== "projects"
    || parts[3] !== "users"
  ) {
    return null;
  }

  if (parts.length === 6 && method === "POST" && parts[5] === "ensure-chatter") {
    return { action: "ensure", projectId: parts[2]!, userId: parts[4]! };
  }
  if (parts.length === 6 && method === "POST" && parts[5] === "archive-chatter") {
    return { action: "archive", projectId: parts[2]!, userId: parts[4]! };
  }
  if (parts.length === 6 && method === "GET" && parts[5] === "chatter") {
    return { action: "get", projectId: parts[2]!, userId: parts[4]! };
  }
  if (
    parts.length === 7
    && method === "POST"
    && parts[5] === "memory-archive"
    && parts[6] === "enqueue"
  ) {
    return { action: "memory-archive-enqueue", projectId: parts[2]!, userId: parts[4]! };
  }
  if (
    parts.length === 7
    && method === "POST"
    && parts[5] === "memory-archive"
    && parts[6] === "savepoints"
  ) {
    return { action: "memory-savepoint-create", projectId: parts[2]!, userId: parts[4]! };
  }
  if (
    parts.length === 7
    && method === "GET"
    && parts[5] === "memory-archive"
    && parts[6] === "savepoints"
  ) {
    return { action: "memory-savepoint-list", projectId: parts[2]!, userId: parts[4]! };
  }
  if (
    parts.length === 8
    && method === "GET"
    && parts[5] === "memory-archive"
    && parts[6] === "savepoints"
  ) {
    return { action: "memory-savepoint-read", projectId: parts[2]!, userId: parts[4]!, savepointId: parts[7]! };
  }

  return null;
}

function syncStatusForArchive(archive: MumuMemoryRemoteArchive | undefined): MumuMemorySavepointSyncStatus {
  if (!archive) {
    return "local";
  }
  if (!archive.push_enabled) {
    return "paused";
  }
  if (archive.state !== "ready" || archive.private === false) {
    return "blocked";
  }
  return "pending";
}

function statusForSavepointError(error: MumuMemorySavepointError): number {
  if (error.code === "no_archive_commit") {
    return 409;
  }
  return 404;
}

function publicSavepointErrorCode(error: MumuMemorySavepointError): string {
  return error.code === "invalid_savepoint_id" ? "savepoint_not_found" : error.code;
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
