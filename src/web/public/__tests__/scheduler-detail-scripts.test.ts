import * as fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

describe("scheduler detail public scripts", () => {
  it("uses model dropdowns for scheduler creation and detail config", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const indexHtml = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");

    expect(indexHtml).toContain('<select id="new-scheduler-model-id" name="model_id">');
    expect(indexHtml).not.toContain('<input id="new-scheduler-model-id"');
    expect(indexHtml).toContain('<option value="gpt-5.4 high">codex: gpt-5.4 high</option>');
    expect(indexHtml).toContain('<option value="claude-opus-4-6">claude: claude-opus-4-6</option>');

    expect(schedulerHtml).toContain('<select id="cfg-model-id" name="model_id">');
    expect(schedulerHtml).not.toContain('<input id="cfg-model-id"');
    expect(schedulerHtml).toContain('<option value="gpt-5.4 high">codex: gpt-5.4 high</option>');
    expect(schedulerHtml).toContain('<option value="claude-opus-4-6">claude: claude-opus-4-6</option>');
  });

  it("submits scheduler creation with dispatcher agent and model settings", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const elements = new Map<string, Record<string, unknown>>();
    const form = getElementStub(elements, "create-scheduler-form");
    Object.assign(form, {
      scheduler_mode: { value: "cron" },
      dispatch_plan_path: { value: "/tmp/project/dispatch_plan.md" },
      report_base_dir: { value: "/tmp/project/reports" },
      cron_expression: { value: "0 9 * * 1-5" },
      timezone: { value: "Asia/Tokyo" },
      interval_seconds: { value: "" },
      max_cycles: { value: "" },
      delay_between_cycles_seconds: { value: "" },
      dispatch_repo_root: { value: "/tmp/project" },
      docs_root: { value: "/tmp/docs" },
      agent_type: { value: "codex" },
      model_id: { value: "gpt-5.4 high" },
      mode: { value: "pane_bridge" },
      model_map: { value: '{"CODEX":{"provider":"codex","model_id":"gpt-5.4 high"}}' },
      catch_up_policy: { value: "skip_missed" },
      reset: () => undefined
    });
    let schedulerRequestBody: unknown = null;

    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "dashboard" } },
        addEventListener: () => undefined,
        getElementById: (id: string) => getElementStub(elements, id),
        querySelector: () => null,
        querySelectorAll: () => []
      },
      fetch: async (url: string, options?: { body?: string }) => {
        if (url === "/api/scheduler") {
          schedulerRequestBody = JSON.parse(options?.body ?? "{}");
          return jsonResponse({ ok: true, scheduler_id: "scheduler-test" });
        }

        return jsonResponse([]);
      },
      URLSearchParams,
      window: {
        location: {
          pathname: "/",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    vm.runInContext("setupSchedulerCreation()", context);
    const submitHandler = getElementHandlers(form).submit;
    if (!submitHandler) {
      throw new Error("create scheduler form did not register submit handler");
    }

    await submitHandler({
      preventDefault: () => undefined
    });

    expect(schedulerRequestBody).toMatchObject({
      config: {
        agent_type: "codex",
        model_id: "gpt-5.4 high",
        mode: "pane_bridge",
        model_map: {
          CODEX: {
            provider: "codex",
            model_id: "gpt-5.4 high"
          }
        }
      }
    });
  });

  it("loads beside the shared dashboard script without global declaration conflicts", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const schedulerScript = extractInlineScripts(schedulerHtml).join("\n");
    const element = createElementStub();

    const context = vm.createContext({
      console,
      document: {
        addEventListener: () => undefined,
        getElementById: () => element,
        querySelectorAll: () => []
      },
      fetch: async () => ({ ok: false }),
      setInterval: () => undefined,
      window: {
        location: {
          pathname: "/scheduler/scheduler-bf02b39c",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });

    expect(() => {
      vm.runInContext(schedulerScript, context, { filename: "scheduler.html inline script" });
    }).not.toThrow();
  });

  it("updates scheduler detail nav counts and status from the same APIs as the dashboard", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const schedulerScript = extractInlineScripts(schedulerHtml).join("\n");
    const elements = new Map<string, Record<string, unknown>>();
    const handlers: { domContentLoaded?: () => void } = {};

    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "scheduler-detail" } },
        addEventListener: (event: string, handler: () => void) => {
          if (event === "DOMContentLoaded") handlers.domContentLoaded = handler;
        },
        getElementById: (id: string) => getElementStub(elements, id),
        querySelectorAll: () => []
      },
      fetch: async (url: string) => {
        if (url === "/api/roles") {
          return jsonResponse([
            { thread_id: "agent-dispatcher-a", role_type: "agent-dispatcher", status: "completed", task_count: 1 },
            { thread_id: "agent-dispatcher-b", role_type: "agent-dispatcher", status: "completed", task_count: 1 },
            { thread_id: "scheduler-bf02b39c", role_type: "scheduler", status: "waiting", task_count: 0 }
          ]);
        }

        if (url === "/api/scheduler/scheduler-bf02b39c") {
          return jsonResponse({
            ok: true,
            scheduler_id: "scheduler-bf02b39c",
            config: {
              dispatch_plan_path: "/tmp/dispatch_plan.md",
              scheduler_mode: "cron"
            },
            run_state: {
              status: "waiting",
              completed_cycles: 2,
              next_run_at: "2026-04-26T21:00:00.000Z",
              last_run_outcome: "completed",
              run_history: []
            }
          });
        }

        return { ok: false };
      },
      setInterval: () => undefined,
      window: {
        location: {
          pathname: "/scheduler/scheduler-bf02b39c",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    vm.runInContext(schedulerScript, context, { filename: "scheduler.html inline script" });
    const domContentLoaded = handlers.domContentLoaded;
    if (!domContentLoaded) {
      throw new Error("app.js did not register a DOMContentLoaded handler");
    }
    domContentLoaded();
    await flushAsync();

    expect(getElementStub(elements, "nav-dispatcher-count")).toMatchObject({ textContent: "2", hidden: false });
    expect(getElementStub(elements, "nav-scheduler-count")).toMatchObject({ textContent: "1", hidden: false });
    expect(getElementStub(elements, "nav-role-count")).toMatchObject({ textContent: "3", hidden: false });
    expect(getElementStub(elements, "s-status-val")).toMatchObject({ textContent: "waiting" });
    expect(getElementStub(elements, "scheduler-status-badge")).toMatchObject({
      textContent: "waiting",
      className: "status-badge waiting"
    });
  });

  it("populates and saves scheduler dispatcher agent settings", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const schedulerScript = extractInlineScripts(schedulerHtml).join("\n");
    const elements = new Map<string, Record<string, unknown>>();
    let patchBody: unknown = null;

    const context = vm.createContext({
      console,
      document: {
        getElementById: (id: string) => getElementStub(elements, id),
        querySelectorAll: () => []
      },
      fetch: async (url: string, options?: { body?: string; method?: string }) => {
        if (url === "/api/scheduler/scheduler-bf02b39c/config" && options?.method === "PATCH") {
          patchBody = JSON.parse(options.body ?? "{}");
          return jsonResponse({ ok: true });
        }

        if (url === "/api/scheduler/scheduler-bf02b39c") {
          return jsonResponse({
            ok: true,
            scheduler_id: "scheduler-bf02b39c",
            config: {
              dispatch_plan_path: "/tmp/dispatch_plan.md",
              scheduler_mode: "cron",
              agent_type: "codex",
              model_id: "gpt-5.4 high",
              mode: "pane_bridge",
              model_map: {
                CODEX: {
                  provider: "codex",
                  model_id: "gpt-5.4 high"
                }
              }
            },
            run_state: {
              status: "waiting",
              completed_cycles: 0,
              run_history: []
            }
          });
        }

        return { ok: false, json: async () => ({}) };
      },
      setInterval: () => undefined,
      window: {
        location: {
          pathname: "/scheduler/scheduler-bf02b39c",
          search: ""
        }
      }
    });

    vm.runInContext(schedulerScript, context, { filename: "scheduler.html inline script" });
    await flushAsync();

    expect(getElementStub(elements, "cfg-agent-type")).toMatchObject({ value: "codex" });
    expect(getElementStub(elements, "cfg-model-id")).toMatchObject({ value: "gpt-5.4 high" });
    expect(getElementStub(elements, "cfg-agent-mode")).toMatchObject({ value: "pane_bridge" });
    expect(String(getElementStub(elements, "cfg-model-map").value)).toContain('"CODEX"');

    const configForm = getElementStub(elements, "config-form");
    Object.assign(configForm, {
      scheduler_mode: { value: "cron" },
      cron_expression: { value: "0 9 * * 1-5" },
      timezone: { value: "Asia/Tokyo" },
      interval_seconds: { value: "" },
      max_cycles: { value: "" },
      delay_between_cycles_seconds: { value: "" },
      dispatch_repo_root: { value: "" },
      docs_root: { value: "" },
      report_base_dir: { value: "/tmp/reports" },
      catch_up_policy: { value: "skip_missed" },
      agent_type: { value: "claude" },
      model_id: { value: "claude-opus-4-6" },
      mode: { value: "bridge" },
      model_map: { value: '{"OPUS":{"provider":"claude","model_id":"claude-opus-4-6"}}' }
    });

    const submitHandler = getElementHandlers(configForm).submit;
    if (!submitHandler) {
      throw new Error("scheduler config form did not register submit handler");
    }

    await submitHandler({
      preventDefault: () => undefined,
      target: configForm
    });

    expect(patchBody).toMatchObject({
      agent_type: "claude",
      model_id: "claude-opus-4-6",
      mode: "bridge",
      model_map: {
        OPUS: {
          provider: "claude",
          model_id: "claude-opus-4-6"
        }
      }
    });
  });
});

function extractInlineScripts(html: string): string[] {
  return Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
}

function createElementStub(): Record<string, unknown> {
  const handlers: Record<string, (event: Record<string, unknown>) => unknown> = {};
  return {
    __handlers: handlers,
    addEventListener: (event: string, handler: (event: Record<string, unknown>) => unknown) => {
      handlers[event] = handler;
    },
    className: "",
    dataset: {},
    hidden: false,
    innerHTML: "",
    textContent: "",
    value: ""
  };
}

function getElementHandlers(element: Record<string, unknown>): Record<string, (event: Record<string, unknown>) => unknown> {
  return element.__handlers as Record<string, (event: Record<string, unknown>) => unknown>;
}

function getElementStub(elements: Map<string, Record<string, unknown>>, id: string): Record<string, unknown> {
  const existing = elements.get(id);
  if (existing) return existing;

  const element = createElementStub();
  elements.set(id, element);
  return element;
}

function jsonResponse(body: unknown): { ok: true; json: () => Promise<unknown>; text: () => Promise<string> } {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
