import { describe, expect, it } from "vitest";

import { SchedulerConfigSchema } from "../../../types";
import scheduleListTool from "../schedule-list";

describe("schedule-list tool", () => {
  it("lists the github-opc-scan static scheduler entry with a schema-valid config", async () => {
    const result = await scheduleListTool.execute({});

    expect(result.ok).toBe(true);
    expect(result.data?.schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "github-opc-scan",
        config: expect.objectContaining({
          scheduler_mode: "cron",
          cron_expression: "30 7 * * *",
          timezone: "Asia/Tokyo",
          agent_type: "codex",
          model_id: "gpt-5.5"
        })
      })
    ]));

    const schedule = (result.data?.schedules as Array<{ id: string; config: unknown }>).find(
      (entry) => entry.id === "github-opc-scan"
    );

    expect(schedule).toBeDefined();
    expect(SchedulerConfigSchema.safeParse(schedule?.config).success).toBe(true);
    expect(schedule?.config).not.toHaveProperty("validator");
  });
});
