import * as fs from "node:fs/promises";
import path from "node:path";

import { continueDispatchWorker, type ContinueDispatchPlanRow } from "../../roles/agent-dispatcher/continue-worker";
import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import { isHumanDispatchRow, resolveServiceContinueWorker } from "../../roles/agent-dispatcher/service-continuation";
import {
  ACTIVE_ROLE_STATUS,
  PAUSED_ROLE_STATUS,
  StateStore
} from "../../state-store";
import type { DispatchThreadStateV2, AppState, AgentDispatcherConfig } from "../../types";
import { AgentDispatcherConfigSchema } from "../../types";
import { parseDispatchPlanRows } from "./dispatch-status";
import {
  buildServiceErrorData,
  postRolesServiceJson,
  type JsonRequestResult
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";

export interface ContinueDispatcherDeps {
  loadState(): Promise<AppState | null>;
  readFile(filePath: string): Promise<string>;
  saveState(state: AppState): Promise<void>;
  loadLifecycle(planPath: string): DispatchThreadStateV2;
  continueWorker(
    config: Pick<AgentDispatcherConfig, "dispatch_plan_path" | "command_file_path" | "mode" | "agent_type" | "model_map">,
    dispatchPlanRows: ContinueDispatchPlanRow[],
    workerId: string
  ): ReturnType<typeof continueDispatchWorker>;
  postContinue(pathname: string): Promise<JsonRequestResult<ToolResult>>;
}

const stateStore = new StateStore();

const defaultDeps: ContinueDispatcherDeps = {
  loadState: () => stateStore.load(),
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
  saveState: (state) => stateStore.save(state),
  loadLifecycle: (planPath) => {
    try {
      return new LifecycleStore(resolveDispatchThreadPath(planPath)).load();
    } catch {
      return buildEmptyLifecycleState();
    }
  },
  continueWorker: (config, dispatchPlanRows, workerId) => continueDispatchWorker(config, dispatchPlanRows, workerId),
  postContinue: (pathname) => postRolesServiceJson<ToolResult>(pathname, {})
};

const continueDispatcherTool: ToolDefinition = {
  name: "continue-dispatcher",
  description: "Ask Meridian-roles service to select and launch the next eligible agent-dispatcher worker",
  params: {
    dispatcher: {
      type: "string",
      required: true,
      description: "Agent-dispatcher role thread_id"
    },
    worker: {
      type: "string",
      required: false,
      description: "Optional explicit worker id to continue instead of service-owned next-worker selection"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const dispatcherId = requireParam(params.dispatcher);
    if (!dispatcherId) {
      return {
        ok: false,
        error: "Missing required parameter: dispatcher"
      };
    }

    return executeContinueDispatcher({
      dispatcherId,
      workerId: requireParam(params.worker)
    });
  }
};

export default continueDispatcherTool;

export async function executeContinueDispatcher(
  args: {
    dispatcherId: string;
    workerId?: string | null;
  },
  deps: ContinueDispatcherDeps = defaultDeps
): Promise<ToolResult> {
  const pathname = args.workerId
    ? `/api/roles/${encodeURIComponent(args.dispatcherId)}/worker/${encodeURIComponent(args.workerId)}/continue`
    : `/api/agent-dispatcher/${encodeURIComponent(args.dispatcherId)}/continue`;

  const response = await deps.postContinue(pathname);
  if (response.ok) {
    return response.body;
  }

  if (!response.service_unreachable) {
    return {
      ok: false,
      error: response.error,
      data: buildServiceErrorData(response)
    };
  }

  const fallback = await continueDispatcherLocally(args.dispatcherId, args.workerId ?? null, deps);
  if (fallback.ok) {
    return fallback.result;
  }

  return {
    ok: false,
    error: `${response.error}; local fallback failed: ${fallback.error}`,
    data: {
      ...buildServiceErrorData(response),
      fallback_error: fallback.error
    }
  };
}

async function continueDispatcherLocally(
  dispatcherId: string,
  requestedWorkerId: string | null,
  deps: ContinueDispatcherDeps
): Promise<
  | { ok: true; result: ToolResult }
  | { ok: false; error: string }
> {
  const state = await deps.loadState();
  if (!state) {
    return {
      ok: false,
      error: "No persisted Meridian-roles state was found for local continuation"
    };
  }

  const roleState = state.roles.find((role) => role.threadId === dispatcherId && role.roleType === "agent-dispatcher") ?? null;
  if (!roleState) {
    return {
      ok: false,
      error: `Agent dispatcher not found in persisted state for thread_id=${dispatcherId}`
    };
  }

  const parsedConfig = AgentDispatcherConfigSchema.safeParse(roleState.config);
  if (!parsedConfig.success) {
    return {
      ok: false,
      error: `Invalid persisted agent dispatcher config for thread_id=${dispatcherId}`
    };
  }

  const config = parsedConfig.data;
  let markdown: string;
  try {
    markdown = await deps.readFile(config.dispatch_plan_path);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read dispatch plan at ${config.dispatch_plan_path}: ${asError(error).message}`
    };
  }

  const dispatchPlanRows = parseDispatchPlanRows(markdown).map((row) => ({
    status: row.status,
    worker: row.worker_id,
    model: row.model ?? "",
    depends_on: row.depends_on
  }));
  const lifecycleState = deps.loadLifecycle(config.dispatch_plan_path);
  const effectiveWorkerId = requestedWorkerId ?? resolveServiceContinueWorker(dispatchPlanRows, lifecycleState);
  const runningWorkers = findRunningNonHumanWorkers(dispatchPlanRows)
    .filter((workerId) => workerId !== effectiveWorkerId);

  if (runningWorkers.length > 0) {
    return {
      ok: true,
      result: {
        ok: true,
        status: "still_blocked",
        message: `still blocked: running worker(s): ${runningWorkers.join(", ")}`,
        ...(effectiveWorkerId ? { worker: effectiveWorkerId } : {}),
        running_workers: runningWorkers
      } as ToolResult
    };
  }

  if (!effectiveWorkerId) {
    return {
      ok: false,
      error: "No eligible non-human worker found to continue"
    };
  }

  const continued = await deps.continueWorker(config, dispatchPlanRows, effectiveWorkerId);
  if (!continued.ok) {
    if (continued.localToolBootstrapFailure) {
      return {
        ok: true,
        result: {
          ok: true,
          status: "local_tool_bootstrap_failed",
          message: `local tool bootstrap failed: ${continued.error}`,
          worker: effectiveWorkerId,
          error: continued.error
        } as ToolResult
      };
    }

    return {
      ok: false,
      error: continued.error ?? `Failed to continue worker ${effectiveWorkerId}`
    };
  }

  if (roleState.status === PAUSED_ROLE_STATUS) {
    roleState.status = ACTIVE_ROLE_STATUS;
    await deps.saveState(state);
  }

  const dispatcherThreadId = normalizeDispatcherThreadId(lifecycleState);
  return {
    ok: true,
    result: {
      ok: true,
      status: "continued",
      message: `continued: ${effectiveWorkerId}`,
      ...(dispatcherThreadId ? { dispatcher_thread_id: dispatcherThreadId } : {}),
      worker: effectiveWorkerId,
      ...(continued.resumeResult ? { resume_result: continued.resumeResult } : {})
    } as ToolResult
  };
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function findRunningNonHumanWorkers(rows: Array<Pick<ContinueDispatchPlanRow, "status" | "worker" | "model">>): string[] {
  return rows
    .filter((row) => row.status === "🔄" && !isHumanDispatchRow(row))
    .map((row) => row.worker.trim())
    .filter((workerId) => workerId.length > 0);
}

function normalizeDispatcherThreadId(lifecycleState: DispatchThreadStateV2): string | null {
  return lifecycleState.dispatcher.status === "running"
    ? requireParam(lifecycleState.dispatcher.thread_id ?? undefined)
    : null;
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

function buildEmptyLifecycleState(): DispatchThreadStateV2 {
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
