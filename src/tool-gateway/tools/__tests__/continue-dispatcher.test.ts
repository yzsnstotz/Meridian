import { describe, expect, it, vi } from "vitest";

import { executeContinueDispatcher, type ContinueDispatcherDeps } from "../continue-dispatcher";

describe("continue-dispatcher tool", () => {
  it("returns the service response when the roles service is reachable", async () => {
    const deps = createDeps({
      postContinue: async () => ({
        ok: true,
        body: {
          ok: true,
          status: "continued",
          message: "continued: N-02",
          worker: "N-02"
        },
        base_url: "http://127.0.0.1:7701/",
        status_code: 200
      })
    });

    const result = await executeContinueDispatcher(
      { dispatcherId: "agent-dispatcher-r03" },
      deps
    );

    expect(result).toEqual({
      ok: true,
      status: "continued",
      message: "continued: N-02",
      worker: "N-02"
    });
    expect(deps.postContinue).toHaveBeenCalledWith(
      "/api/agent-dispatcher/agent-dispatcher-r03/continue"
    );
  });

  it("uses the worker-specific endpoint when a worker id is provided", async () => {
    const deps = createDeps({
      postContinue: async () => ({
        ok: true,
        body: {
          ok: true,
          status: "continued",
          message: "continued: R-08",
          worker: "R-08"
        },
        base_url: "http://127.0.0.1:7701/",
        status_code: 200
      })
    });

    const result = await executeContinueDispatcher(
      { dispatcherId: "agent-dispatcher-r03", workerId: "R-08" },
      deps
    );

    expect(result).toEqual({
      ok: true,
      status: "continued",
      message: "continued: R-08",
      worker: "R-08"
    });
    expect(deps.postContinue).toHaveBeenCalledWith(
      "/api/roles/agent-dispatcher-r03/worker/R-08/continue"
    );
  });

  it("returns a structured error when the service is unreachable instead of falling back locally", async () => {
    const deps = createDeps({
      postContinue: async () => ({
        ok: false,
        error: "Meridian-roles service unreachable at http://127.0.0.1:7701/: fetch failed",
        base_url: "http://127.0.0.1:7701/",
        service_unreachable: true
      })
    });

    const result = await executeContinueDispatcher(
      { dispatcherId: "agent-dispatcher-r03" },
      deps
    );

    expect(result).toEqual({
      ok: false,
      error: "Meridian-roles service unreachable at http://127.0.0.1:7701/: fetch failed",
      data: {
        base_url: "http://127.0.0.1:7701/",
        service_unreachable: true,
        exit_code: 3
      }
    });
  });

  it("returns a structured error when the service returns an HTTP error", async () => {
    const deps = createDeps({
      postContinue: async () => ({
        ok: false,
        error: "Meridian-roles service request failed (500): Internal Server Error",
        base_url: "http://127.0.0.1:7701/",
        service_unreachable: false,
        status_code: 500
      })
    });

    const result = await executeContinueDispatcher(
      { dispatcherId: "agent-dispatcher-r03" },
      deps
    );

    expect(result).toEqual({
      ok: false,
      error: "Meridian-roles service request failed (500): Internal Server Error",
      data: {
        base_url: "http://127.0.0.1:7701/",
        service_unreachable: false,
        exit_code: 1,
        status_code: 500
      }
    });
  });

  it("does not attempt local continuation when the service is down", async () => {
    const postContinue = vi.fn().mockResolvedValue({
      ok: false,
      error: "Meridian-roles service unreachable at http://127.0.0.1:7701/: fetch failed",
      base_url: "http://127.0.0.1:7701/",
      service_unreachable: true
    });

    const result = await executeContinueDispatcher(
      { dispatcherId: "agent-dispatcher-r03" },
      { postContinue }
    );

    expect(postContinue).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect((result as { data?: { service_unreachable?: boolean } }).data?.service_unreachable).toBe(true);
  });
});

function createDeps(overrides: Partial<ContinueDispatcherDeps> = {}): ContinueDispatcherDeps & {
  postContinue: ReturnType<typeof vi.fn>;
} {
  const postContinue = overrides.postContinue
    ? vi.fn(overrides.postContinue)
    : vi.fn().mockResolvedValue({
        ok: false,
        error: "Meridian-roles service unreachable",
        base_url: "http://127.0.0.1:7701/",
        service_unreachable: true
      });

  return {
    postContinue
  };
}
