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
    readLine: async (_prompt: string) => "y",
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

test("runCli spawn forwards stateless_call mode via HTTP", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: buildCliHubResult({
        thread_id: "codex_01",
        source: "codex"
      })
    };
  };

  const exitCode = await runCli(["spawn", "codex", "--mode", "stateless_call"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/spawn",
      body: {
        type: "codex",
        provider: "codex",
        mode: "stateless_call",
        auto_approve: true
      }
    }
  ]);
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

test("runCli runtime catalog fetches the Email Loop catalog endpoint", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  const catalog = {
    ok: true,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        status: "available",
        capabilities: { oauth: true, api_key: true, model_list: true },
        credentials: [],
        models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
        error: null
      }
    ],
    credentials: []
  };
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: catalog
    };
  };

  const exitCode = await runCli(["runtime", "catalog"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [{ method: "GET", route: "/api/runtime/catalog", body: undefined }]);
  assert.deepEqual(JSON.parse(harness.stdout()), catalog);
  assert.equal(harness.stderr(), "");
});

test("runCli credentials list fetches credential accounts", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  const body = {
    credentials: [
      {
        credential_id: "host-default-codex",
        credential_label: "Default (codex)",
        provider: "codex",
        kind: "oauth",
        is_host_default: true
      }
    ]
  };
  harness.deps.hubHttpRequest = async (method: string, route: string, requestBody?: unknown) => {
    harness.httpCalls.push({ method, route, body: requestBody });
    return {
      statusCode: 200,
      headers: {},
      body
    };
  };

  const exitCode = await runCli(["credentials", "list"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [{ method: "GET", route: "/api/credentials", body: undefined }]);
  assert.deepEqual(JSON.parse(harness.stdout()), body);
});

test("runCli credentials oauth-start sends only label and mode", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 202,
      headers: {},
      body: { job_id: "job-1", status: "pending" }
    };
  };

  const exitCode = await runCli(["credentials", "oauth-start", "--label", "Work Codex", "--mode", "device"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/credentials/oauth-login",
      body: { credential_label: "Work Codex", mode: "device" }
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), { job_id: "job-1", status: "pending" });
});

test("runCli credentials oauth-poll and oauth-cancel address the job endpoint", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    if (method === "DELETE") {
      return { statusCode: 204, headers: {}, body: null };
    }
    return {
      statusCode: 200,
      headers: {},
      body: { job_id: "job-1", status: "awaiting_browser", login_url: "https://example.test/login" }
    };
  };

  assert.equal(await runCli(["credentials", "oauth-poll", "job-1"], harness.deps), 0);
  assert.equal(await runCli(["credentials", "oauth-cancel", "job-1"], harness.deps), 0);

  assert.deepEqual(harness.httpCalls, [
    { method: "GET", route: "/api/credentials/oauth-login/job-1", body: undefined },
    { method: "DELETE", route: "/api/credentials/oauth-login/job-1", body: undefined }
  ]);
  const outputs = harness.stdout().trim().split(/\n(?=\{)/).map((chunk) => JSON.parse(chunk));
  assert.deepEqual(outputs, [
    { job_id: "job-1", status: "awaiting_browser", login_url: "https://example.test/login" },
    { ok: true, cancelled: true, job_id: "job-1" }
  ]);
});

test("runCli credentials api-key registers a key without echoing the secret", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  const secret = "sk-cli-secret";
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 201,
      headers: {},
      body: { credential_id: "cred-1" }
    };
  };

  const exitCode = await runCli(
    [
      "credentials",
      "api-key",
      "--label",
      "OpenAI Work",
      "--base-url",
      "https://api.openai.com/v1",
      "--model",
      "gpt-5.4",
      "--env-var",
      "OPENAI_API_KEY",
      "--key",
      secret
    ],
    harness.deps
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/credentials/api-key",
      body: {
        credential_label: "OpenAI Work",
        base_url: "https://api.openai.com/v1",
        model_id: "gpt-5.4",
        env_var: "OPENAI_API_KEY",
        key_value: secret
      }
    }
  ]);
  assert.deepEqual(JSON.parse(harness.stdout()), { credential_id: "cred-1" });
  assert.equal(harness.stdout().includes(secret), false);
});

test("runCli credentials set-default and revoke call account mutation endpoints", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: method === "POST" ? { credential_id: "cred-1", is_default: true } : { credential_id: "cred-1", revoked: true }
    };
  };

  assert.equal(await runCli(["credentials", "set-default", "cred-1"], harness.deps), 0);
  assert.equal(await runCli(["credentials", "revoke", "cred-1", "--yes"], harness.deps), 0);

  assert.deepEqual(harness.httpCalls, [
    { method: "POST", route: "/api/credentials/cred-1/default", body: undefined },
    { method: "DELETE", route: "/api/credentials/cred-1", body: undefined }
  ]);
  const outputs = harness.stdout().trim().split(/\n(?=\{)/).map((chunk) => JSON.parse(chunk));
  assert.deepEqual(outputs, [
    { credential_id: "cred-1", is_default: true },
    { credential_id: "cred-1", revoked: true }
  ]);
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
      body: { error: "Working directory does not exist: /tmp/outside" }
    };
  };

  await expectCliError(
    runCli(["spawn", "codex", "--workdir", "/tmp/outside"], harness.deps),
    2,
    "Working directory does not exist: /tmp/outside"
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

// ---- caller list ----

test("runCli caller list shows caller table in human format", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: [
        {
          caller_id: "test-caller",
          caller_label: "Test Caller",
          caller_kind: "external",
          caller_authority: "write",
          created_at: "2026-05-05T00:00:00.000Z",
          last_seen_at: null,
          revoked_at: null
        }
      ]
    };
  };

  const exitCode = await runCli(["caller", "list"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [{ method: "GET", route: "/api/callers", body: undefined }]);
  assert.ok(harness.stderr().includes("test-caller"));
  assert.equal(harness.stdout(), "");
});

test("runCli caller list --json emits raw API response", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  const callerBody = [
    {
      caller_id: "test-caller",
      caller_label: "Test Caller",
      caller_kind: "external",
      caller_authority: "write",
      created_at: "2026-05-05T00:00:00.000Z",
      last_seen_at: null,
      revoked_at: null
    }
  ];
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return { statusCode: 200, headers: {}, body: callerBody };
  };

  const exitCode = await runCli(["caller", "list", "--json"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(harness.stdout()), callerBody);
});

// ---- caller mint ----

test("runCli caller mint prints caller_id and caller_key to stdout", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: {
        caller_id: "new-caller",
        caller_label: "New Caller",
        caller_key: "deadbeef1234abcd"
      }
    };
  };

  const exitCode = await runCli(["caller", "mint", "--id", "new-caller", "--label", "New Caller"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/callers",
      body: { caller_id: "new-caller", caller_label: "New Caller" }
    }
  ]);
  assert.ok(harness.stdout().includes("caller_id:  new-caller"));
  assert.ok(harness.stdout().includes("caller_key: deadbeef1234abcd"));
  assert.ok(harness.stdout().includes("IMPORTANT: Save this key now."));
  assert.equal(harness.stderr(), "");
});

test("runCli caller mint with invalid --id regex exits with code 2", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();

  await expectCliError(
    runCli(["caller", "mint", "--id", "INVALID_ID", "--label", "Test"], harness.deps),
    2,
    /\^?\[a-z\]/
  );
  assert.deepEqual(harness.httpCalls, []);
});

test("runCli caller mint without --label exits with code 2", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();

  await expectCliError(
    runCli(["caller", "mint", "--id", "test-id"], harness.deps),
    2,
    /--label is required/
  );
  assert.deepEqual(harness.httpCalls, []);
});

test("runCli caller mint without --id exits with code 2", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();

  await expectCliError(
    runCli(["caller", "mint", "--label", "Test"], harness.deps),
    2,
    /--id is required/
  );
  assert.deepEqual(harness.httpCalls, []);
});

test("runCli caller mint rejects --write-env flag (PM Blocker #2)", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();

  await expectCliError(
    runCli(["caller", "mint", "--id", "test-id", "--label", "Test", "--write-env", "/tmp/.env"], harness.deps),
    2,
    /write-env.*not supported/
  );
  assert.deepEqual(harness.httpCalls, []);
});

// ---- caller rotate ----

test("runCli caller rotate --yes skips confirmation and prints new key", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: {
        caller_id: "test-caller",
        caller_key: "newkey5678abcdef"
      }
    };
  };

  const exitCode = await runCli(["caller", "rotate", "--id", "test-caller", "--yes"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "POST",
      route: "/api/callers/test-caller/rotate",
      body: {}
    }
  ]);
  assert.ok(harness.stdout().includes("caller_key: newkey5678abcdef"));
  assert.ok(harness.stdout().includes("IMPORTANT: Save this key now."));
  assert.equal(harness.stderr(), "");
});

test("runCli caller rotate without --yes uses readLine to confirm", async () => {
  const { runCli } = await meridianCliModulePromise;
  const promptsSeen: string[] = [];
  const harness = createCliDeps({
    readLine: async (prompt: string) => {
      promptsSeen.push(prompt);
      return "y";
    }
  });
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: { caller_id: "test-caller", caller_key: "rotatedkey" }
    };
  };

  const exitCode = await runCli(["caller", "rotate", "--id", "test-caller"], harness.deps);

  assert.equal(exitCode, 0);
  assert.equal(promptsSeen.length, 1);
  assert.ok(promptsSeen[0]?.includes("test-caller"));
  assert.ok(harness.stdout().includes("caller_key: rotatedkey"));
});

// ---- caller revoke ----

test("runCli caller revoke --yes skips confirmation and prints revoked_at", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: {
        caller_id: "test-caller",
        revoked_at: "2026-05-05T10:00:00.000Z"
      }
    };
  };

  const exitCode = await runCli(["caller", "revoke", "--id", "test-caller", "--yes"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    {
      method: "DELETE",
      route: "/api/callers/test-caller",
      body: undefined
    }
  ]);
  assert.ok(harness.stdout().includes("revoked_at: 2026-05-05T10:00:00.000Z"));
  assert.equal(harness.stderr(), "");
});

test("runCli caller revoke without --yes aborts when readLine returns n", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps({ readLine: async () => "n" });

  const exitCode = await runCli(["caller", "revoke", "--id", "test-caller"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, []);
  assert.ok(harness.stderr().includes("Aborted"));
});

// ---- list --json with caller fields ----

test("runCli list --json passes through spawned_by, last_caller, last_caller_at", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: [
        {
          thread_id: "claude_01",
          agent_type: "claude",
          status: "running",
          created_at: "2026-05-05T00:00:00.000Z",
          spawned_by: { caller_id: "meridian-roles", caller_label: "Meridian Roles" },
          last_caller: { caller_id: "meridian-roles", caller_label: "Meridian Roles" },
          last_caller_at: "2026-05-05T07:18:42.913Z"
        }
      ]
    };
  };

  const exitCode = await runCli(["list", "--json"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [{ method: "GET", route: "/api/instances", body: undefined }]);
  const output = JSON.parse(harness.stdout());
  assert.equal(output.ok, true);
  const instance = output.instances[0];
  assert.deepEqual(instance.spawned_by, { caller_id: "meridian-roles", caller_label: "Meridian Roles" });
  assert.deepEqual(instance.last_caller, { caller_id: "meridian-roles", caller_label: "Meridian Roles" });
  assert.equal(instance.last_caller_at, "2026-05-05T07:18:42.913Z");
});

test("runCli list human format shows caller column and (none) when absent", async () => {
  const { runCli } = await meridianCliModulePromise;
  const harness = createCliDeps();
  harness.deps.hubHttpRequest = async (method: string, route: string, body?: unknown) => {
    harness.httpCalls.push({ method, route, body });
    return {
      statusCode: 200,
      headers: {},
      body: [
        {
          thread_id: "claude_01",
          agent_type: "claude",
          status: "running",
          created_at: "2026-05-05T00:00:00.000Z",
          last_caller: { caller_id: "meridian-roles", caller_label: "Meridian Roles" },
          last_caller_at: "2026-05-05T07:18:42.913Z"
        },
        {
          thread_id: "codex_02",
          agent_type: "codex",
          status: "idle",
          created_at: "2026-05-05T00:00:00.000Z"
        }
      ]
    };
  };

  const exitCode = await runCli(["list"], harness.deps);

  assert.equal(exitCode, 0);
  const output = harness.stderr();
  assert.ok(output.includes("caller=meridian-roles@2026-05-05T07:18Z"));
  assert.ok(output.includes("(none)"));
});

// ---- history --json with caller fields ----

test("runCli history --json entries include caller_id and caller_label", async () => {
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
          source: "claude",
          type: "agent",
          content: "ok",
          raw_content: "raw",
          timestamp: "2026-05-05T07:00:00.000Z",
          caller_id: "meridian-roles",
          caller_label: "Meridian Roles"
        }
      ]
    };
  };

  const exitCode = await runCli(["history", "claude_01", "--json"], harness.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.httpCalls, [
    { method: "GET", route: "/api/history?thread_id=claude_01", body: undefined }
  ]);
  const output = JSON.parse(harness.stdout());
  assert.equal(output.ok, true);
  assert.equal(output.thread_id, "claude_01");
  assert.equal(output.entries[0]?.caller_id, "meridian-roles");
  assert.equal(output.entries[0]?.caller_label, "Meridian Roles");
});
