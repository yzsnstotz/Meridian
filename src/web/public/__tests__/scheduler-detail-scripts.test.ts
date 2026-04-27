import * as fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

describe("scheduler detail public scripts", () => {
  it("uses model dropdowns for scheduler creation and detail config", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const indexHtml = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const styleCss = await fs.readFile(path.join(publicDir, "style.css"), "utf8");

    expect(indexHtml).toContain('<select id="new-scheduler-model-id" name="model_id">');
    expect(indexHtml).not.toContain('<input id="new-scheduler-model-id"');
    expect(indexHtml).toContain('<option value="gpt-5.5 high">codex: gpt-5.5 high</option>');
    expect(indexHtml).toContain('<option value="gpt-5.5 xhigh">codex: gpt-5.5 xhigh</option>');
    expect(indexHtml).toContain('<option value="claude-opus-4-7">claude: claude-opus-4-7</option>');
    expect(indexHtml).not.toContain('<option value="gpt-5.4 high">codex: gpt-5.4 high</option>');
    expect(indexHtml).not.toContain('<option value="gpt-5.4 xhigh">codex: gpt-5.4 xhigh</option>');
    expect(indexHtml).not.toContain('<option value="claude-opus-4-6">claude: claude-opus-4-6</option>');
    expect(indexHtml).not.toContain('id="new-scheduler-model-map"');
    expect(indexHtml).toContain('id="new-scheduler-scan-run-id-strategy" name="scan_run_id_strategy"');
    expect(indexHtml).toContain('id="new-scheduler-scan-run-id-prefix" name="scan_run_id_prefix"');

    expect(schedulerHtml).toContain('<select id="cfg-model-id" name="model_id">');
    expect(schedulerHtml).not.toContain('<input id="cfg-model-id"');
    expect(schedulerHtml).toContain('<option value="gpt-5.5 high">codex: gpt-5.5 high</option>');
    expect(schedulerHtml).toContain('<option value="gpt-5.5 xhigh">codex: gpt-5.5 xhigh</option>');
    expect(schedulerHtml).toContain('<option value="claude-opus-4-7">claude: claude-opus-4-7</option>');
    expect(schedulerHtml).not.toContain('<option value="gpt-5.4 high">codex: gpt-5.4 high</option>');
    expect(schedulerHtml).not.toContain('<option value="gpt-5.4 xhigh">codex: gpt-5.4 xhigh</option>');
    expect(schedulerHtml).not.toContain('<option value="claude-opus-4-6">claude: claude-opus-4-6</option>');
    expect(schedulerHtml).not.toContain('id="cfg-model-map"');
    expect(schedulerHtml).toContain('id="cfg-scan-run-id-strategy" name="scan_run_id_strategy"');
    expect(schedulerHtml).toContain('id="cfg-scan-run-id-prefix" name="scan_run_id_prefix"');
    expect(styleCss).toContain("[hidden]");
    expect(styleCss).toContain("display: none !important");
  });

  it("renders dashboard role counts without waiting for reply channel loading", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const elements = new Map<string, Record<string, unknown>>();
    let rolesRequested = false;
    let channelsRequested = false;

    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "dashboard" } },
        addEventListener: () => undefined,
        createElement: () => createElementStub(),
        getElementById: (id: string) => getElementStub(elements, id),
        querySelector: (selector: string) => {
          if (selector === '[data-action="refresh-roles"]') {
            return getElementStub(elements, "refresh-roles-button");
          }
          return null;
        },
        querySelectorAll: () => []
      },
      fetch: async (url: string) => {
        if (url === "/api/channels") {
          channelsRequested = true;
          return new Promise(() => undefined);
        }

        if (url === "/api/agent-dispatcher/prompt-preview") {
          return jsonResponse({ system_prompt: "prompt" });
        }

        if (url === "/api/roles") {
          rolesRequested = true;
          return jsonResponse([
            { thread_id: "agent-dispatcher-a", role_type: "agent-dispatcher", status: "completed", task_count: 1 },
            { thread_id: "scheduler-a", role_type: "scheduler", status: "active_run", task_count: 2 }
          ]);
        }

        if (url === "/api/role/agent-dispatcher-a") {
          return jsonResponse({
            thread_id: "agent-dispatcher-a",
            status: "completed",
            dispatcher_thread_id: "codex_01",
            current_worker: null,
            agent_type: "codex",
            model_id: "gpt-5.5 high",
            auto_approve: false,
            last_log_line: "done"
          });
        }

        return jsonResponse({});
      },
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        setInterval: () => undefined,
        location: {
          pathname: "/",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    vm.runInContext("setupDashboard()", context);
    await flushAsync();
    await flushAsync();

    expect(channelsRequested).toBe(true);
    expect(rolesRequested).toBe(true);
    expect(getElementStub(elements, "nav-dispatcher-count")).toMatchObject({ textContent: "1", hidden: false });
    expect(getElementStub(elements, "nav-scheduler-count")).toMatchObject({ textContent: "1", hidden: false });
    expect(getElementStub(elements, "nav-role-count")).toMatchObject({ textContent: "2", hidden: false });
    expect(getElementStub(elements, "schedulers-empty")).toMatchObject({ hidden: true });
    expect(getElementStub(elements, "agent-dispatchers-empty")).toMatchObject({ hidden: true });
    expect(getElementStub(elements, "roles-empty")).toMatchObject({ hidden: true });
    const schedulerCards = getElementStub(elements, "schedulers-list").children as Array<{ innerHTML?: string }>;
    expect(schedulerCards[0]?.innerHTML).toContain("<dt>tasks</dt><dd>2</dd>");
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
      scan_run_id_strategy: { value: "daily-date" },
      scan_run_id_prefix: { value: "daily" },
      agent_type: { value: "codex" },
      model_id: { value: "gpt-5.5 high" },
      mode: { value: "pane_bridge" },
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
        model_id: "gpt-5.5 high",
        mode: "pane_bridge",
        scan_run_id_strategy: "daily-date",
        scan_run_id_prefix: "daily"
      }
    });
    expect((schedulerRequestBody as { config?: Record<string, unknown> }).config).not.toHaveProperty("model_map");
  });

  it("loads beside the shared dashboard script without global declaration conflicts", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const element = createElementStub();

    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "scheduler-detail" } },
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

    expect(extractInlineScripts(schedulerHtml)).toHaveLength(0);
    vm.runInContext(appScript, context, { filename: "app.js" });
  });

  it("updates scheduler detail nav counts and status from the same APIs as the dashboard", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
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
              current_run_id: "run-active",
              current_run_report_dir: "/tmp/reports/runs/run-active",
              last_run_outcome: "completed",
              last_report_path: "/tmp/reports/runs/run-previous/report.md",
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
    expect(getElementStub(elements, "s-active-run-report-dir")).toMatchObject({
      textContent: "/tmp/reports/runs/run-active"
    });
    expect(getElementStub(elements, "s-last-report")).toMatchObject({
      textContent: "/tmp/reports/runs/run-previous/report.md"
    });
  });

  it("populates and saves scheduler dispatcher agent settings", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const elements = new Map<string, Record<string, unknown>>();
    let patchBody: unknown = null;
    let intervalHandler: (() => void | Promise<void>) | undefined;

    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "scheduler-detail" } },
        addEventListener: () => undefined,
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
              model_id: "gpt-5.5 high",
              mode: "pane_bridge",
              scan_run_id_strategy: "daily-date",
              scan_run_id_prefix: "daily"
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
      setInterval: (handler: () => void | Promise<void>) => {
        intervalHandler = handler;
        return undefined;
      },
      window: {
        location: {
          pathname: "/scheduler/scheduler-bf02b39c",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    vm.runInContext("setupSchedulerDetail()", context);
    await flushAsync();

    expect(getElementStub(elements, "cfg-agent-type")).toMatchObject({ value: "codex" });
    expect(getElementStub(elements, "cfg-model-id")).toMatchObject({ value: "gpt-5.5 high" });
    expect(getElementStub(elements, "cfg-agent-mode")).toMatchObject({ value: "pane_bridge" });
    expect(getElementStub(elements, "cfg-scan-run-id-strategy")).toMatchObject({ value: "daily-date" });
    expect(getElementStub(elements, "cfg-scan-run-id-prefix")).toMatchObject({ value: "daily" });

    const configForm = getElementStub(elements, "config-form");
    const cfgAgentType = getElementStub(elements, "cfg-agent-type");
    cfgAgentType.value = "claude";
    getElementHandlers(configForm).change?.({ target: cfgAgentType });
    if (!intervalHandler) {
      throw new Error("scheduler detail did not register polling interval");
    }
    await intervalHandler();
    await flushAsync();
    expect(getElementStub(elements, "cfg-agent-type")).toMatchObject({ value: "claude" });

    Object.assign(configForm, {
      scheduler_mode: { value: "cron" },
      cron_expression: { value: "0 9 * * 1-5" },
      timezone: { value: "Asia/Tokyo" },
      interval_seconds: { value: "" },
      max_cycles: { value: "" },
      delay_between_cycles_seconds: { value: "" },
      dispatch_repo_root: { value: "" },
      docs_root: { value: "" },
      scan_run_id_strategy: { value: "daily-date" },
      scan_run_id_prefix: { value: "routine" },
      report_base_dir: { value: "/tmp/reports" },
      catch_up_policy: { value: "skip_missed" },
      agent_type: { value: "claude" },
      model_id: { value: "claude-opus-4-7" },
      mode: { value: "bridge" }
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
      model_id: "claude-opus-4-7",
      mode: "bridge",
      scan_run_id_strategy: "daily-date",
      scan_run_id_prefix: "routine"
    });
    expect(patchBody).not.toHaveProperty("model_map");
  });

  it("renders scheduler worker actions and inline agent reply cards", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const elements = new Map<string, Record<string, unknown>>();
    const handlers: { domContentLoaded?: () => void } = {};

    const context = createSchedulerDetailContext(elements, handlers);
    vm.runInContext(appScript, context, { filename: "app.js" });
    const domContentLoaded = handlers.domContentLoaded;
    if (!domContentLoaded) {
      throw new Error("app.js did not register a DOMContentLoaded handler");
    }
    domContentLoaded();
    await flushAsync();
    await flushAsync();

    const html = String(getElementStub(elements, "dispatch-progress-body").innerHTML);
    expect(html).toContain('data-resume-action="retry"');
    expect(html).toContain('data-resume-action="skip"');
    expect(html).toContain('data-resume-action="force-complete"');
    expect(html).toContain("data-status-apply");
    expect(html).toContain("Agent Reply");
    expect(html).toContain("Agent is working on R-01.");
  });

  it("posts scheduler worker action buttons to scheduler-scoped endpoints", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const elements = new Map<string, Record<string, unknown>>();
    const handlers: { domContentLoaded?: () => void } = {};
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];

    const context = createSchedulerDetailContext(elements, handlers, requests);
    vm.runInContext(appScript, context, { filename: "app.js" });
    const domContentLoaded = handlers.domContentLoaded;
    if (!domContentLoaded) {
      throw new Error("app.js did not register a DOMContentLoaded handler");
    }
    domContentLoaded();
    await flushAsync();
    await flushAsync();

    const dispatchBody = getElementStub(elements, "dispatch-progress-body");
    const clickHandler = getElementHandlers(dispatchBody).click;
    if (!clickHandler) {
      throw new Error("scheduler worker action handler was not registered");
    }

    await clickHandler({
      target: new FakeButton({
        workerId: "R-01",
        resumeAction: "skip"
      })
    });

    expect(requests).toContainEqual({
      url: "/api/scheduler/scheduler-gui-actions/worker/R-01/resume",
      method: "POST",
      body: { action: "skip" }
    });

    await clickHandler({
      target: new FakeButton({
        workerId: "R-01",
        statusApply: true,
        selectedStatus: "completed"
      })
    });

    expect(requests).toContainEqual({
      url: "/api/scheduler/scheduler-gui-actions/worker/R-01/status",
      method: "PATCH",
      body: { status: "completed" }
    });
  });
});

function extractInlineScripts(html: string): string[] {
  return Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
}

function createElementStub(): Record<string, unknown> {
  const handlers: Record<string, (event: Record<string, unknown>) => unknown> = {};
  const children: unknown[] = [];
  return {
    __handlers: handlers,
    children,
    addEventListener: (event: string, handler: (event: Record<string, unknown>) => unknown) => {
      handlers[event] = handler;
    },
    appendChild: (child: unknown) => {
      children.push(child);
      return child;
    },
    replaceChildren: (...nextChildren: unknown[]) => {
      children.splice(0, children.length, ...nextChildren);
    },
    querySelector: () => createElementStub(),
    querySelectorAll: () => [],
    classList: {
      add: () => undefined,
      remove: () => undefined
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

function createSchedulerDetailContext(
  elements: Map<string, Record<string, unknown>>,
  handlers: { domContentLoaded?: () => void },
  requests: Array<{ url: string; method?: string; body?: unknown }> = []
): vm.Context {
  return vm.createContext({
    console,
    document: {
      body: { dataset: { page: "scheduler-detail" } },
      addEventListener: (event: string, handler: () => void) => {
        if (event === "DOMContentLoaded") handlers.domContentLoaded = handler;
      },
      getElementById: (id: string) => getElementStub(elements, id),
      querySelectorAll: () => []
    },
    Element: FakeElement,
    HTMLButtonElement: FakeButton,
    HTMLSelectElement: FakeSelect,
    fetch: async (url: string, options?: { body?: string; method?: string }) => {
      if (url.includes("/worker/")) {
        requests.push({
          url,
          method: options?.method,
          body: options?.body ? JSON.parse(options.body) : undefined
        });
        return jsonResponse({ ok: true, status: "updated" });
      }

      if (url === "/api/roles") {
        return jsonResponse([]);
      }

      if (url === "/api/scheduler/scheduler-gui-actions") {
        return jsonResponse({
          ok: true,
          scheduler_id: "scheduler-gui-actions",
          config: {
            dispatch_plan_path: "/tmp/dispatch_plan.md",
            scheduler_mode: "cron"
          },
          run_state: {
            status: "active_run",
            completed_cycles: 0,
            run_history: []
          },
          dispatch_status: {
            summary: {
              total: 1,
              pending: 0,
              running: 1,
              completed: 0,
              failed: 0,
              skipped: 0,
              stale: 0
            },
            workers: [
              {
                status: "running",
                lifecycle_status: "running",
                batch: "B1",
                worker_id: "R-01",
                task: "Run worker",
                model: "gpt-5.5 high",
                depends_on: [],
                thread_id: "thread-r-01"
              }
            ],
            generated_at: "2026-04-27T00:00:00.000Z"
          },
          dispatch_plan: {
            rows: [
              {
                status: "running",
                lifecycle_status: "running",
                batch: "B1",
                worker: "R-01",
                task: "Run worker",
                model: "gpt-5.5 high",
                depends_on: "",
                thread_id: "thread-r-01"
              }
            ]
          },
          dispatch_details: [
            {
              worker_id: "R-01",
              status: "running",
              task: "Run worker",
              model: "gpt-5.5 high",
              worker_thread_id: "thread-r-01",
              command: {
                content: "Run R-01."
              },
              reply: {
                content: "Agent is working on R-01."
              }
            }
          ]
        });
      }

      return jsonResponse({});
    },
    Intl,
    setInterval: () => undefined,
    URLSearchParams,
    window: {
      confirm: () => true,
      location: {
        pathname: "/scheduler/scheduler-gui-actions",
        search: ""
      }
    }
  });
}

class FakeElement {
  getAttribute(_name: string): string | null {
    void _name;
    return null;
  }

  hasAttribute(_name: string): boolean {
    void _name;
    return false;
  }

  closest(_selector: string): FakeElement | null {
    void _selector;
    return this;
  }

  querySelector(_selector: string): FakeElement | null {
    void _selector;
    return null;
  }
}

class FakeSelect extends FakeElement {
  value: string;

  constructor(value: string) {
    super();
    this.value = value;
  }
}

class FakeButton extends FakeElement {
  private readonly workerId: string;
  private readonly resumeAction?: string;
  private readonly statusApply: boolean;
  private readonly selectedStatus: string;

  constructor(options: { workerId: string; resumeAction?: string; statusApply?: boolean; selectedStatus?: string }) {
    super();
    this.workerId = options.workerId;
    this.resumeAction = options.resumeAction;
    this.statusApply = Boolean(options.statusApply);
    this.selectedStatus = options.selectedStatus ?? "pending";
  }

  override getAttribute(name: string): string | null {
    if (name === "data-worker-id") return this.workerId;
    if (name === "data-resume-action") return this.resumeAction ?? null;
    return null;
  }

  override hasAttribute(name: string): boolean {
    if (name === "data-resume-action") return Boolean(this.resumeAction);
    if (name === "data-status-apply") return this.statusApply;
    return false;
  }

  override closest(selector: string): FakeElement | null {
    if (selector === "[data-continue-worker], [data-resume-action], [data-status-apply]") {
      return this;
    }

    if (selector === "tr") {
      return new FakeTableRow(this.selectedStatus);
    }

    return null;
  }
}

class FakeTableRow extends FakeElement {
  private readonly selectedStatus: string;

  constructor(selectedStatus: string) {
    super();
    this.selectedStatus = selectedStatus;
  }

  override querySelector(selector: string): FakeElement | null {
    return selector === "[data-worker-status]" ? new FakeSelect(this.selectedStatus) : null;
  }
}
