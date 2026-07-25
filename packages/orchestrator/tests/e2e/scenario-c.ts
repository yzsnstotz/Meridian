import { describe, expect, it } from "vitest";

import { startAgentDispatcherHarness } from "./agent-dispatcher-harness";

describe("Scenario C: Agent-dispatcher config update", () => {
  it("patches mutable launch settings used by subsequent worker launches", async () => {
    const harness = await startAgentDispatcherHarness({
      name: "meridian-roles-scenario-c",
      planRows: [
        {
          worker: "W-CONFIG",
          task: "Use updated config",
          model: "—"
        }
      ]
    });

    try {
      await harness.startDispatcher({
        thread_id: "agent-dispatcher-c"
      });

      const patched = await harness.requestJson<{
        can_edit: boolean;
        config: {
          agent_type: string;
          model_id?: string;
          mode: string;
          kill_policy: string;
          auto_approve: boolean;
        };
      }>("PATCH", "/api/role/agent-dispatcher-c/config", {
        agent_type: "claude",
        model_id: "claude-opus-4-7",
        mode: "bridge",
        kill_policy: "never",
        auto_approve: true
      });

      expect(patched.can_edit).toBe(true);
      expect(patched.config).toMatchObject({
        agent_type: "claude",
        model_id: "claude-opus-4-7",
        mode: "bridge",
        kill_policy: "never",
        auto_approve: true
      });

      const continued = await harness.requestJson<{
        ok: true;
        status: string;
        worker: string;
      }>("POST", "/api/agent-dispatcher/agent-dispatcher-c/continue");

      expect(continued).toMatchObject({
        ok: true,
        status: "continued",
        worker: "W-CONFIG"
      });
      expect(harness.workerLaunches[0]).toMatchObject({
        workerId: "W-CONFIG",
        agentType: "claude",
        mode: "bridge",
        killPolicy: "never",
        autoApprove: true
      });
    } finally {
      await harness.close();
    }
  });
});
