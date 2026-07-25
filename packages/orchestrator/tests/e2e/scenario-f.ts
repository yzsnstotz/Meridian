import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import type { LaunchResult } from "../../src/roles/agent-dispatcher/launcher";
import { AgentDispatcherRole } from "../../src/roles/definitions/agent-dispatcher";
import { PromptStore } from "../../src/roles/prompt-store";
import { RoleRegistry } from "../../src/roles/role-registry";
import { RoleRunner } from "../../src/roles/role-runner";
import { createPromptHandlers } from "../../src/server/prompt-handlers";
import { createRoleHandlers } from "../../src/server/role-handlers";
import { HttpServer } from "../../src/server/http-server";
import { StateStore } from "../../src/state-store";
import { formatDispatchPlan } from "./agent-dispatcher-harness";

describe("Scenario F: Config editor and role error states", () => {
  afterEach(async () => {
    await fs.rm("/tmp/meridian-roles.sock", { force: true }).catch(() => undefined);
  });

  it("serves every PRD section 5 GUI route over HTTP", async () => {
    const harness = await startHttpHarness();

    try {
      await harness.requestJson("POST", "/api/agent-dispatcher/start", {
        thread_id: "agent-dispatcher-f",
        dispatch_plan_path: harness.dispatchPlanPath,
        command_file_path: harness.commandFilePath,
        dispatch_repo_root: harness.dispatchRepoRoot,
        docs_root: harness.docsRoot,
        user_reply_channel: {
          channel: "web",
          chat_id: "web:gui"
        },
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always"
      });

      const dashboardPage = await harness.requestText("/");
      expect(dashboardPage.status).toBe(200);
      expect(dashboardPage.body).toContain("Start Agent Dispatcher");

      const rolePage = await harness.requestText(`/role/agent-dispatcher-f`);
      expect(rolePage.status).toBe(200);
      expect(rolePage.body).toContain('id="config-link"');
      expect(rolePage.body).toContain("Config Editor");

      const promptsPage = await harness.requestText("/role/agent-dispatcher-f/prompts");
      expect(promptsPage.status).toBe(200);
      expect(promptsPage.body).toContain('data-page="prompt-editor"');
      expect(promptsPage.body).toContain("Prompt Editor");

      const configPage = await harness.requestText("/role/agent-dispatcher-f/config");
      expect(configPage.status).toBe(200);
      expect(configPage.body).toContain('data-page="config-editor"');
      expect(configPage.body).toContain("Dispatch Plan JSON");
    } finally {
      await harness.close();
    }
  });

  it("replaces stale role-detail loading content on missing-role fetch errors", async () => {
    const page = await loadBrowserApp({
      pathname: "/role/does-not-exist-xyz",
      elements: {
        "dashboard-link": createElement(),
        "role-title": createElement("Loading role…"),
        "role-subtitle": createElement("Fetching dispatcher detail."),
        "role-summary": createElement("", "<div>stale summary</div>"),
        "role-tasks": createContainer([{ stale: true }]),
        "role-tasks-empty": createElement("No tasks have been recorded for this role."),
        "prompts-link": createElement(),
        "config-link": createElement()
      },
      fetchImpl: async () => createJsonResponse(404, {
        error: "Role not found for thread_id=does-not-exist-xyz"
      })
    });

    await page.hooks.setupRoleDetail();

    expect(page.elements["role-title"].textContent).toBe("Role unavailable");
    expect(page.elements["role-subtitle"].textContent).toBe("Role not found for thread_id=does-not-exist-xyz");
    expect(page.elements["role-summary"].innerHTML).toBe("");
    expect(page.elements["role-tasks"].children).toEqual([]);
    expect(page.elements["role-tasks-empty"].textContent).toBe("Role data unavailable.");
    expect(page.elements["role-tasks-empty"].hidden).toBe(false);
    expect(page.elements["prompts-link"].href).toBe("/role/does-not-exist-xyz/prompts");
    expect(page.elements["config-link"].href).toBe("/role/does-not-exist-xyz/config");
  });

  it("binds anchor clicks to explicit location navigation", async () => {
    const page = await loadBrowserApp({
      pathname: "/",
      elements: {},
      fetchImpl: async () => createJsonResponse(200, {})
    });

    const link = createElement();
    link.href = "/role/dispatcher-f";
    page.hooks.bindLocationNavigation(link);

    expect(page.location.href).toBe("/");
    expect(page.location.pathname).toBe("/");
    expect(link.listeners.click).toHaveLength(1);

    await link.listeners.click[0]({
      preventDefault() {
        return undefined;
      }
    });

    expect(page.location.href).toBe("/role/dispatcher-f");
    expect(page.location.pathname).toBe("/role/dispatcher-f");
  });

  it("renders agent-dispatcher role detail with session log and dispatch plan status", async () => {
    const page = await loadBrowserApp({
      pathname: "/role/agent-dispatcher-f",
      elements: {
        "dashboard-link": createElement(),
        "role-title": createElement("Loading role…"),
        "role-subtitle": createElement("Fetching dispatcher detail."),
        "role-summary": createElement(),
        "role-panel-links": createElement(),
        "role-tasks-panel": createElement(),
        "role-tasks": createContainer([{ stale: true }]),
        "role-tasks-empty": createElement("No tasks have been recorded for this role."),
        "prompts-link": createElement(),
        "config-link": createElement(),
        "dispatcher-session-panel": createElement(),
        "dispatcher-session-log": createElement(),
        "dispatch-plan-panel": createElement(),
        "dispatch-plan-empty": createElement("No dispatch plan rows available."),
        "dispatch-plan-table-shell": createElement(),
        "dispatch-plan-body": createElement()
      },
      fetchImpl: async () => createJsonResponse(200, {
        thread_id: "agent-dispatcher-f",
        role_type: "agent-dispatcher",
        status: "paused",
        tasks: [],
        dispatcher_thread_id: "dispatcher-thread-123",
        current_worker: "N-11",
        agent_type: "codex",
        mode: "bridge",
        session_log: [
          "Detail for trace=trace-123 thread=dispatcher-thread-123",
          "",
          "Your message:",
          "Run worker N-11",
          "",
          "Agent reply:",
          "Updated the GUI dashboard."
        ],
        dispatch_details: [
          {
            worker_id: "N-11",
            status: "running",
            task: "GUI",
            model: "CODEX",
            applied_model: "gpt-5.4",
            worker_thread_id: "worker-thread-11",
            trace_id: "trace-123",
            command: {
              trace_id: "trace-123",
              sender_name: "dispatcher-thread-123",
              sender_agent_type: "codex",
              sender_model: null,
              sender_thread_id: "dispatcher-thread-123",
              timestamp: "2026-04-14T10:00:00.000Z",
              content: "Implement the GUI dispatcher detail page update."
            },
            reply: {
              trace_id: "trace-123",
              sender_name: "worker-thread-11",
              sender_agent_type: "codex",
              sender_model: "gpt-5.4",
              sender_thread_id: "worker-thread-11",
              timestamp: "2026-04-14T10:03:00.000Z",
              content: "Updated the GUI dashboard."
            }
          }
        ],
        dispatch_plan: {
          rows: [
            {
              status: "✅",
              batch: "5",
              worker: "N-10",
              task: "API Layer",
              model: "CODEX-XHIGH",
              depends_on: "N-09"
            },
            {
              status: "🔄",
              batch: "6",
              worker: "N-11",
              task: "GUI",
              model: "CODEX",
              depends_on: "N-10"
            }
          ]
        }
      })
    });

    await page.hooks.setupRoleDetail();

    expect(page.elements["role-title"].textContent).toBe("agent-dispatcher-f");
    expect(page.elements["role-subtitle"].textContent).toBe("Dispatcher control session.");
    expect(page.elements["role-panel-links"].hidden).toBe(false);
    expect(page.elements["role-tasks-panel"].hidden).toBe(true);
    expect(page.elements["dispatcher-session-panel"].hidden).toBe(false);
    expect(page.elements["dispatch-plan-panel"].hidden).toBe(false);
    expect(page.elements["dispatcher-session-log"].textContent).toContain("Updated the GUI dashboard.");
    expect(page.elements["dispatch-plan-empty"].hidden).toBe(true);
    expect(page.elements["dispatch-plan-table-shell"].hidden).toBe(false);
    expect(page.elements["dispatch-plan-body"].innerHTML).toContain("N-11");
    expect(page.elements["dispatch-plan-body"].innerHTML).toContain('class="dispatch-detail-card"');
    expect(page.elements["dispatch-plan-body"].innerHTML).not.toContain('class="dispatch-detail-card" open');
    expect(page.elements["dispatch-plan-body"].innerHTML).toContain("Implement the GUI dispatcher detail page update.");
    expect(page.elements["dispatch-plan-body"].innerHTML).toContain("Updated the GUI dashboard.");
    expect(page.elements["role-summary"].innerHTML).toContain("dispatcher-thread-123");
    expect(page.elements["prompts-link"].href).toBe("/role/agent-dispatcher-f/prompts");
    expect(page.elements["config-link"].href).toBe("/role/agent-dispatcher-f/config");
  });

  it("loads and saves dispatcher config JSON in the browser client", async () => {
    const patchBodies: unknown[] = [];
    const page = await loadBrowserApp({
      pathname: "/role/dispatcher-f/config",
      elements: {
        "config-title": createElement("Loading config…"),
        "config-detail-link": createElement(),
        "config-status": createElement(),
        "config-feedback": createElement(),
        "config-form": createFormElement(),
        "config-input": createInputElement(),
        "config-save-button": createButtonElement()
      },
      fetchImpl: async (url, init) => {
        if (!init?.method || init.method === "GET") {
          return createJsonResponse(200, {
            thread_id: "dispatcher-f",
            status: "active",
            can_edit: true,
            config: {
              tasks: [
                {
                  task_id: "task-a",
                  instruction: "Run task A",
                  depends_on: []
                }
              ],
              taskspec: "before"
            }
          });
        }

        if (init.method === "PATCH") {
          patchBodies.push(init.body ? JSON.parse(String(init.body)) : null);
          return createJsonResponse(200, {
            thread_id: "dispatcher-f",
            status: "active",
            can_edit: true,
            config: {
              tasks: [
                {
                  task_id: "task-a",
                  instruction: "Run task A better",
                  depends_on: []
                }
              ],
              taskspec: "after"
            }
          });
        }

        throw new Error(`Unexpected request: ${init.method || "GET"} ${url}`);
      }
    });

    await page.hooks.setupConfigEditor();

    expect(page.elements["config-title"].textContent).toBe("dispatcher-f");
    expect(page.elements["config-detail-link"].href).toBe("/role/dispatcher-f");
    expect(page.elements["config-feedback"].textContent).toBe("Dispatcher config loaded.");
    expect(page.elements["config-input"].value).toContain('"taskspec": "before"');

    page.elements["config-input"].value = JSON.stringify({
      tasks: [
        {
          task_id: "task-a",
          instruction: "Run task A better",
          depends_on: []
        }
      ],
      taskspec: "after"
    }, null, 2);

    await page.submit("config-form");

    expect(patchBodies).toEqual([
      {
        tasks: [
          {
            task_id: "task-a",
            instruction: "Run task A better",
            depends_on: []
          }
        ],
        taskspec: "after"
      }
    ]);
    expect(page.elements["config-feedback"].textContent).toBe("Dispatcher config saved.");
    expect(page.elements["config-input"].value).toContain('"taskspec": "after"');
  });

  it("disables config saves when the server marks the dispatcher read-only", async () => {
    const page = await loadBrowserApp({
      pathname: "/role/dispatcher-f/config",
      elements: {
        "config-title": createElement("Loading config…"),
        "config-detail-link": createElement(),
        "config-status": createElement(),
        "config-feedback": createElement(),
        "config-form": createFormElement(),
        "config-input": createInputElement(),
        "config-save-button": createButtonElement()
      },
      fetchImpl: async () => createJsonResponse(200, {
        thread_id: "dispatcher-f",
        status: "active",
        can_edit: false,
        blocked_reason: "Cannot edit dispatcher config while tasks are running",
        config: {
          tasks: [],
          taskspec: "locked"
        }
      })
    });

    await page.hooks.setupConfigEditor();

    expect(page.elements["config-input"].readOnly).toBe(true);
    expect(page.elements["config-save-button"].disabled).toBe(true);
    expect(page.elements["config-status"].textContent).toBe("Cannot edit dispatcher config while tasks are running");
    expect(page.elements["config-feedback"].textContent).toBe("Cannot edit dispatcher config while tasks are running");
  });

  it("shows agent-dispatcher launch config as structured editable fields in the browser client", async () => {
    const patchBodies: unknown[] = [];
    const page = await loadBrowserApp({
      pathname: "/role/agent-dispatcher-f/config",
      elements: {
        "config-title": createElement("Loading config…"),
        "config-detail-link": createElement(),
        "config-lede": createElement(),
        "config-section-title": createElement(),
        "config-status": createElement(),
        "config-feedback": createElement(),
        "config-form": createFormElement(),
        "config-fields": createElement(),
        "config-raw-field": createElement(),
        "cfg-dispatch-plan-path": createInputElement(),
        "cfg-command-file-path": createInputElement(),
        "cfg-dispatch-repo-root": createInputElement(),
        "cfg-docs-root": createInputElement(),
        "cfg-agent-type": createInputElement(),
        "cfg-model-id": createInputElement(),
        "cfg-mode": createInputElement(),
        "cfg-kill-policy": createInputElement(),
        "cfg-auto-approve": createInputElement(),
        "cfg-reply-channels": createInputElement(),
        "config-input": createInputElement(),
        "config-save-button": createButtonElement()
      },
      fetchImpl: async (_url, init) => {
        if (!init?.method || init.method === "GET") {
          return createJsonResponse(200, {
            thread_id: "agent-dispatcher-f",
            status: "active",
            can_edit: true,
            config: {
              dispatch_plan_path: "/tmp/dispatch_plan.md",
              command_file_path: "/tmp/agent_dispatch_command.md",
              dispatch_repo_root: "/tmp/repo",
              docs_root: "/tmp/docs",
              user_reply_channels: [
                {
                  channel: "telegram",
                  chat_id: "telegram:ops"
                }
              ],
              agent_type: "codex",
              mode: "bridge",
              kill_policy: "always",
              auto_approve: false
            }
          });
        }

        if (init.method === "PATCH") {
          patchBodies.push(init.body ? JSON.parse(String(init.body)) : null);
          return createJsonResponse(200, {
            thread_id: "agent-dispatcher-f",
            status: "active",
            can_edit: true,
            config: {
              dispatch_plan_path: "/tmp/dispatch_plan.md",
              command_file_path: "/tmp/agent_dispatch_command.md",
              dispatch_repo_root: "/tmp/repo",
              docs_root: "/tmp/docs",
              user_reply_channels: [
                {
                  channel: "telegram",
                  chat_id: "telegram:ops"
                }
              ],
              agent_type: "claude",
              model_id: "claude-opus-4-7",
              mode: "bridge",
              kill_policy: "never",
              auto_approve: true
            }
          });
        }

        throw new Error(`Unexpected request: ${init.method}`);
      }
    });

    await page.hooks.setupConfigEditor();

    expect(page.elements["config-title"].textContent).toBe("agent-dispatcher-f");
    expect(page.elements["config-detail-link"].href).toBe("/role/agent-dispatcher-f");
    expect(page.elements["config-section-title"].textContent).toBe("Launch Config");
    expect(page.elements["config-fields"].hidden).toBe(false);
    expect(page.elements["config-raw-field"].hidden).toBe(true);
    expect(page.elements["cfg-dispatch-plan-path"].value).toBe("/tmp/dispatch_plan.md");
    expect(page.elements["cfg-agent-type"].value).toBe("codex");
    expect(page.elements["config-save-button"].disabled).toBe(false);
    expect(page.elements["config-feedback"].textContent).toBe("Dispatcher config loaded.");

    page.elements["cfg-agent-type"].value = "claude";
    page.elements["cfg-model-id"].value = "claude-opus-4-7";
    page.elements["cfg-mode"].value = "bridge";
    page.elements["cfg-kill-policy"].value = "never";
    page.elements["cfg-auto-approve"].value = "true";

    await page.submit("config-form");

    expect(patchBodies).toEqual([
      {
        agent_type: "claude",
        model_id: "claude-opus-4-7",
        mode: "bridge",
        kill_policy: "never",
        auto_approve: true
      }
    ]);
    expect(page.elements["config-feedback"].textContent).toBe("Dispatcher config saved.");
  });
});

interface HttpHarness {
  commandFilePath: string;
  dispatchPlanPath: string;
  dispatchRepoRoot: string;
  docsRoot: string;
  requestJson<T>(method: string, pathname: string, body?: unknown): Promise<T>;
  requestText(pathname: string): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

async function startHttpHarness(): Promise<HttpHarness> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-scenario-f-"));
  const docsRoot = path.join(baseDir, "docs");
  const dispatchRepoRoot = path.join(baseDir, "repo");
  const dispatchPlanPath = path.join(docsRoot, "dispatch_plan.md");
  const commandFilePath = path.join(docsRoot, "agent_dispatch_command.md");
  const stateFilePath = path.join(baseDir, "state.json");
  const port = await getFreePort();
  const stateStore = new StateStore(stateFilePath);
  const registry = new RoleRegistry();

  await fs.mkdir(docsRoot, { recursive: true });
  await fs.mkdir(dispatchRepoRoot, { recursive: true });
  await fs.writeFile(dispatchPlanPath, formatDispatchPlan([
    {
      worker: "W-GUI",
      task: "Verify GUI routes"
    }
  ]), "utf8");
  await fs.writeFile(commandFilePath, "# Agent Dispatch Command\n", "utf8");

  const createAgentDispatcherRole = (threadId: string, config: unknown) => new AgentDispatcherRole(threadId, config, {
    stateStore,
    launchDispatcher: async (): Promise<LaunchResult> => ({
      ok: true,
      threadId: "dispatcher-thread-f"
    })
  });
  registry.register("agent-dispatcher", createAgentDispatcherRole);
  registry.register("dispatcher", createAgentDispatcherRole);

  const roleHandlers = createRoleHandlers({
    runner: new RoleRunner({
      sendToHub: async () => undefined,
      listInstances: () => [],
      log: createLogger()
    }),
    registry,
    stateStore,
    log: createLogger()
  });

  const promptStore = new PromptStore({
    stateStore,
    resolveRole: roleHandlers.resolveRole
  });
  const promptHandlers = createPromptHandlers(promptStore);
  const server = new HttpServer({
    port,
    roleHandlers,
    promptHandlers,
    log: createLogger()
  });

  await server.listen();

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    commandFilePath,
    dispatchPlanPath,
    dispatchRepoRoot,
    docsRoot,
    async requestJson(method, pathname, body) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `Request failed: ${response.status}`);
      }

      return payload as T;
    },
    async requestText(pathname) {
      const response = await fetch(`${baseUrl}${pathname}`);
      return {
        status: response.status,
        body: await response.text()
      };
    },
    async close() {
      await Promise.allSettled([
        server.close(),
        fs.rm(baseDir, { recursive: true, force: true })
      ]);
    }
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected an ephemeral TCP port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

interface BrowserPage {
  elements: Record<string, FakeElement>;
  hooks: {
    bindLocationNavigation(link: FakeElement): void;
    setupConfigEditor(): Promise<void>;
    setupRoleDetail(): Promise<void>;
  };
  location: {
    href: string;
    pathname: string;
  };
  submit(id: string): Promise<void>;
}

async function loadBrowserApp(options: {
  pathname: string;
  elements: Record<string, FakeElement>;
  fetchImpl(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}): Promise<BrowserPage> {
  const appPath = path.resolve(__dirname, "../../src/web/public/app.js");
  const source = await fs.readFile(appPath, "utf8");
  const documentListeners = new Map<string, Array<() => void>>();
  const location = {
    href: options.pathname,
    pathname: options.pathname,
    assign(next: string) {
      this.href = next;
      this.pathname = next;
    }
  };
  const context = {
    console,
    fetch: options.fetchImpl,
    document: {
      body: {
        dataset: {
          page: "test"
        }
      },
      addEventListener(type: string, handler: () => void) {
        const current = documentListeners.get(type) ?? [];
        current.push(handler);
        documentListeners.set(type, current);
      },
      getElementById(id: string) {
        return options.elements[id] ?? null;
      }
    },
    window: {
      location,
      setInterval() {
        return 1;
      }
    }
  };

  const script = new vm.Script(`${source}\nthis.__hooks = { bindLocationNavigation, setupConfigEditor, setupRoleDetail };`);
  vm.createContext(context);
  script.runInContext(context);

  return {
    elements: options.elements,
    hooks: (context as { __hooks: BrowserPage["hooks"] }).__hooks,
    location,
    async submit(id: string) {
      const element = options.elements[id];
      if (!element?.listeners.submit?.[0]) {
        throw new Error(`No submit listener registered for ${id}`);
      }

      await element.listeners.submit[0]({
        preventDefault() {
          return undefined;
        }
      });
    }
  };
}

interface FakeElement {
  children: unknown[];
  disabled: boolean;
  hidden: boolean;
  href: string;
  innerHTML: string;
  listeners: Record<string, Array<(event: { preventDefault(): void }) => Promise<void> | void>>;
  readOnly: boolean;
  textContent: string;
  value: string;
  addEventListener(type: string, handler: (event: { preventDefault(): void }) => Promise<void> | void): void;
  replaceChildren(...children: unknown[]): void;
}

function createElement(textContent = "", innerHTML = ""): FakeElement {
  return {
    children: [],
    disabled: false,
    hidden: false,
    href: "",
    innerHTML,
    listeners: {},
    readOnly: false,
    textContent,
    value: "",
    addEventListener(type, handler) {
      this.listeners[type] ??= [];
      this.listeners[type].push(handler);
    },
    replaceChildren(...children) {
      this.children = [...children];
      this.innerHTML = "";
    }
  };
}

function createContainer(children: unknown[] = []): FakeElement {
  const element = createElement();
  element.children = [...children];
  return element;
}

function createFormElement(): FakeElement {
  return createElement();
}

function createInputElement(): FakeElement {
  const element = createElement();
  element.value = "";
  return element;
}

function createButtonElement(): FakeElement {
  return createElement();
}

function createJsonResponse(status: number, body: unknown): { ok: boolean; status: number; text(): Promise<string> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

function createLogger() {
  return {
    info() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    error() {
      return undefined;
    }
  };
}
