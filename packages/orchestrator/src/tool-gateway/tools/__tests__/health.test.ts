import { afterEach, describe, expect, it, vi } from "vitest";

import healthTool from "../health";

const originalRolesHttp = process.env.MERIDIAN_ROLES_HTTP;

afterEach(() => {
  vi.unstubAllGlobals();

  if (originalRolesHttp === undefined) {
    delete process.env.MERIDIAN_ROLES_HTTP;
  } else {
    process.env.MERIDIAN_ROLES_HTTP = originalRolesHttp;
  }
});

describe("health tool", () => {
  it("returns normalized health payload from GET /api/health", async () => {
    process.env.MERIDIAN_ROLES_HTTP = "http://127.0.0.1:9999";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      version: "1.2.0",
      uptime: 42,
      roles_count: 3
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    })));

    const result = await healthTool.execute({});

    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        version: "1.2.0",
        uptime: 42,
        agents_count: 3,
        roles_count: 3
      }
    });
  });

  it("marks service-unreachable health checks with exit code 3", async () => {
    process.env.MERIDIAN_ROLES_HTTP = "http://127.0.0.1:9999";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const result = await healthTool.execute({});

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
