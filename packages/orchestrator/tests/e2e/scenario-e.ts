import { describe, expect, it } from "vitest";

import { startAgentDispatcherHarness } from "./agent-dispatcher-harness";

describe("Scenario E: Agent-dispatcher stale dispatcher recovery", () => {
  it("demotes a missing dispatcher thread and still allows service-owned worker continuation", async () => {
    const harness = await startAgentDispatcherHarness({
      name: "meridian-roles-scenario-e",
      attachToThread: async () => {
        throw new Error("thread not found");
      },
      getThreadDetail: async () => "dispatcher detail should not be read after missing attach",
      planRows: [
        {
          worker: "W-RECOVER",
          task: "Recover after dispatcher loss"
        }
      ]
    });

    try {
      await harness.startDispatcher({
        thread_id: "agent-dispatcher-e"
      });

      const detail = await harness.requestJson<{
        status: string;
        dispatcher_thread_id: string | null;
        session_log: string[];
      }>("GET", "/api/role/agent-dispatcher-e");
      expect(detail.status).toBe("needs_reactivation");
      expect(detail.dispatcher_thread_id).toBeNull();
      expect(detail.session_log.join("\n")).toContain("thread missing");
      expect(harness.readLifecycle().dispatcher.status).toBe("abandoned");

      const continued = await harness.requestJson<{
        status: string;
        worker: string;
      }>("POST", "/api/agent-dispatcher/agent-dispatcher-e/continue");
      expect(continued).toMatchObject({
        status: "continued",
        worker: "W-RECOVER"
      });
      expect(harness.workerLaunches[0]).toMatchObject({
        workerId: "W-RECOVER"
      });
    } finally {
      await harness.close();
    }
  });
});
