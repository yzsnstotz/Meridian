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
    // Model dropdowns include the full curated catalog (codex 5.2/5.3/5.4/5.5
    // tiers + claude-opus 4.6/4.7 + claude-sonnet + gemini); the previous
    // `not.toContain` assertions on `gpt-5.4 high|xhigh` and `claude-opus-4-6`
    // were a tighter-than-needed gate that prevented operators from picking
    // those models in the GUI even though they are valid provider entries.
    expect(indexHtml).not.toContain('id="new-scheduler-model-map"');
    expect(indexHtml).toContain('id="new-scheduler-scan-run-id-strategy" name="scan_run_id_strategy"');
    expect(indexHtml).toContain('id="new-scheduler-scan-run-id-prefix" name="scan_run_id_prefix"');
    expect(indexHtml).toMatch(/<select id="agent-dispatcher-mode" name="mode">\s*<option value="bridge">bridge<\/option>/);
    expect(indexHtml).toMatch(/<input[^>]*id="agent-dispatcher-auto-approve"[^>]*name="auto_approve"[^>]*type="checkbox"[^>]*checked[^>]*\/>/);
    expect(indexHtml).toMatch(/<select id="new-scheduler-agent-mode" name="mode">\s*<option value="bridge">bridge<\/option>/);
    expect(indexHtml).toMatch(/<input[^>]*id="new-scheduler-auto-approve"[^>]*name="auto_approve"[^>]*type="checkbox"[^>]*checked[^>]*\/>/);
    // model_id text input fallbacks must be gone from index.html (regression:
    // every former <input id="*-model-id" type="text"> is now a <select>).
    expect(indexHtml).not.toMatch(/<input[^>]*id="agent-dispatcher-model-id"[^>]*type="text"/);
    expect(indexHtml).not.toMatch(/<input[^>]*id="agent-dispatcher-validator-model-id"[^>]*type="text"/);
    expect(indexHtml).not.toMatch(/<input[^>]*id="agent-dispatcher-pm-model-id"[^>]*type="text"/);
    expect(indexHtml).not.toMatch(/<input[^>]*id="new-scheduler-pm-model-id"[^>]*type="text"/);

    expect(schedulerHtml).toContain('<select id="cfg-model-id" name="model_id">');
    expect(schedulerHtml).not.toContain('<input id="cfg-model-id"');
    expect(schedulerHtml).toContain('<option value="gpt-5.5 high">codex: gpt-5.5 high</option>');
    expect(schedulerHtml).toContain('<option value="gpt-5.5 xhigh">codex: gpt-5.5 xhigh</option>');
    expect(schedulerHtml).toContain('<option value="claude-opus-4-7">claude: claude-opus-4-7</option>');
    expect(schedulerHtml).not.toContain('id="cfg-model-map"');
    expect(schedulerHtml).toContain('id="cfg-scan-run-id-strategy" name="scan_run_id_strategy"');
    expect(schedulerHtml).toContain('id="cfg-scan-run-id-prefix" name="scan_run_id_prefix"');
    expect(styleCss).toContain("[hidden]");
    expect(styleCss).toContain("display: none !important");
  });

  it("keeps dispatcher and scheduler status/action headers sticky", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const roleHtml = await fs.readFile(path.join(publicDir, "role.html"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const styleCss = await fs.readFile(path.join(publicDir, "style.css"), "utf8");

    expect(roleHtml).toMatch(/<section class="[^"]*\bpanel\b[^"]*\bdetail-sticky-head\b[^"]*">/);
    expect(schedulerHtml).toContain('<section class="detail-sticky-head scheduler-sticky-head"');
    expect(styleCss).toContain("--detail-sticky-top: 64px");
    expect(styleCss).toMatch(/\.detail-sticky-head\s*{[^}]*position:\s*sticky;[^}]*top:\s*var\(--detail-sticky-top\);[^}]*z-index:\s*90;/s);
  });

  it("renders every validator cycle in dispatcher detail validation output", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const html = vm.runInContext(`renderDispatchValidationMessage({
      current_cycle: 2,
      max_fix_cycles: 3,
      validator_thread_id: null,
      last_score: 0.92,
      last_feedback: "Cycle two passed.",
      history: [
        {
          cycle: 1,
          score: 0.68,
          feedback: "Cycle one needs a symbol map.",
          validator_thread_id: "validator-thread-1",
          timestamp: "2026-04-08T00:30:00.000Z"
        },
        {
          cycle: 2,
          score: 0.92,
          feedback: "Cycle two passed.",
          validator_thread_id: "validator-thread-2",
          timestamp: "2026-04-08T00:40:00.000Z"
        }
      ]
    })`, context) as string;

    expect(html).toContain("Cycle: 1/3");
    expect(html).toContain("Score: 0.68");
    expect(html).toContain("Cycle one needs a symbol map.");
    expect(html).toContain("validator-thread-1");
    expect(html).toContain("Cycle: 2/3");
    expect(html).toContain("Score: 0.92");
    expect(html).toContain("Cycle two passed.");
    expect(html).toContain("validator-thread-2");
  });

  it("renders PM resolver dispatch details with PM-specific labels", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const html = vm.runInContext(`renderDispatchDetailCard({
      detail_kind: "pm_resolver",
      worker_id: "PM:BATCH-1-GATE",
      status: "running",
      task: "Resolve BATCH-1-GATE: manual_intervention_required",
      model: "PM",
      applied_model: "gpt-5.5",
      worker_thread_id: "codex_42",
      trace_id: "44444444-4444-4444-8444-444444444444",
      command: {
        sender_name: "agent-dispatcher-a9a66025",
        sender_agent_type: "dispatcher",
        sender_model: null,
        sender_thread_id: "agent-dispatcher-a9a66025",
        timestamp: "2026-05-03T00:01:00.000Z",
        content: "Issue status: manual_intervention_required"
      },
      reply: {
        sender_name: "codex_42",
        sender_agent_type: "codex",
        sender_model: "gpt-5.5",
        sender_thread_id: "codex_42",
        timestamp: "2026-05-03T00:05:00.000Z",
        content: "PM is resolving the blocker."
      }
    })`, context) as string;

    expect(html).toContain("PM:BATCH-1-GATE");
    expect(html).toContain("PM Resolver Context");
    expect(html).toContain("PM Resolve Reply");
    expect(html).toContain("PM is resolving the blocker.");
  });

  it("renders PM resolver replies under the associated dispatch plan row", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const html = vm.runInContext(`renderDispatchPlanRows([
      {
        status: "⛔ BLOCKED",
        batch: "2",
        worker: "N-07",
        task: "Migration 035",
        model: "CODEX-HIGH",
        depends_on: "BATCH-1-GATE"
      }
    ], [
      {
        worker_id: "N-07",
        status: "blocked",
        task: "Migration 035",
        model: "CODEX-HIGH",
        worker_thread_id: "codex_44",
        command: { content: "Run N-07." },
        reply: { content: "Recovered blocked worker report." }
      },
      {
        detail_kind: "pm_resolver",
        worker_id: "PM:N-07",
        status: "running",
        task: "Resolve N-07",
        model: "PM",
        worker_thread_id: "codex_45",
        command: { content: "Issue status: manual_intervention_required" },
        reply: { content: "PM is working on N-07." }
      },
      {
        detail_kind: "pm_resolver",
        worker_id: "PM:N-07",
        status: "completed",
        task: "Resolve N-07 follow-up",
        model: "PM",
        worker_thread_id: "codex_46",
        command: { content: "Issue status: manual_intervention_required" },
        reply: { content: "PM verified the blocker." }
      }
    ])`, context) as string;

    expect(html).toContain("Agent Reply");
    expect(html).toContain("Recovered blocked worker report.");
    expect(html.match(/PM Resolve Reply/g)).toHaveLength(2);
    expect(html).toContain("PM is working on N-07.");
    expect(html).toContain("PM verified the blocker.");
    expect(html).not.toContain("dispatch-plan-row-orphan");
  });

  it("prefers a running PM resolver in the agent dispatcher summary", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const html = vm.runInContext(`renderPmResolverSummaryItem({
      dispatch_details: [
        {
          detail_kind: "pm_resolver",
          worker_id: "PM:N-06",
          status: "completed",
          worker_thread_id: "codex_40"
        },
        {
          detail_kind: "pm_resolver",
          worker_id: "PM:N-07",
          status: "running",
          worker_thread_id: "codex_45"
        }
      ]
    })`, context) as string;

    expect(html).toContain("running");
    expect(html).toContain("codex_45");
    expect(html).toContain("N-07");
    expect(html).toContain("2 total");
  });

  it("enables role detail continuation for workers waiting on validation", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const controls = vm.runInContext(`resolveDispatcherDetailControls({
      status: "active",
      dispatcher_thread_id: "dispatcher-thread",
      dispatch_details: [
        {
          worker_id: "N-06",
          status: "awaiting_validation",
          worker_thread_id: "codex_139",
          model: "CODEX-XHIGH"
        }
      ],
      dispatch_plan: {
        rows: [
          {
            worker: "N-06",
            status: "🔍",
            thread_id: "codex_139",
            model: "CODEX-XHIGH"
          }
        ]
      }
    })`, context) as {
      showContinue: boolean;
      continueDisabled: boolean;
      showLifecycle: boolean;
    };

    expect(controls).toMatchObject({
      showContinue: true,
      continueDisabled: false,
      showLifecycle: true,
      lifecycleAction: "pause",
      lifecycleLabel: "Pause"
    });
  });

  it("keeps the Pause control available while a recoverable worker is queued for continuation", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const controls = vm.runInContext(`resolveDispatcherDetailControls({
      status: "active",
      dispatcher_thread_id: "dispatcher-thread",
      continue_worker: "N-12",
      dispatch_details: [
        {
          worker_id: "N-12",
          status: "pending",
          worker_thread_id: "",
          model: "CODEX-XHIGH"
        }
      ]
    })`, context) as {
      showContinue: boolean;
      continueDisabled: boolean;
      showLifecycle: boolean;
      lifecycleAction: string;
      lifecycleLabel: string;
    };

    expect(controls).toMatchObject({
      showContinue: true,
      continueDisabled: false,
      showLifecycle: true,
      lifecycleAction: "pause",
      lifecycleLabel: "Pause"
    });
  });

  it("hides the Pause control when the dispatcher has no live hub thread", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const controls = vm.runInContext(`resolveDispatcherDetailControls({
      status: "needs_reactivation",
      dispatcher_thread_id: "",
      dispatch_details: []
    })`, context) as {
      showLifecycle: boolean;
      lifecycleAction: string | null;
    };

    expect(controls).toMatchObject({
      showLifecycle: false,
      lifecycleAction: null
    });
  });

  it("shows an Idle indicator and Start hub recovery for an active role with no live hub thread", async () => {
    // Even when the dispatcher is parked behind a human gate (or just woken up
    // after a process restart), the operator must be able to spawn a hub
    // thread from the role detail page — otherwise an "active" dispatcher
    // whose thread died is silently locked out of all controls. The Idle
    // indicator marks the parked state without removing the recovery path.
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const controls = vm.runInContext(`resolveDispatcherDetailControls({
      status: "active",
      dispatcher_thread_id: "",
      continue_worker: null,
      dispatch_details: [],
      dispatch_plan: {
        rows: [
          {
            worker: "V-01-B",
            status: "⬜",
            model: "HUMAN"
          },
          {
            worker: "N-16",
            status: "⬜",
            model: "CODEX-XHIGH"
          }
        ]
      }
    })`, context) as {
      showContinue: boolean;
      continueLabel: string;
      continueDisabled: boolean;
      showLifecycle: boolean;
      showStartHub: boolean;
    };

    expect(controls).toMatchObject({
      showContinue: true,
      continueLabel: "Idle",
      continueDisabled: true,
      showLifecycle: false,
      showStartHub: true
    });
  });

  it("exposes validator threshold_type controls in dispatcher creation and config editing", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const indexHtml = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    const configHtml = await fs.readFile(path.join(publicDir, "config.html"), "utf8");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");

    expect(indexHtml).toContain('id="agent-dispatcher-validator-threshold-type"');
    expect(indexHtml).toContain('<option value="score">score</option>');
    expect(indexHtml).toContain('<option value="binary">binary</option>');
    expect(configHtml).toContain('id="cfg-validator-threshold-type"');
    expect(appScript).toContain("threshold_type:");
    expect(appScript).toContain("agent-dispatcher-validator-threshold-type");
    expect(appScript).toContain("cfg-validator-threshold-type");
  });

  it("exposes default-on PM resolver controls in dispatcher and scheduler creation", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const indexHtml = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    const configHtml = await fs.readFile(path.join(publicDir, "config.html"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");

    expect(indexHtml).toMatch(/id="agent-dispatcher-pm-enabled"[^>]*checked/);
    expect(indexHtml).toMatch(/id="new-scheduler-pm-enabled"[^>]*checked/);
    expect(configHtml).toContain('id="cfg-pm-enabled"');
    expect(schedulerHtml).toContain('id="cfg-pm-enabled"');
    expect(appScript).toContain("collectPmResolverConfig");
    expect(appScript).toContain("pm_resolver");
  });

  it("renders agent dispatcher role plan progress when progress data is available", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const roleHtml = await fs.readFile(path.join(publicDir, "role.html"), "utf8");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const context = vm.createContext({
      console,
      document: {
        body: { dataset: { page: "test" } },
        addEventListener: () => undefined,
        getElementById: () => null,
        querySelectorAll: () => []
      },
      fetch: async () => jsonResponse({}),
      setInterval: () => undefined,
      URLSearchParams,
      window: {
        location: {
          pathname: "/role/agent-dispatcher-test",
          search: ""
        }
      }
    });

    vm.runInContext(appScript, context, { filename: "app.js" });
    const html = vm.runInContext(`renderDispatchPlanRow({
      status: "🔄",
      batch: "4",
      worker: "W-DETAIL",
      task: "Fetch detail rows",
      model: "CODEX-HIGH",
      depends_on: "W-CATALOG",
      progress: {
        progress_path: "/tmp/detail-fetch.progress.json",
        source: "progress_file",
        command: "detail-fetch",
        scan_run_id: "daily-2026-05-02",
        status: "running",
        total: 100,
        processed: 40,
        success: 39,
        failed: 1,
        skipped: 0,
        skipped_existing: 0,
        remaining: 60,
        started_at: "2026-05-02T00:00:00.000Z",
        updated_at: "2026-05-02T00:10:00.000Z",
        completed_at: null,
        pid: 123,
        rate_limit_waits: 0,
        last_skill: null
      }
    })`, context) as string;

    expect(roleHtml).toContain("<th>Progress</th>");
    expect(html).toContain("detail-fetch");
    expect(html).toContain("40 / 100 processed");
    expect(html).toContain("60 remaining; 39 success, 1 failed, 0 skipped");
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
      mode: { value: "bridge" },
      auto_approve: { checked: true },
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
        mode: "bridge",
        auto_approve: true,
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
              mode: "bridge",
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
    expect(getElementStub(elements, "cfg-agent-mode")).toMatchObject({ value: "bridge" });
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
    expect(html).toContain("data-worker-model");
    expect(html).toContain("data-worker-effort");
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

  it("routes reset-to-pending status apply through resume-worker to clear hub_result", async () => {
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
        statusApply: true,
        selectedStatus: "pending"
      })
    });

    expect(requests).toContainEqual({
      url: "/api/scheduler/scheduler-gui-actions/worker/R-01/resume",
      method: "POST",
      body: { action: "retry" }
    });
    const statusPatch = requests.find((entry) => entry.url.endsWith("/status") && entry.method === "PATCH");
    expect(statusPatch).toBeUndefined();
  });

  it("sends model and effort overrides when set in the scheduler dispatch status controls", async () => {
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
        statusApply: true,
        selectedStatus: "completed",
        selectedModel: "gpt-5.5 xhigh",
        selectedReasoningEffort: "xhigh"
      })
    });

    expect(requests).toContainEqual({
      url: "/api/scheduler/scheduler-gui-actions/worker/R-01/status",
      method: "PATCH",
      body: {
        status: "completed",
        model: "gpt-5.5 xhigh",
        reasoning_effort: "xhigh"
      }
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
  private readonly selectedModel: string;
  private readonly selectedReasoningEffort: string;

  constructor(options: {
    workerId: string;
    resumeAction?: string;
    statusApply?: boolean;
    selectedStatus?: string;
    selectedModel?: string;
    selectedReasoningEffort?: string;
  }) {
    super();
    this.workerId = options.workerId;
    this.resumeAction = options.resumeAction;
    this.statusApply = Boolean(options.statusApply);
    this.selectedStatus = options.selectedStatus ?? "pending";
    this.selectedModel = options.selectedModel ?? "";
    this.selectedReasoningEffort = options.selectedReasoningEffort ?? "";
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
      return new FakeTableRow(this.selectedStatus, this.selectedModel, this.selectedReasoningEffort);
    }

    return null;
  }
}

class FakeTableRow extends FakeElement {
  private readonly selectedStatus: string;
  private readonly selectedModel: string;
  private readonly selectedReasoningEffort: string;

  constructor(selectedStatus: string, selectedModel: string, selectedReasoningEffort: string) {
    super();
    this.selectedStatus = selectedStatus;
    this.selectedModel = selectedModel;
    this.selectedReasoningEffort = selectedReasoningEffort;
  }

  override querySelector(selector: string): FakeElement | null {
    if (selector === "[data-worker-status]") {
      return new FakeSelect(this.selectedStatus);
    }
    if (selector === "[data-worker-model]") {
      return new FakeSelect(this.selectedModel);
    }
    if (selector === "[data-worker-effort]") {
      return new FakeSelect(this.selectedReasoningEffort);
    }
    return null;
  }
}
