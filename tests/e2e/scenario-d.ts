import { describe, expect, it } from "vitest";

import { startAgentDispatcherHarness } from "./agent-dispatcher-harness";

describe("Scenario D: Agent-dispatcher continuation", () => {
  it("continues the first eligible worker and waits for dependencies before launching the next", async () => {
    const harness = await startAgentDispatcherHarness({
      name: "meridian-roles-scenario-d",
      planRows: [
        {
          worker: "W-01",
          task: "First step",
          model: "CODEX-HIGH"
        },
        {
          worker: "W-02",
          task: "Second step",
          dependsOn: "W-01"
        }
      ]
    });

    try {
      await harness.startDispatcher({
        thread_id: "agent-dispatcher-d"
      });

      const first = await harness.requestJson<{
        status: string;
        worker: string;
      }>("POST", "/api/agent-dispatcher/agent-dispatcher-d/continue");
      expect(first).toMatchObject({
        status: "continued",
        worker: "W-01"
      });
      expect(harness.workerLaunches[0]).toMatchObject({
        workerId: "W-01",
        agentType: "codex",
        modelId: "gpt-5.5 high"
      });

      const blocked = await harness.requestJson<{
        status: string;
        message: string;
        running_workers: string[];
      }>("POST", "/api/agent-dispatcher/agent-dispatcher-d/continue");
      expect(blocked.status).toBe("still_blocked");
      expect(blocked.running_workers).toEqual(["W-01"]);

      harness.completeWorker("W-01");

      const second = await harness.requestJson<{
        status: string;
        worker: string;
      }>("POST", "/api/agent-dispatcher/agent-dispatcher-d/continue");
      expect(second).toMatchObject({
        status: "continued",
        worker: "W-02"
      });
      expect(harness.workerLaunches[1]).toMatchObject({
        workerId: "W-02",
        agentType: "codex",
        modelId: "gpt-5.4 medium"
      });
    } finally {
      await harness.close();
    }
  });
});
