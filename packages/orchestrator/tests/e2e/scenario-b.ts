import { describe, expect, it } from "vitest";

import { startAgentDispatcherHarness } from "./agent-dispatcher-harness";

describe("Scenario B: Agent-dispatcher prompt preview", () => {
  it("materializes the preview prompt with the real dispatcher role id on start", async () => {
    const harness = await startAgentDispatcherHarness({
      name: "meridian-roles-scenario-b",
      planRows: [
        {
          worker: "W-PLAN",
          task: "Plan implementation"
        }
      ]
    });

    try {
      const preview = await harness.requestJson<{ system_prompt: string }>(
        "POST",
        "/api/agent-dispatcher/prompt-preview",
        {
          dispatch_plan_path: harness.dispatchPlanPath,
          command_file_path: harness.commandFilePath,
          docs_root: harness.docsRoot,
          user_reply_channels: [
            {
              channel: "web",
              chat_id: "web:review"
            }
          ],
          agent_type: "codex",
          mode: "bridge",
          kill_policy: "always",
          auto_approve: true
        }
      );

      expect(preview.system_prompt).toContain("__MERIDIAN_AGENT_DISPATCHER_ROLE_ID__");
      expect(preview.system_prompt).toContain("auto_approve: true");

      const started = await harness.startDispatcher({
        thread_id: "agent-dispatcher-b",
        user_reply_channels: [
          {
            channel: "web",
            chat_id: "web:review"
          }
        ],
        system_prompt: preview.system_prompt,
        auto_approve: true
      });
      const state = await harness.readState();
      const role = state.roles.find((entry) => entry.threadId === started.dispatcher_id);

      expect(role?.roleType).toBe("agent-dispatcher");
      expect((role?.config as { system_prompt?: string }).system_prompt).toContain(
        "dispatcher_role_id: agent-dispatcher-b"
      );
      expect((role?.config as { system_prompt?: string }).system_prompt).not.toContain(
        "__MERIDIAN_AGENT_DISPATCHER_ROLE_ID__"
      );
    } finally {
      await harness.close();
    }
  });
});
