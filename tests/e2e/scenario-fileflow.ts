import { describe, expect, it } from "vitest";

import { startAgentDispatcherHarness } from "./agent-dispatcher-harness";

describe("Scenario Fileflow: sequential dispatch plan workers", () => {
  it("runs two dependent workers and presents the plan as completed", async () => {
    const harness = await startAgentDispatcherHarness({
      name: "meridian-roles-scenario-fileflow",
      planRows: [
        {
          worker: "STEP-1",
          task: "Write intermediate artifact"
        },
        {
          worker: "STEP-2",
          task: "Write final artifact",
          dependsOn: "STEP-1"
        }
      ]
    });

    try {
      await harness.startDispatcher({
        thread_id: "agent-dispatcher-fileflow"
      });

      const first = await harness.requestJson<{ worker: string }>(
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-fileflow/continue"
      );
      expect(first.worker).toBe("STEP-1");
      harness.completeWorker("STEP-1", "step1.txt written");

      const second = await harness.requestJson<{ worker: string }>(
        "POST",
        "/api/agent-dispatcher/agent-dispatcher-fileflow/continue"
      );
      expect(second.worker).toBe("STEP-2");
      harness.completeWorker("STEP-2", "final.txt written");

      const detail = await harness.requestJson<{
        status: string;
        tasks: Array<{ task_id: string; status: string }>;
        dispatch_details: Array<{ worker_id: string; status: string; reply: { content: string } | null }>;
      }>("GET", "/api/role/agent-dispatcher-fileflow");

      expect(detail.status).toBe("completed");
      expect(detail.tasks.map((task) => ({ task_id: task.task_id, status: task.status }))).toEqual([
        { task_id: "STEP-1", status: "done" },
        { task_id: "STEP-2", status: "done" }
      ]);
      expect(detail.dispatch_details.map((entry) => ({
        worker_id: entry.worker_id,
        status: entry.status,
        reply: entry.reply?.content
      }))).toEqual([
        { worker_id: "STEP-1", status: "completed", reply: "step1.txt written" },
        { worker_id: "STEP-2", status: "completed", reply: "final.txt written" }
      ]);
    } finally {
      await harness.close();
    }
  });
});
