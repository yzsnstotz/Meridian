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
});
