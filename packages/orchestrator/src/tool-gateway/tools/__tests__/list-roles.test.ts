import { afterEach, describe, expect, it, vi } from "vitest";

import listRolesTool from "../list-roles";

const originalRolesHttp = process.env.MERIDIAN_ROLES_HTTP;

afterEach(() => {
  vi.unstubAllGlobals();

  if (originalRolesHttp === undefined) {
    delete process.env.MERIDIAN_ROLES_HTTP;
  } else {
    process.env.MERIDIAN_ROLES_HTTP = originalRolesHttp;
  }
});

describe("list-roles tool", () => {
  it("returns configured roles from GET /api/roles", async () => {
    process.env.MERIDIAN_ROLES_HTTP = "http://127.0.0.1:9999";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        thread_id: "dispatcher-1",
        role_type: "dispatcher",
        status: "active",
        task_count: 2
      },
      {
        thread_id: "agent-dispatcher-1",
        role_type: "agent-dispatcher",
        status: "paused",
        task_count: 0
      }
    ]), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRolesTool.execute({});

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/roles", "http://127.0.0.1:9999/"),
      expect.objectContaining({
        method: "GET"
      })
    );
    expect(result).toEqual({
      ok: true,
      data: {
        roles: [
          {
            thread_id: "dispatcher-1",
            role_type: "dispatcher",
            status: "active",
            task_count: 2
          },
          {
            thread_id: "agent-dispatcher-1",
            role_type: "agent-dispatcher",
            status: "paused",
            task_count: 0
          }
        ],
        count: 2
      }
    });
  });
});
