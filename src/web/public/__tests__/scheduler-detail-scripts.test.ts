import * as fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

describe("scheduler detail public scripts", () => {
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
});

function extractInlineScripts(html: string): string[] {
  return Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
}

function createElementStub(): Record<string, unknown> {
  return {
    addEventListener: () => undefined,
    className: "",
    dataset: {},
    hidden: false,
    innerHTML: "",
    textContent: "",
    value: ""
  };
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
