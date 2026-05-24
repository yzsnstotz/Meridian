import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import dispatchStartTool, {
  parseDispatchPlanModelLegend,
  parseInlineModelMap
} from "../dispatch-start";

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

describe("dispatch-start tool", () => {
  it("starts an agent dispatcher with inline model-map overrides", async () => {
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
        dispatcher_id: "agent-dispatcher-1234",
        dispatcher_thread_id: "hub-thread-5678"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchStartTool.execute({
      plan: harness.planPath,
      model_map: "CODEX=codex:o3-mini,UNKNOWN=claude:claude-sonnet-4-6",
      auto_approve: "true",
      parallel: "true",
      max_concurrency: "3",
      pm_agent_type: "claude",
      pm_model_id: "claude-opus-4-7",
      pm_mode: "bridge",
      pm_auto_approve: "true",
      pm_reply_channels: JSON.stringify([{ channel: "web", chat_id: "web:pm" }])
    });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        dispatch_plan_path: harness.planPath,
        command_file_path: harness.commandFilePath,
        dispatch_repo_root: harness.dispatchRepoRoot,
        docs_root: harness.docsRoot,
        dispatcher_id: "agent-dispatcher-1234",
        dispatcher_thread_id: "hub-thread-5678",
        reply_channel_source: "service",
        auto_approve: true,
        parallel_dispatch: {
          enabled: true,
          max_concurrency: 3
        },
        pm_resolver: {
          enabled: true,
          agent_type: "claude",
          model_id: "claude-opus-4-7",
          mode: "bridge",
          auto_approve: true,
          user_reply_channels: [{ channel: "web", chat_id: "web:pm" }]
        },
        model_map: {
          CODEX: {
            provider: "codex",
            model_id: "o3-mini"
          },
          UNKNOWN: {
            provider: "claude",
            model_id: "claude-sonnet-4-6"
          }
        },
        warnings: [
          'Unknown model code in model_map: UNKNOWN. It will be stored as an override but may be ignored by the dispatcher.'
        ]
      })
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:9999/api/channels");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "GET"
    }));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://127.0.0.1:9999/api/agent-dispatcher/start");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        dispatch_plan_path: harness.planPath,
        command_file_path: harness.commandFilePath,
        dispatch_repo_root: harness.dispatchRepoRoot,
        docs_root: harness.docsRoot,
        user_reply_channels: [
          {
            channel: "telegram",
            chat_id: "telegram:ops"
          }
        ],
        auto_approve: true,
        config: {
          parallel_dispatch: {
            enabled: true,
            max_concurrency: 3
          },
          pm_resolver: {
            enabled: true,
            agent_type: "claude",
            model_id: "claude-opus-4-7",
            mode: "bridge",
            auto_approve: true,
            user_reply_channels: [{ channel: "web", chat_id: "web:pm" }]
          },
          model_map: {
            CODEX: {
              provider: "codex",
              model_id: "o3-mini"
            },
            UNKNOWN: {
              provider: "claude",
              model_id: "claude-sonnet-4-6"
            }
          }
        }
      })
    }));
  });

  it("accepts JSON model_map_file and falls back to web:ops when channels are unavailable", async () => {
    process.env.MERIDIAN_ROLES_HTTP = "http://127.0.0.1:9999";
    const harness = await createPlanHarness();
    const modelMapFilePath = path.join(path.dirname(harness.planPath), "model-map.json");
    await fs.writeFile(modelMapFilePath, JSON.stringify({
      OPUS: {
        provider: "claude",
        model_id: "claude-opus-4-6"
      }
    }), "utf8");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        channels: []
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        dispatcher_id: "agent-dispatcher-1234",
        dispatcher_thread_id: "hub-thread-5678"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchStartTool.execute({
      plan: harness.planPath,
      model_map_file: modelMapFilePath
    });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        auto_approve: false,
        reply_channel_source: "fallback",
        reply_channels: [
          {
            channel: "web",
            chat_id: "web:ops"
          }
        ],
        model_map: {
          OPUS: {
            provider: "claude",
            model_id: "claude-opus-4-6"
          }
        },
        warnings: []
      })
    });
  });

  it("returns service-unreachable metadata when the roles service is down", async () => {
    process.env.MERIDIAN_ROLES_HTTP = "http://127.0.0.1:9999";
    const harness = await createPlanHarness();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const result = await dispatchStartTool.execute({
      plan: harness.planPath
    });

    expect(result).toEqual({
      ok: false,
      error: "Meridian-roles service unreachable at http://127.0.0.1:9999/: fetch failed",
      data: {
        base_url: "http://127.0.0.1:9999/",
        service_unreachable: true,
        exit_code: 3
      }
    });
  });
});

describe("dispatch-start parsing helpers", () => {
  it("parses model legend rows with provider and model_id", () => {
    const legend = parseDispatchPlanModelLegend([
      "| Model | Code | Provider | Model ID | Assign When |",
      "|-------|------|----------|----------|-------------|",
      "| Codex | `CODEX` | `codex` | `o3-mini` | Well-specified |",
      "| Opus | `OPUS` | `claude` | `claude-opus-4-6` | Architecture |",
      ""
    ].join("\n"));

    expect(legend).toEqual({
      CODEX: {
        label: "Codex",
        provider: "codex",
        model_id: "o3-mini"
      },
      OPUS: {
        label: "Opus",
        provider: "claude",
        model_id: "claude-opus-4-6"
      }
    });
  });

  it("supports model legend tables with reasoning effort columns", () => {
    const legend = parseDispatchPlanModelLegend([
      "| Model | Code | Provider | Model ID | Reasoning Effort | Assign When |",
      "|-------|------|----------|----------|-----------------|-------------|",
      "| Codex | `CODEX` | `codex` | `gpt-5.4` | `high` | Well-specified |",
      "| Sonnet | `SONNET` | `claude` | `claude-sonnet-4-6` | `medium` | Moderate |",
      ""
    ].join("\n"));

    expect(legend).toEqual({
      CODEX: {
        label: "Codex",
        provider: "codex",
        model_id: "gpt-5.4"
      },
      SONNET: {
        label: "Sonnet",
        provider: "claude",
        model_id: "claude-sonnet-4-6"
      }
    });
  });

  it("rejects malformed inline model_map entries", () => {
    expect(() => parseInlineModelMap("CODEX=codex")).toThrow("Invalid model_map entry: CODEX=codex");
  });
});

async function createPlanHarness(): Promise<{
  planPath: string;
  commandFilePath: string;
  dispatchRepoRoot: string;
  docsRoot: string;
}> {
  const workspaceRoot = await fs.mkdtemp("/tmp/meridian-roles-dispatch-start-");
  tempDirectories.add(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, ".git"));

  const dispatchRepoRoot = path.join(workspaceRoot, "projects", "clawso");
  await fs.mkdir(path.join(dispatchRepoRoot, ".git"), { recursive: true });

  const planPath = path.join(
    workspaceRoot,
    "Docs",
    "Projects",
    "clawso",
    "branch",
    "feat-cli",
    "taskspec",
    "dispatch_plan.md"
  );
  const commandFilePath = path.join(path.dirname(planPath), "agent_dispatch_command.md");
  await fs.mkdir(path.dirname(planPath), { recursive: true });

  await fs.writeFile(planPath, [
    "# Dispatch Plan",
    "",
    "| Model | Code | Provider | Model ID | Assign When |",
    "|-------|------|----------|----------|-------------|",
    "| Codex | CODEX | codex | o3 | Standard work |",
    "| Opus | OPUS | claude | claude-opus-4-6 | Architecture |",
    "",
    "| Status | Batch | Worker | Task | Model | Depends On |",
    "|--------|-------|--------|------|-------|------------|",
    "| ⬜ | 1 | N-06 | Dispatch start | CODEX | — |",
    ""
  ].join("\n"), "utf8");

  await fs.writeFile(commandFilePath, "# command\n", "utf8");

  return {
    planPath,
    commandFilePath,
    dispatchRepoRoot: await fs.realpath(dispatchRepoRoot),
    docsRoot: await fs.realpath(path.join(workspaceRoot, "Docs"))
  };
}
