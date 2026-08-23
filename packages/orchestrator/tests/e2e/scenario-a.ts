import { describe, expect, it } from "vitest";

import { startAgentDispatcherHarness } from "./agent-dispatcher-harness";

describe("Scenario A: Agent-dispatcher startup", () => {
  it("starts an agent-dispatcher role from a dispatch plan and exposes role detail", async () => {
    const harness = await startAgentDispatcherHarness({
      name: "meridian-roles-scenario-a",
      planRows: [
        {
          worker: "W-01",
          task: "Collect evidence"
        },
        {
          worker: "W-02",
          task: "Write summary",
          dependsOn: "W-01"
        }
      ]
    });

    try {
      const started = await harness.startDispatcher({
        thread_id: "agent-dispatcher-a",
        user_reply_channel: {
          channel: "telegram",
          chat_id: "telegram:pm"
        }
      });

      expect(started).toEqual({
        ok: true,
        dispatcher_id: "agent-dispatcher-a",
        dispatcher_thread_id: "dispatcher-thread-1"
      });
      expect(harness.launchConfigs).toHaveLength(1);
      expect(harness.launchConfigs[0]).toMatchObject({
        agentType: "codex",
        mode: "bridge",
        dispatchPlanPath: harness.dispatchPlanPath,
        commandFilePath: harness.commandFilePath,
        dispatcherRoleId: "agent-dispatcher-a",
        userReplyChannel: {
          channel: "telegram",
          chat_id: "telegram:pm"
        }
      });
      expect(harness.launchConfigs[0]?.systemPrompt).toContain("dispatcher_role_id: agent-dispatcher-a");

      const detail = await harness.requestJson<{
        thread_id: string;
        role_type: string;
        status: string;
        dispatcher_thread_id: string | null;
        continue_worker: string | null;
        tasks: Array<{ task_id: string; status: string; depends_on: string[] }>;
      }>("GET", "/api/role/agent-dispatcher-a");

      expect(detail.thread_id).toBe("agent-dispatcher-a");
      expect(detail.role_type).toBe("agent-dispatcher");
      expect(detail.status).toBe("active");
      expect(detail.dispatcher_thread_id).toBe("dispatcher-thread-1");
      expect(detail.continue_worker).toBe("W-01");
      expect(detail.tasks.map((task) => ({
        task_id: task.task_id,
        status: task.status,
        depends_on: task.depends_on
      }))).toEqual([
        { task_id: "W-01", status: "pending", depends_on: [] },
        { task_id: "W-02", status: "pending", depends_on: ["W-01"] }
      ]);
    } finally {
      await harness.close();
    }
  });
});
