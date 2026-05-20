import { describe, expect, it } from "vitest";

import {
  AgentDispatcherConfigSchema,
  HubMessageSchema,
  HubResultSchema,
  PmResolverConfigSchema,
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

  it("preserves explicit binary validator threshold_type", () => {
    const validator = ValidatorConfigSchema.parse({ threshold_type: "binary" });

    expect(validator.threshold_type).toBe("binary");
  });

  it("defaults PM resolver on for dispatcher and scheduler configs", () => {
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

    expect(agentDispatcher.pm_resolver).toEqual({
      enabled: true,
      agent_type: "codex",
      mode: "bridge",
      auto_approve: false,
      user_reply_channels: replyChannels
    });
    expect(scheduler.pm_resolver).toEqual(agentDispatcher.pm_resolver);
  });

  it("allows PM resolver to choose its own model and informing channels", () => {
    const pmResolver = PmResolverConfigSchema.parse({
      enabled: true,
      agent_type: "claude",
      model_id: "claude-opus-4-7",
      mode: "bridge",
      auto_approve: true,
      user_reply_channels: [{ channel: "web", chat_id: "web:pm" }]
    });

    expect(pmResolver).toEqual({
      enabled: true,
      agent_type: "claude",
      model_id: "claude-opus-4-7",
      mode: "bridge",
      auto_approve: true,
      user_reply_channels: [{ channel: "web", chat_id: "web:pm" }]
    });
  });
});

describe("payload.chatter.system_prompt_id schema symmetry", () => {
  it("preserves system_prompt_id through both outbound HubMessage and inbound HubResult parsing", () => {
    const chatter = {
      mode: "session" as const,
      chatter_session_id: "ads-session-1",
      system_prompt_id: "create_from_template"
    };

    const outbound = HubMessageSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "ads",
      actor_id: "ads",
      intent: "run",
      target: "chatter-tenant-a",
      payload: {
        content: "draft a short drama",
        attachments: [],
        chatter
      },
      mode: "bridge",
      reply_channel: { channel: "web", chat_id: "web:ops" }
    });
    expect(outbound.payload.chatter?.system_prompt_id).toBe("create_from_template");

    const inbound = HubResultSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "chatter-tenant-a",
      source: "ads",
      status: "success",
      content: "draft a short drama",
      attachments: [],
      timestamp: "2026-05-20T00:00:00.000Z",
      payload: { chatter }
    });
    expect(inbound.payload?.chatter?.system_prompt_id).toBe("create_from_template");
  });
});

describe("payload.chatter.context_refs schema symmetry", () => {
  it("preserves context_refs through both outbound HubMessage and inbound HubResult parsing", () => {
    const chatter = {
      mode: "session" as const,
      chatter_session_id: "ads-session-1",
      context_refs: [
        { type: "template_short_drama", key: "template-abc" },
        { type: "style_short_drama", key: "user-42" }
      ]
    };

    const outbound = HubMessageSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "ads",
      actor_id: "ads",
      intent: "run",
      target: "chatter-tenant-a",
      payload: {
        content: "draft a short drama",
        attachments: [],
        chatter
      },
      mode: "bridge",
      reply_channel: { channel: "web", chat_id: "web:ops" }
    });
    expect(outbound.payload.chatter?.context_refs).toEqual(chatter.context_refs);

    const inbound = HubResultSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "chatter-tenant-a",
      source: "ads",
      status: "success",
      content: "draft a short drama",
      attachments: [],
      timestamp: "2026-05-20T00:00:00.000Z",
      payload: { chatter }
    });
    expect(inbound.payload?.chatter?.context_refs).toEqual(chatter.context_refs);
  });
});
