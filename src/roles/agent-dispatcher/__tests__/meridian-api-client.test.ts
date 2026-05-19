import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveBuiltinCallerKey, resetCallerIdentityCache } from "../../../shared/caller-identity";
import { createMeridianApiClient } from "../meridian-api-client";

const originalEnv = { ...process.env };

afterEach(() => {
  resetCallerIdentityCache();
  vi.restoreAllMocks();

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

describe("createMeridianApiClient", () => {
  it("signs Meridian HTTP requests as meridian-roles caller", async () => {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-bootstrap-seed";
    const seenRequests: Array<{ url: URL; init: RequestInit }> = [];
    const httpFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      seenRequests.push({ url: url as URL, init: init ?? {} });
      return new Response(JSON.stringify({ thread_id: "codex_01", status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const client = createMeridianApiClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "web-token",
      fetch: httpFetch as typeof fetch
    });

    await client.spawn({
      agentType: "codex",
      mode: "bridge",
      spawnDir: "/tmp/workspace"
    });

    expect(seenRequests).toHaveLength(1);
    const headers = seenRequests[0]?.init.headers as Record<string, string>;
    expect(headers["X-Meridian-Caller-Id"]).toBe("meridian-roles");
    expect(headers["X-Meridian-Caller-Key"]).toBe(deriveBuiltinCallerKey("meridian-roles", "test-bootstrap-seed"));
    expect(headers["X-Meridian-Caller-Version"]).toBe("meridian-roles");
    expect(headers.authorization).toBe("Bearer web-token");
  });

  it("forwards credential_id onto /api/spawn body when provided", async () => {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-bootstrap-seed";
    const seenRequests: Array<{ url: URL; init: RequestInit }> = [];
    const httpFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      seenRequests.push({ url: url as URL, init: init ?? {} });
      return new Response(JSON.stringify({ thread_id: "codex_42", status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const client = createMeridianApiClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "web-token",
      fetch: httpFetch as typeof fetch
    });

    await client.spawn({
      agentType: "codex",
      mode: "bridge",
      spawnDir: "/tmp/workspace",
      credentialId: "cred-X"
    });

    expect(seenRequests).toHaveLength(1);
    const sentBody = JSON.parse(seenRequests[0]!.init.body as string) as Record<string, unknown>;
    expect(sentBody.credential_id).toBe("cred-X");
  });

  it("omits credential_id from /api/spawn body when undefined (does not send a null/empty field)", async () => {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-bootstrap-seed";
    const seenRequests: Array<{ url: URL; init: RequestInit }> = [];
    const httpFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      seenRequests.push({ url: url as URL, init: init ?? {} });
      return new Response(JSON.stringify({ thread_id: "codex_43", status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const client = createMeridianApiClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "web-token",
      fetch: httpFetch as typeof fetch
    });

    await client.spawn({
      agentType: "codex",
      mode: "bridge",
      spawnDir: "/tmp/workspace"
    });

    expect(seenRequests).toHaveLength(1);
    const sentBody = JSON.parse(seenRequests[0]!.init.body as string) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(sentBody, "credential_id")).toBe(false);
  });

  it("listCredentials() calls GET /api/credentials and returns parsed array", async () => {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-bootstrap-seed";
    const seenRequests: Array<{ url: URL; init: RequestInit }> = [];
    const fakeList = [
      {
        credential_id: "cred-A",
        credential_label: "Alice Codex",
        provider: "codex",
        kind: "oauth" as const,
        owner_caller_id: "meridian-roles",
        is_default: true,
        created_at: "2026-05-01T00:00:00Z",
        last_used_at: null,
        revoked_at: null,
        api_key_metadata: null
      },
      {
        credential_id: "cred-B",
        credential_label: "Bob Key",
        provider: "codex",
        kind: "api_key" as const,
        owner_caller_id: "meridian-roles",
        is_default: false,
        created_at: "2026-05-02T00:00:00Z",
        last_used_at: "2026-05-10T00:00:00Z",
        revoked_at: null,
        api_key_metadata: {
          base_url: "https://api.openai.com/v1",
          model_id: "gpt-5",
          env_var: "OPENAI_API_KEY"
        }
      }
    ];
    const httpFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      seenRequests.push({ url: url as URL, init: init ?? {} });
      return new Response(JSON.stringify({ credentials: fakeList }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const client = createMeridianApiClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "web-token",
      fetch: httpFetch as typeof fetch
    });

    const result = await client.listCredentials();

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]!.url.pathname).toBe("/api/credentials");
    expect((seenRequests[0]!.init.method ?? "GET").toUpperCase()).toBe("GET");
    const headers = seenRequests[0]!.init.headers as Record<string, string>;
    expect(headers["X-Meridian-Caller-Id"]).toBe("meridian-roles");
    expect(headers["X-Meridian-Caller-Key"]).toBe(
      deriveBuiltinCallerKey("meridian-roles", "test-bootstrap-seed")
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.credential_id).toBe("cred-A");
    expect(result[0]?.kind).toBe("oauth");
    expect(result[1]?.api_key_metadata?.base_url).toBe("https://api.openai.com/v1");
  });

  it("listCredentials() throws clear error on 401/403", async () => {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-bootstrap-seed";
    const httpFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    });

    const client = createMeridianApiClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "web-token",
      fetch: httpFetch as typeof fetch
    });

    await expect(client.listCredentials()).rejects.toThrow(/auth/i);
  });
});
