import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createRoleHandlers, type RoleHandlers } from "../role-handlers";
import { listAgentKinds } from "../agent-kinds";
import type { MeridianApiClient } from "../../roles/agent-dispatcher/meridian-api-client";
import { RoleRegistry } from "../../roles/role-registry";
import { RoleRunner } from "../../roles/role-runner";

/**
 * Covers the meridian-roles -> meridian-hub passthroughs that back the chatter
 * create form and the existing dispatcher credential dropdown:
 *
 * - GET /api/agent-kinds: canonical catalog from src/server/agent-kinds.ts.
 *   Chatter no longer pins a single-option enum; this endpoint is the single
 *   source the GUI consults so chatter follows hub support automatically.
 * - GET /api/credentials: proxies meridianApi.listCredentials() and returns
 *   the hub wire shape so the existing app.js client-side filter on
 *   `revoked_at` keeps working without a second renderer.
 */
describe("/api/agent-kinds + /api/credentials handlers", () => {
  it("returns the agent-kinds catalog", async () => {
    const handlers = makeHandlers();

    const result = await invokeJson<{ agent_kinds: unknown }>(handlers, "GET", "/api/agent-kinds");

    expect(result.agent_kinds).toEqual(listAgentKinds());
  });

  it("proxies meridianApi.listCredentials() under {credentials: [...] }", async () => {
    const credentials = [
      {
        credential_id: "cred-1",
        credential_label: "team-codex",
        provider: "anthropic",
        kind: "oauth" as const,
        owner_caller_id: "op-1",
        is_default: true,
        created_at: "2026-05-19T00:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
        api_key_metadata: null
      }
    ];
    const meridianApi = makeStubMeridianApi({ listCredentials: async () => credentials });
    const handlers = makeHandlers({ meridianApi });

    const result = await invokeJson<{ credentials: typeof credentials }>(
      handlers,
      "GET",
      "/api/credentials"
    );

    expect(result.credentials).toEqual(credentials);
  });

  it("surfaces a 500 when the hub-side credentials lookup fails", async () => {
    const meridianApi = makeStubMeridianApi({
      listCredentials: async () => {
        throw new Error("hub unavailable");
      }
    });
    const handlers = makeHandlers({ meridianApi });

    const { statusCode } = await invokeRaw(handlers, "GET", "/api/credentials");

    expect(statusCode).toBe(500);
  });
});

function makeHandlers(overrides: { meridianApi?: MeridianApiClient } = {}): RoleHandlers {
  const log = makeLogger();
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: async () => undefined,
    listInstances: () => [],
    log
  });

  return createRoleHandlers({
    runner,
    registry,
    log,
    meridianApi: overrides.meridianApi ?? makeStubMeridianApi()
  });
}

function makeStubMeridianApi(overrides: Partial<MeridianApiClient> = {}): MeridianApiClient {
  return {
    spawn: overrides.spawn ?? (async () => ({ threadId: "stub" })),
    run: overrides.run ?? (async () => ({ threadId: "stub", status: "success", raw: {} })),
    kill: overrides.kill ?? (async () => ({ threadId: "stub", status: "killed", raw: {} })),
    listCredentials: overrides.listCredentials ?? (async () => [])
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

async function invokeJson<T>(handlers: RoleHandlers, method: string, url: string): Promise<T> {
  const { body } = await invokeRaw(handlers, method, url);
  return JSON.parse(body) as T;
}

async function invokeRaw(
  handlers: RoleHandlers,
  method: string,
  url: string
): Promise<{ statusCode: number; body: string }> {
  const request = Object.assign(Readable.from([]), {
    method,
    url,
    headers: {}
  }) as IncomingMessage;
  const response = makeCapturingResponse();
  const handled = await handlers.handle(request, response.raw);
  expect(handled).toBe(true);
  return { statusCode: response.statusCode, body: response.body };
}

function makeCapturingResponse(): {
  raw: ServerResponse;
  statusCode: number;
  body: string;
} {
  const capture = { statusCode: 200, body: "", headersSent: false };
  const raw = {
    setHeader: () => undefined,
    end(chunk?: string) {
      capture.body = chunk ?? "";
      capture.headersSent = true;
    }
  } as unknown as ServerResponse;
  Object.defineProperty(raw, "statusCode", {
    get() {
      return capture.statusCode;
    },
    set(value: number) {
      capture.statusCode = value;
    }
  });
  Object.defineProperty(raw, "headersSent", {
    get() {
      return capture.headersSent;
    },
    set(value: boolean) {
      capture.headersSent = value;
    }
  });
  return {
    raw,
    get statusCode() {
      return capture.statusCode;
    },
    get body() {
      return capture.body;
    }
  };
}
