import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerRole } from "../../roles/definitions/scheduler";
import { RoleRegistry } from "../../roles/role-registry";
import { RoleRunner } from "../../roles/role-runner";
import type { AppState, SchedulerConfig } from "../../types";
import { computeSchedulerNextRunPreview, createSchedulerHandlers, type SchedulerHandlers } from "../scheduler-handlers";
import { buildEmptyRunState } from "../../roles/scheduler/scheduler-state-store";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("computeSchedulerNextRunPreview", () => {
  it("suppresses cron previews after max cycles complete", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "completed_max_cycles",
        completed_cycles: 2,
        last_run_outcome: "completed"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeNull();
  });

  it("suppresses cron previews while a run is active", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "active_run",
        current_run_id: "run-active"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeNull();
  });

  it("keeps cron previews for schedulers that can accept a future run", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "idle"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeTruthy();
  });
});

describe("scheduler config updates", () => {
  it("patches and clears dispatcher provider and model routing settings", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-config-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");

    const handlers = createHarness();

    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-model-config-test",
      config: buildConfig(dispatchPlanPath)
    });

    await expect(invokeJson(handlers, "PATCH", "/api/scheduler/scheduler-model-config-test/config", {
      agent_type: "claude",
      model_id: "claude-opus-4-6",
      mode: "bridge",
      model_map: {
        OPUS: {
          provider: "claude",
          model_id: "claude-opus-4-6"
        }
      }
    })).resolves.toMatchObject({
      ok: true,
      config: expect.objectContaining({
        agent_type: "claude",
        model_id: "claude-opus-4-6",
        mode: "bridge",
        model_map: {
          OPUS: {
            provider: "claude",
            model_id: "claude-opus-4-6"
          }
        }
      })
    });

    const cleared = await invokeJson<{ config: Record<string, unknown> }>(
      handlers,
      "PATCH",
      "/api/scheduler/scheduler-model-config-test/config",
      {
        model_id: null,
        model_map: null
      }
    );

    expect(cleared.config).not.toHaveProperty("model_id");
    expect(cleared.config).not.toHaveProperty("model_map");
  });

  it("releases completed_max_cycles when max_cycles is increased past completed cycles", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-config-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const schedulerStatePath = path.join(directory, "scheduler_state.json");
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      ...buildEmptyRunState(),
      status: "completed_max_cycles",
      completed_cycles: 2,
      last_run_outcome: "completed",
      last_run_completed_at: "2026-04-26T06:52:50.422Z"
    }, null, 2)}\n`, "utf8");

    const handlers = createHarness();
    const config = buildConfig(dispatchPlanPath);

    await expect(invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-config-test",
      config: {
        ...config,
        max_cycles: 2
      }
    })).resolves.toMatchObject({
      ok: true,
      scheduler_id: "scheduler-config-test"
    });

    await expect(invokeJson(handlers, "PATCH", "/api/scheduler/scheduler-config-test/config", {
      max_cycles: 5
    })).resolves.toMatchObject({
      ok: true,
      scheduler_id: "scheduler-config-test",
      config: expect.objectContaining({
        max_cycles: 5
      })
    });

    await expect(invokeJson(handlers, "GET", "/api/scheduler/scheduler-config-test")).resolves.toMatchObject({
      ok: true,
      run_state: expect.objectContaining({
        status: "waiting",
        completed_cycles: 2
      })
    });
  });
});

function buildConfig(dispatchPlanPath = path.join("/tmp", "dispatch_plan.md")): SchedulerConfig {
  return {
    dispatch_plan_path: dispatchPlanPath,
    command_file_path: path.join(path.dirname(dispatchPlanPath), "agent_dispatch_command.md"),
    dispatch_repo_root: path.dirname(dispatchPlanPath),
    docs_root: path.dirname(dispatchPlanPath),
    user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
    agent_type: "codex",
    mode: "pane_bridge",
    kill_policy: "always",
    auto_approve: true,
    scheduler_mode: "cron",
    cron_expression: "0 6 * * *",
    timezone: "Asia/Tokyo",
    delay_between_cycles_seconds: 0,
    report_base_dir: path.join("/tmp", "reports"),
    catch_up_policy: "skip_missed"
  };
}

class MemoryStateStore {
  private currentState: AppState | null = null;

  async load(): Promise<AppState | null> {
    return this.currentState ? structuredClone(this.currentState) : null;
  }

  async save(state: AppState): Promise<void> {
    this.currentState = structuredClone(state);
  }
}

function createHarness(): SchedulerHandlers {
  const stateStore = new MemoryStateStore();
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: async () => undefined,
    listInstances: () => [],
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  });

  registry.register("scheduler", (threadId, config) => new SchedulerRole(threadId, config, {
    stateStore,
    launchDispatcher: async () => ({
      ok: true,
      threadId: "dispatcher-thread-test"
    }),
    meridianApi: {
      spawn: async () => ({ threadId: "spawn-thread-test" }),
      run: async (request) => ({
        threadId: request.threadId,
        status: "success",
        raw: {}
      }),
      kill: async (threadId) => ({
        threadId,
        status: "killed",
        raw: {}
      })
    }
  }));

  return createSchedulerHandlers({
    runner,
    registry,
    stateStore,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  });
}

async function invokeJson<T = unknown>(
  handlers: SchedulerHandlers,
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const request = createJsonRequest(method, url, body);
  const response = createJsonResponse();
  const handled = await handlers.handle(request, response.raw);

  expect(handled).toBe(true);
  return JSON.parse(response.body) as T;
}

function createJsonRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = Readable.from(payload ? [payload] : []) as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString()
  };
  return request;
}

function createJsonResponse(): { raw: ServerResponse; body: string; statusCode: number } {
  const chunks: string[] = [];
  const response = {
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead(statusCode: number): ServerResponse {
      response.statusCode = statusCode;
      return response as unknown as ServerResponse;
    },
    end(chunk?: unknown): ServerResponse {
      if (typeof chunk === "string") chunks.push(chunk);
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString("utf8"));
      return response as unknown as ServerResponse;
    }
  };

  return {
    raw: response as unknown as ServerResponse,
    get body() {
      return chunks.join("");
    },
    get statusCode() {
      return response.statusCode;
    }
  };
}
