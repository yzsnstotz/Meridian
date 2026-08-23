import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import dispatchScheduleSetTool from "../dispatch-schedule-set";

const tempDirectories = new Set<string>();
const originalRolesHttp = process.env.MERIDIAN_ROLES_HTTP;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalRolesHttp === undefined) {
    delete process.env.MERIDIAN_ROLES_HTTP;
  } else {
    process.env.MERIDIAN_ROLES_HTTP = originalRolesHttp;
  }

  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("dispatch-schedule-set tool", () => {
  it("creates a scheduler with explicit repo and docs roots", async () => {
    process.env.MERIDIAN_ROLES_HTTP = "http://127.0.0.1:9999";
    const harness = await createPlanHarness();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ]
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        scheduler_id: "scheduler-1234",
        scheduler_mode: "cron",
        dispatch_plan_path: harness.planPath
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchScheduleSetTool.execute({
      plan: harness.planPath,
      mode: "cron",
      cron: "0 9 * * *",
      report_dir: harness.reportDir,
      repo_root: harness.dispatchRepoRoot,
      docs_root: harness.docsRoot,
      pm_enabled: "false"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        scheduler_id: "scheduler-1234",
        scheduler_mode: "cron",
        dispatch_plan_path: harness.planPath
      }
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:9999/api/channels");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://127.0.0.1:9999/api/scheduler");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        config: {
          dispatch_plan_path: harness.planPath,
          command_file_path: harness.commandFilePath,
          user_reply_channels: [
            {
              channel: "telegram",
              chat_id: "telegram:ops"
            }
          ],
          scheduler_mode: "cron",
          report_base_dir: harness.reportDir,
          dispatch_repo_root: harness.dispatchRepoRoot,
          docs_root: harness.docsRoot,
          cron_expression: "0 9 * * *",
          pm_resolver: {
            enabled: false,
            agent_type: "codex",
            mode: "bridge",
            auto_approve: false
          }
        }
      })
    }));
  });

  it("patches an existing scheduler config via PATCH", async () => {
    process.env.MERIDIAN_ROLES_HTTP = "http://127.0.0.1:9999";
    const harness = await createPlanHarness();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        channels: [
          {
            channel: "web",
            chat_id: "web:ops"
          }
        ]
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        scheduler_id: "scheduler-5678",
        config: {
          scheduler_mode: "loop"
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchScheduleSetTool.execute({
      plan: harness.planPath,
      mode: "loop",
      report_dir: harness.reportDir,
      scheduler_id: "scheduler-5678",
      repo_root: harness.dispatchRepoRoot,
      docs_root: harness.docsRoot,
      delay_between_cycles_seconds: "60"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        scheduler_id: "scheduler-5678",
        action: "updated",
        config: {
          dispatch_plan_path: harness.planPath,
          command_file_path: harness.commandFilePath,
          user_reply_channels: [
            {
              channel: "web",
              chat_id: "web:ops"
            }
          ],
          scheduler_mode: "loop",
          report_base_dir: harness.reportDir,
          dispatch_repo_root: harness.dispatchRepoRoot,
          docs_root: harness.docsRoot,
          pm_resolver: {
            enabled: true,
            agent_type: "codex",
            mode: "bridge",
            auto_approve: false
          },
          delay_between_cycles_seconds: 60
        }
      }
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://127.0.0.1:9999/api/scheduler/scheduler-5678/config");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "PATCH"
    }));
  });
});

async function createPlanHarness(): Promise<{
  planPath: string;
  commandFilePath: string;
  dispatchRepoRoot: string;
  docsRoot: string;
  reportDir: string;
}> {
  const workspaceRoot = await fs.mkdtemp("/tmp/meridian-roles-dispatch-schedule-set-");
  tempDirectories.add(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, ".git"));

  const dispatchRepoRoot = path.join(workspaceRoot, "projects", "clawhub-sync");
  await fs.mkdir(path.join(dispatchRepoRoot, ".git"), { recursive: true });

  const planPath = path.join(
    workspaceRoot,
    "Docs",
    "Projects",
    "clawhub-sync",
    "branch",
    "feat-routine-job",
    "dispatch_plan.md"
  );
  const commandFilePath = path.join(path.dirname(planPath), "agent_dispatch_command.md");
  const docsRoot = path.join(workspaceRoot, "Docs");
  const reportDir = path.join(workspaceRoot, "reports");

  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });

  await fs.writeFile(planPath, [
    "| Done | # | Worker | Task | Depends On | Model | Notes | Output |",
    "|------|---|--------|------|------------|-------|-------|--------|",
    "| ⬜ | 1 | N-01 | Collect skills | — | CODEX | | `reports/N-01.md` |",
    ""
  ].join("\n"), "utf8");
  await fs.writeFile(commandFilePath, "# dispatch command\n", "utf8");

  return {
    planPath,
    commandFilePath,
    dispatchRepoRoot,
    docsRoot,
    reportDir
  };
}
