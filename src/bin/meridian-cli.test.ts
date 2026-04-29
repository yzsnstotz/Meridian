import assert from "node:assert/strict";
import { test } from "node:test";

import type { CliDependencies } from "./meridian-cli";
import type { HubResult } from "../types";

process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
process.env.ALLOWED_USER_IDS ??= "123456789";
process.env.MERIDIAN_DISABLE_WEB_AUTOSTART = "true";

const meridianCliModulePromise = import("./meridian-cli");

type HttpCall = {
  method: string;
  route: string;
  body?: unknown;
};

function buildCliHubResult(overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: "11111111-1111-4111-8111-111111111111",
    thread_id: "codex_01",
    source: "codex",
    status: "success",
    content: "",
    attachments: [],
    timestamp: "2026-04-05T00:00:00.000Z",
    ...overrides
  };
}

function createCliDeps(overrides: Partial<CliDependencies> = {}) {
  const httpCalls: HttpCall[] = [];
  let stdout = "";
  let stderr = "";

  const deps: CliDependencies = {
    connectToHub: async () => ({
      httpBase: "http://127.0.0.1:3000/",
      authenticated: true,
      transport: "http"
    }),
    hubHttpRequest: async (method: string, route: string, body?: unknown) => {
      httpCalls.push({ method, route, body });
      return {
        statusCode: 404,
        headers: {},
        body: { error: "not found" }
      };
    },
    listProviderModels: async (provider) => ({
      provider,
      models: [
        { id: `${provider}-model-1`, label: `${provider} model 1` },
        { id: `${provider}-model-2`, label: `${provider} model 2` }
      ]
    }),
    now: () => new Date("2026-04-05T01:00:00.000Z"),
    stdout: (chunk: string) => {
      stdout += chunk;
    },
    stderr: (chunk: string) => {
      stderr += chunk;
    },
    ...overrides
  };

  return {
    deps,
    httpCalls,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

async function expectCliError(
  promise: Promise<number>,
  expectedExitCode: number,
  expectedMessage: RegExp | string
): Promise<void> {
  let actual: unknown;
  try {
    await promise;
  } catch (error) {
    actual = error;
  }

  assert.ok(actual instanceof Error, "expected CLI command to throw");
  assert.equal((actual as Error & { exitCode?: unknown }).exitCode, expectedExitCode);
  if (typeof expectedMessage === "string") {
    assert.equal(actual.message, expectedMessage);
  } else {
    assert.match(actual.message, expectedMessage);
  }
}

test("runCli spawn forwards provider, model, effort, workdir, mode, and auto-approve via HTTP", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: buildCliHubResult({
        thread_id: "claude_01",
        source: "claude"
      })
    };
  };

  const exitCode = await runCli(
    [
      "spawn",
      "claude",
      "--model",
      "claude-opus-4-6",
      "--effort",
      "xhigh",
      "--workdir",
      "/tmp/project",
      "--no-auto-approve",
      "--mode",
      "agentapi"
    ],
    harness.deps
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/spawn",
      body: {
        type: "claude",
        provider: "claude",
        mode: "bridge",
        auto_approve: false,
        model_id: "claude-opus-4-6",
        effort: "xhigh",
        spawn_dir: "/tmp/project"
      }
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    thread_id: "claude_01",
    agent_type: "claude"
  });
  assert.equal(harness.stderr(), "");
});

test("runCli models lists selectable models for a provider without socket transport", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();

  const exitCode = await runCli(["models", "gemini"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, []);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    provider: "gemini",
    models: [
      {
        id: "gemini-model-1",
        label: "gemini model 1"
      },
      {
        id: "gemini-model-2",
        label: "gemini model 2"
      }
    ]
  });
});

test("runCli interrupt posts to non-destructive interrupt endpoint", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: buildCliHubResult({
        content: "Agent instance codex_01 interrupted"
      })
    };
  };

  const exitCode = await runCli(["interrupt", "codex_01"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/interrupt",
      body: { thread_id: "codex_01" }
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), { ok: true });
});

test("runCli stop is an alias for interrupt", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: buildCliHubResult({
        content: "Agent instance codex_01 interrupted"
      })
    };
  };

  const exitCode = await runCli(["stop", "codex_01"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/interrupt",
      body: { thread_id: "codex_01" }
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), { ok: true });
});

test("runCli status formats active agents from /api/instances", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: [
        {
          thread_id: "codex_01",
          agent_type: "codex",
          model_id: "o3",
          status: "running",
          created_at: "2026-04-05T00:00:00.000Z"
        }
      ]
    };
  };

  const exitCode = await runCli(["status"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [{ method: "GET", route: "/api/instances", body: undefined }]);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    agents: [
      {
        thread_id: "codex_01",
        type: "codex",
        agent_type: "codex",
        model: "o3",
        model_id: "o3",
        current_model_id: "o3",
        status: "running",
        uptime: 3600
      }
    ]
  });
});

test("runCli send routes the message through /api/run", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: buildCliHubResult({
        thread_id: "codex_01",
        status: "partial",
        content: "Task is running..."
      })
    };
  };

  const exitCode = await runCli(["send", "codex_01", "ship", "it"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/run",
      body: {
        thread_id: "codex_01",
        content: "ship it",
        attachments: []
      }
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    thread_id: "codex_01",
    status: "partial"
  });
});

test("runCli logs returns conversation history entries from /api/history", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: [
        {
          id: "entry-1",
          event_kind: "final_reply",
          source: "codex",
          type: "agent",
          content: "ok",
          details_text: "expanded",
          raw_content: "raw",
          timestamp: "2026-04-05T00:00:00.000Z"
        }
      ]
    };
  };

  const exitCode = await runCli(["logs", "codex_01"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "GET",
      route: "/api/history?thread_id=codex_01",
      body: undefined
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    thread_id: "codex_01",
    entries: [
      {
        id: "entry-1",
        event_kind: "final_reply",
        source: "codex",
        type: "agent",
        content: "expanded",
        raw_content: "raw",
        timestamp: "2026-04-05T00:00:00.000Z"
      }
    ]
  });
});

test("runCli autoapprove status resolves the sole active thread through the API boundary", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    if (route === "/api/instances") {
      return {
        statusCode: 200,
        headers: {},
        body: [
          {
            thread_id: "codex_01",
            agent_type: "codex",
            status: "running",
            auto_approve: true,
            created_at: "2026-04-05T00:00:00.000Z"
          }
        ]
      };
    }

    assert.equal(route, "/api/autoapprove?thread_id=codex_01");
    return {
      statusCode: 200,
      headers: {},
      body: {
        thread_id: "codex_01",
        auto_approve: true
      }
    };
  };

  const exitCode = await runCli(["autoapprove", "status"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    { method: "GET", route: "/api/instances", body: undefined },
    { method: "GET", route: "/api/autoapprove?thread_id=codex_01", body: undefined }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    thread_id: "codex_01",
    auto_approve: true
  });
});

test("runCli autoapprove on posts boolean approval state to /api/autoapprove", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: {
        thread_id: "codex_01",
        auto_approve: true
      }
    };
  };

  const exitCode = await runCli(["autoapprove", "on", "--thread", "codex_01"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/autoapprove",
      body: {
        thread_id: "codex_01",
        enabled: true
      }
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    thread_id: "codex_01",
    auto_approve: true
  });
});

test("runCli health returns the Meridian API payload without socket fallback", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: {
        ok: true,
        version: "1.0.0",
        uptime: 42,
        agents_count: 1
      }
    };
  };

  const exitCode = await runCli(["health"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [{ method: "GET", route: "/api/health", body: undefined }]);
  assert.deepEqual(JSON.parse(harness.stdout()), {
    ok: true,
    version: "1.0.0",
    uptime: 42,
    agents_count: 1
  });
});

test("runCli propagates HTTP validation failures as CLI invalid-argument errors", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 400,
      headers: {},
      body: { error: "Working directory must be under AGENT_WORKDIR" }
    };
  };

  await expectCliError(
    runCli(["spawn", "codex", "--workdir", "/tmp/outside"], harness.deps),
    2,
    "Working directory must be under AGENT_WORKDIR"
  );
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/spawn",
      body: {
        type: "codex",
        provider: "codex",
        mode: "bridge",
        auto_approve: true,
        spawn_dir: "/tmp/outside"
      }
    }
  ]);
});

test("runCli fails fast when the Meridian API is unreachable", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps({
    connectToHub: async () => {
      throw new Error("ECONNREFUSED");
    }
  });

  await expectCliError(runCli(["status"], harness.deps), 3, /Meridian API is not reachable/i);
  assert.deepEqual(harness.httpCalls, []);
});
