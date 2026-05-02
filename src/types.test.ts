import { describe, expect, it } from "vitest";

import {
  AgentDispatcherConfigSchema,
  SchedulerConfigSchema,
  ValidatorConfigSchema
} from "./types";

const replyChannels = [{ channel: "web" as const, chat_id: "web:ops" }];

describe("role config mode defaults", () => {
  it("defaults dispatcher and scheduler modes to bridge when mode is omitted", () => {
    const agentDispatcher = AgentDispatcherConfigSchema.parse({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: replyChannels
    });
    const scheduler = SchedulerConfigSchema.parse({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: replyChannels,
      report_base_dir: "/tmp/reports"
    });

    expect(agentDispatcher.mode).toBe("bridge");
    expect(scheduler.mode).toBe("bridge");
  });

  it("defaults validator calls to codex stateless_call when mode is omitted", () => {
    const validator = ValidatorConfigSchema.parse({});

    expect(validator.agent_type).toBe("codex");
    expect(validator.mode).toBe("stateless_call");
  });

  it("defaults non-codex validator calls to bridge when mode is omitted", () => {
    const validator = ValidatorConfigSchema.parse({ agent_type: "claude" });

    expect(validator.agent_type).toBe("claude");
    expect(validator.mode).toBe("bridge");
  });

  it("rejects stateless_call validator mode for non-codex agents", () => {
    expect(() => ValidatorConfigSchema.parse({ agent_type: "claude", mode: "stateless_call" }))
      .toThrow(/stateless_call validator mode is only supported for codex/);
  });

  it("defaults validator threshold_type to score", () => {
    const validator = ValidatorConfigSchema.parse({});

    expect(validator.threshold_type).toBe("score");
  });

  it("preserves explicit pane_bridge mode for settable role configs", () => {
    const agentDispatcher = AgentDispatcherConfigSchema.parse({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: replyChannels,
      mode: "pane_bridge"
    });
    const scheduler = SchedulerConfigSchema.parse({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: replyChannels,
      report_base_dir: "/tmp/reports",
      mode: "pane_bridge"
    });
    const validator = ValidatorConfigSchema.parse({ mode: "pane_bridge" });

    expect(agentDispatcher.mode).toBe("pane_bridge");
    expect(scheduler.mode).toBe("pane_bridge");
    expect(validator.mode).toBe("pane_bridge");
  });

  it("preserves explicit binary validator threshold_type", () => {
    const validator = ValidatorConfigSchema.parse({ threshold_type: "binary" });

    expect(validator.threshold_type).toBe("binary");
  });
});
