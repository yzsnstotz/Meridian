import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { Logger } from "../roles/base-role";
import { SchedulerRole } from "../roles/definitions/scheduler";
import { RoleRegistry } from "../roles/role-registry";
import { RoleRunner } from "../roles/role-runner";
import { StateStore } from "../state-store";
import {
  AppStateSchema,
  SchedulerConfigSchema,
  type AppState,
  type SchedulerConfig,
  type SchedulerRunState
} from "../types";
import { parseCronExpression, nextCronFire } from "../roles/scheduler/cron-parser";
import { resolveServiceContinueWorker } from "../roles/agent-dispatcher/service-continuation";
import { buildDispatchStatusReport } from "../tool-gateway/tools/dispatch-status";
import { executeResumeWorkerAction, ResumeWorkerActionRequestSchema } from "../tool-gateway/tools/resume-worker";
import { executeUpdateWorkerStatusAction } from "../tool-gateway/tools/update-status";
import {
  buildDispatchWorkerDetails,
  enrichDispatchPlanRows,
  loadDispatchLifecycleState,
  loadDispatchPlanData,
  resolveCurrentWorker
} from "./role-handlers";

type PersistableStateStore = Pick<StateStore, "load" | "save">;

const EMPTY_APP_STATE: AppState = {
  roles: [],
  promptStore: {}
};

type SchedulerRouteMatch =
  | { kind: "create-scheduler" }
  | { kind: "get-scheduler"; threadId: string }
  | { kind: "get-scheduler-runs"; threadId: string }
  | { kind: "patch-scheduler-config"; threadId: string }
  | { kind: "start-schedule"; threadId: string }
  | { kind: "stop-schedule"; threadId: string }
  | { kind: "pause-schedule"; threadId: string }
  | { kind: "resume-schedule"; threadId: string }
  | { kind: "run-now"; threadId: string }
  | { kind: "cancel-run"; threadId: string }
  | { kind: "continue-worker"; threadId: string; workerId: string }
  | { kind: "resume-worker"; threadId: string; workerId: string }
  | { kind: "update-worker-status"; threadId: string; workerId: string }
  | { kind: "delete-scheduler"; threadId: string };

const CreateSchedulerBodySchema = z.object({
  thread_id: z.string().min(1).optional(),
  config: SchedulerConfigSchema
});

const RunNowBodySchema = z.object({
  report_base_dir: z.string().min(1).optional()
}).optional();

const UpdateWorkerStatusRequestSchema = z.object({
  status: z.string().min(1),
  thread_id: z.string().min(1).optional()
});

const NEXT_RUN_PREVIEW_STATUSES = new Set(["idle", "waiting"]);

export interface SchedulerHandlersOptions {
  runner: RoleRunner;
  registry: RoleRegistry;
  stateStore?: PersistableStateStore;
  log?: Logger;
}

export interface SchedulerHandlers {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export function createSchedulerHandlers(options: SchedulerHandlersOptions): SchedulerHandlers {
  const { runner, registry, log = console } = options;
  const stateStore = options.stateStore ?? new StateStore();

  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const route = matchSchedulerRoute(request);
      if (!route) {
        return false;
      }

      try {
        switch (route.kind) {
          case "create-scheduler":
            writeJson(response, 201, await createScheduler(await readJsonBody(request)));
            return true;
          case "get-scheduler":
            writeJson(response, 200, await getScheduler(route.threadId));
            return true;
          case "get-scheduler-runs":
            writeJson(response, 200, await getSchedulerRuns(route.threadId));
            return true;
          case "patch-scheduler-config":
            writeJson(response, 200, await patchSchedulerConfig(route.threadId, await readJsonBody(request)));
            return true;
          case "start-schedule":
            writeJson(response, 200, await startSchedule(route.threadId));
            return true;
          case "stop-schedule":
            writeJson(response, 200, await stopSchedule(route.threadId));
            return true;
          case "pause-schedule":
            writeJson(response, 200, await pauseSchedule(route.threadId));
            return true;
          case "resume-schedule":
            writeJson(response, 200, await resumeSchedule(route.threadId));
            return true;
          case "run-now":
            writeJson(response, 200, await runNow(route.threadId, await readJsonBody(request)));
            return true;
          case "cancel-run":
            writeJson(response, 200, await cancelRun(route.threadId));
            return true;
          case "continue-worker":
            writeJson(response, 200, await continueSchedulerWorker(route.threadId, route.workerId));
            return true;
          case "resume-worker":
            writeJson(response, 200, await resumeSchedulerWorker(route.threadId, route.workerId, await readJsonBody(request)));
            return true;
          case "update-worker-status":
            writeJson(response, 200, await updateSchedulerWorkerStatus(route.threadId, route.workerId, await readJsonBody(request)));
            return true;
          case "delete-scheduler":
            writeJson(response, 200, await deleteScheduler(route.threadId));
            return true;
        }
      } catch (error) {
        log.warn("Scheduler handler request failed", {
          route: route.kind,
          error: getErrorMessage(error)
        });
        writeJson(response, getStatusCode(error), { error: getErrorMessage(error) });
        return true;
      }
    }
  };

  async function createScheduler(body: unknown) {
    const parsed = CreateSchedulerBodySchema.parse(body);
    const threadId = parsed.thread_id ?? `scheduler-${randomUUID().slice(0, 8)}`;
    const config = parsed.config;

    // Validate cron expression if provided
    if (config.scheduler_mode === "cron" && config.cron_expression) {
      parseCronExpression(config.cron_expression);
    }

    const role = registry.create("scheduler", threadId, config);
    await runner.activate(role);

    return {
      ok: true,
      scheduler_id: threadId,
      scheduler_mode: config.scheduler_mode,
      dispatch_plan_path: config.dispatch_plan_path
    };
  }

  async function getScheduler(threadId: string) {
    const role = resolveSchedulerRole(threadId);
    const runStateStore = role.getSchedulerStateStore();
    const runState = runStateStore?.load() ?? null;
    const engine = role.getEngine();
    const config = engine?.getConfig() ?? role.config;

    const nextRunPreview = computeSchedulerNextRunPreview(config, runState);
    const dispatchStatusResult = await loadSchedulerDispatchStatus(config.dispatch_plan_path);
    const dispatchPlanData = await loadDispatchPlanData(config.dispatch_plan_path, log);
    const lifecycleState = await loadDispatchLifecycleState(config.dispatch_plan_path, log);
    const dispatchPlanRows = await enrichDispatchPlanRows(config.dispatch_plan_path, dispatchPlanData.rows, log);
    const dispatcherThreadId = runState?.current_dispatcher_thread_id
      ?? lifecycleState.dispatcher.thread_id
      ?? null;

    return {
      ok: true,
      scheduler_id: threadId,
      config,
      run_state: runState,
      next_run_preview: nextRunPreview,
      dispatch_status: dispatchStatusResult.dispatchStatus,
      dispatch_status_error: dispatchStatusResult.error,
      continue_worker: resolveServiceContinueWorker(dispatchPlanRows, lifecycleState),
      current_worker: resolveCurrentWorker(dispatchPlanRows, lifecycleState),
      dispatch_details: buildDispatchWorkerDetails(
        lifecycleState,
        dispatchPlanRows,
        dispatchPlanData.modelLegend,
        {
          roleId: threadId,
          dispatcherThreadId,
          dispatcherAgentType: config.agent_type
        }
      ),
      dispatch_plan: {
        rows: dispatchPlanRows
      }
    };
  }

  async function getSchedulerRuns(threadId: string) {
    const role = resolveSchedulerRole(threadId);
    const runStateStore = role.getSchedulerStateStore();
    const runState = runStateStore?.load();

    return {
      ok: true,
      scheduler_id: threadId,
      runs: runState?.run_history ?? []
    };
  }

  async function patchSchedulerConfig(threadId: string, body: unknown) {
    const role = resolveSchedulerRole(threadId);
    const engine = role.getEngine();

    // Partial config update — merge with existing
    const currentConfig = engine?.getConfig() ?? role.config;
    const patch = body as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...currentConfig, ...patch };
    if (patch.model_id === null || patch.model_id === "") {
      delete merged.model_id;
    }
    if (patch.model_map === null || patch.model_map === "") {
      delete merged.model_map;
    }
    if (patch.scan_run_id_prefix === null || patch.scan_run_id_prefix === "") {
      delete merged.scan_run_id_prefix;
    }
    const validated = SchedulerConfigSchema.parse(merged);

    if (validated.scheduler_mode === "cron" && validated.cron_expression) {
      parseCronExpression(validated.cron_expression);
    }

    engine?.updateConfig(validated);

    // Persist updated config
    const appState = AppStateSchema.parse(
      (await stateStore.load()) ?? EMPTY_APP_STATE
    );
    const roleIndex = appState.roles.findIndex((r) => r.threadId === threadId);
    if (roleIndex >= 0) {
      appState.roles[roleIndex] = {
        ...appState.roles[roleIndex]!,
        config: validated
      };
      await stateStore.save(appState);
    }

    return {
      ok: true,
      scheduler_id: threadId,
      config: validated
    };
  }

  async function startSchedule(threadId: string) {
    const role = resolveSchedulerRole(threadId);
    const engine = role.getEngine();
    if (!engine) throw createHttpError(500, "Scheduler engine not initialized");

    engine.start();

    return { ok: true, scheduler_id: threadId, action: "started" };
  }

  async function stopSchedule(threadId: string) {
    const role = resolveSchedulerRole(threadId);
    const engine = role.getEngine();
    if (!engine) throw createHttpError(500, "Scheduler engine not initialized");

    engine.stop();

    return { ok: true, scheduler_id: threadId, action: "stopped" };
  }

  async function pauseSchedule(threadId: string) {
    await runner.pauseRole(threadId);
    return { ok: true, scheduler_id: threadId, action: "paused" };
  }

  async function resumeSchedule(threadId: string) {
    await runner.resumeRole(threadId);
    return { ok: true, scheduler_id: threadId, action: "resumed" };
  }

  async function runNow(threadId: string, body: unknown) {
    const role = resolveSchedulerRole(threadId);
    const engine = role.getEngine();
    if (!engine) throw createHttpError(500, "Scheduler engine not initialized");

    const parsed = RunNowBodySchema.parse(body);
    const result = await engine.runNow(parsed?.report_base_dir);

    if (!result.ok) {
      throw createHttpError(409, result.error ?? "Cannot start run now");
    }

    return {
      ok: true,
      scheduler_id: threadId,
      run_id: result.run_id,
      action: "run_now"
    };
  }

  async function cancelRun(threadId: string) {
    const role = resolveSchedulerRole(threadId);
    const engine = role.getEngine();
    if (!engine) throw createHttpError(500, "Scheduler engine not initialized");

    await engine.cancelActiveRun();

    return { ok: true, scheduler_id: threadId, action: "cancelled" };
  }

  async function continueSchedulerWorker(threadId: string, workerId: string) {
    const role = resolveSchedulerRole(threadId);
    const engine = role.getEngine();
    if (!engine) throw createHttpError(500, "Scheduler engine not initialized");

    const result = await engine.continueWorker(workerId);
    if (!result.ok) {
      throw createHttpError(409, result.error ?? `Failed to continue ${workerId}`);
    }

    return {
      ok: true,
      status: "continued",
      message: `continued: ${workerId}`,
      worker: workerId,
      ...(result.threadId ? { worker_thread_id: result.threadId } : {}),
      ...(result.resumeResult ? { resume_result: result.resumeResult } : {})
    };
  }

  async function resumeSchedulerWorker(threadId: string, workerId: string, body: unknown) {
    const role = resolveSchedulerRole(threadId);
    const config = role.getEngine()?.getConfig() ?? role.config;
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
        planPath: config.dispatch_plan_path,
        workerId,
        action: parsed.data.action,
        force: parsed.data.force ?? false
      })
    };
  }

  async function updateSchedulerWorkerStatus(threadId: string, workerId: string, body: unknown) {
    const role = resolveSchedulerRole(threadId);
    const config = role.getEngine()?.getConfig() ?? role.config;
    const parsed = UpdateWorkerStatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw createHttpError(400, "Invalid worker status payload");
    }

    try {
      return {
        ok: true,
        result: await executeUpdateWorkerStatusAction({
          planPath: config.dispatch_plan_path,
          workerId,
          status: parsed.data.status,
          threadId: parsed.data.thread_id ?? null
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

  async function deleteScheduler(threadId: string) {
    await runner.deactivate(threadId);
    return { ok: true, scheduler_id: threadId, action: "deleted" };
  }

  function resolveSchedulerRole(threadId: string): SchedulerRole {
    const role = runner.getRole(threadId);
    if (!role || role.roleType !== "scheduler") {
      throw createHttpError(404, `Scheduler not found: ${threadId}`);
    }
    return role as SchedulerRole;
  }

  async function loadSchedulerDispatchStatus(dispatchPlanPath: string): Promise<{
    dispatchStatus: Awaited<ReturnType<typeof buildDispatchStatusReport>> | null;
    error: string | null;
  }> {
    try {
      return {
        dispatchStatus: await buildDispatchStatusReport(dispatchPlanPath),
        error: null
      };
    } catch (error) {
      return {
        dispatchStatus: null,
        error: getErrorMessage(error)
      };
    }
  }
}

export function computeSchedulerNextRunPreview(
  config: SchedulerConfig,
  runState: SchedulerRunState | null,
  now = new Date()
): string | null {
  if (runState && !NEXT_RUN_PREVIEW_STATUSES.has(runState.status)) {
    return null;
  }

  if (config.scheduler_mode !== "cron" || !config.cron_expression) {
    return null;
  }

  try {
    const nextFire = nextCronFire(config.cron_expression, now, config.timezone ?? "system");
    return nextFire.toISOString();
  } catch {
    return null;
  }
}

// ─── Route matching ─────────────────────────────────────────────────────────

function matchSchedulerRoute(request: IncomingMessage): SchedulerRouteMatch | null {
  const method = request.method?.toUpperCase();
  const url = request.url;
  if (!method || !url) return null;

  const pathname = new URL(url, "http://127.0.0.1").pathname;
  const parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

  // POST /api/scheduler
  if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "scheduler") {
    return { kind: "create-scheduler" };
  }

  // GET /api/scheduler/:threadId
  if (method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "scheduler") {
    return { kind: "get-scheduler", threadId: parts[2]! };
  }

  // GET /api/scheduler/:threadId/runs
  if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "runs") {
    return { kind: "get-scheduler-runs", threadId: parts[2]! };
  }

  // PATCH /api/scheduler/:threadId/config
  if (method === "PATCH" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "config") {
    return { kind: "patch-scheduler-config", threadId: parts[2]! };
  }

  // POST /api/scheduler/:threadId/start
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "start") {
    return { kind: "start-schedule", threadId: parts[2]! };
  }

  // POST /api/scheduler/:threadId/stop
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "stop") {
    return { kind: "stop-schedule", threadId: parts[2]! };
  }

  // POST /api/scheduler/:threadId/pause
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "pause") {
    return { kind: "pause-schedule", threadId: parts[2]! };
  }

  // POST /api/scheduler/:threadId/resume
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "resume") {
    return { kind: "resume-schedule", threadId: parts[2]! };
  }

  // POST /api/scheduler/:threadId/run-now
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "run-now") {
    return { kind: "run-now", threadId: parts[2]! };
  }

  // POST /api/scheduler/:threadId/cancel-run
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "scheduler" && parts[3] === "cancel-run") {
    return { kind: "cancel-run", threadId: parts[2]! };
  }

  if (
    method === "POST"
    && parts.length === 6
    && parts[0] === "api"
    && parts[1] === "scheduler"
    && parts[3] === "worker"
    && parts[5] === "continue"
  ) {
    return { kind: "continue-worker", threadId: parts[2]!, workerId: parts[4]! };
  }

  if (
    method === "POST"
    && parts.length === 6
    && parts[0] === "api"
    && parts[1] === "scheduler"
    && parts[3] === "worker"
    && parts[5] === "resume"
  ) {
    return { kind: "resume-worker", threadId: parts[2]!, workerId: parts[4]! };
  }

  if (
    method === "PATCH"
    && parts.length === 6
    && parts[0] === "api"
    && parts[1] === "scheduler"
    && parts[3] === "worker"
    && parts[5] === "status"
  ) {
    return { kind: "update-worker-status", threadId: parts[2]!, workerId: parts[4]! };
  }

  // DELETE /api/scheduler/:threadId
  if (method === "DELETE" && parts.length === 3 && parts[0] === "api" && parts[1] === "scheduler") {
    return { kind: "delete-scheduler", threadId: parts[2]! };
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};

  return JSON.parse(raw);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (!response.headersSent) {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
  }
  response.end(`${JSON.stringify(body)}\n`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getStatusCode(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error) {
    return (error as { statusCode: number }).statusCode;
  }
  return 500;
}

function createHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}
