import { describe, expect, it } from "vitest";

import {
  AgentDispatcherConfigSchema,
  AgentInstanceSchema,
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

describe("payload.chatter.extract_state schema symmetry", () => {
  it("preserves the UploadExtract state contract through outbound HubMessage and inbound HubResult parsing", () => {
    const extractState = {
      stage: "awaiting_final_confirm" as const,
      question: "对吗？要改什么吗？",
      options: ["确认", "调整 hook", "重来"],
      draft_template: {
        id: "template-abc",
        title: "反转复仇短剧",
        cliff_pattern: "every_episode"
      }
    };
    const chatter = {
      mode: "session" as const,
      chatter_session_id: "ads-session-1",
      system_prompt_id: "extract_template_from_draft",
      extract_state: extractState
    };

    const outbound = HubMessageSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "ads",
      actor_id: "ads",
      intent: "run",
      target: "chatter-tenant-a",
      payload: {
        content: "uploaded draft",
        attachments: [],
        chatter
      },
      mode: "bridge",
      reply_channel: { channel: "web", chat_id: "web:ops" }
    });
    expect(outbound.payload.chatter?.extract_state).toEqual(extractState);

    const inbound = HubResultSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "chatter-tenant-a",
      source: "ads",
      status: "success",
      content: "preview ready",
      attachments: [],
      timestamp: "2026-05-20T00:00:00.000Z",
      payload: { chatter }
    });
    expect(inbound.payload?.chatter?.extract_state).toEqual(extractState);
  });

  it("rejects extract_state stages outside the fixed seven-value contract", () => {
    expect(() =>
      HubMessageSchema.parse({
        trace_id: "12345678-1234-4234-8234-123456789012",
        thread_id: "ads",
        actor_id: "ads",
        intent: "run",
        target: "chatter-tenant-a",
        payload: {
          content: "uploaded draft",
          attachments: [],
          chatter: {
            mode: "session",
            extract_state: { stage: "asking_title" }
          }
        },
        mode: "bridge",
        reply_channel: { channel: "web", chat_id: "web:ops" }
      })
    ).toThrow();
  });
});

describe("AgentInstanceSchema socket_path / pid nullability", () => {
  const liveInstance = {
    thread_id: "codex-01",
    agent_type: "codex" as const,
    mode: "bridge" as const,
    socket_path: "/tmp/agentapi-codex-01.sock",
    pid: 4321,
    status: "running" as const,
    created_at: "2026-05-22T00:00:00.000Z"
  };

  it("accepts a live instance with a socket path and pid", () => {
    expect(AgentInstanceSchema.safeParse(liveInstance).success).toBe(true);
  });

  it("accepts stopped / errored instances whose socket_path and pid are null", () => {
    // The Hub reports `socket_path`/`pid` as `null` once an instance is
    // stopped or errored. AgentInstanceStatusSchema already admits those
    // states, so the schema must accept the null fields — otherwise one dead
    // instance rejected the whole AgentInstance[] list (see a2a/client.ts).
    expect(
      AgentInstanceSchema.safeParse({ ...liveInstance, status: "stopped", socket_path: null, pid: null }).success
    ).toBe(true);
    expect(
      AgentInstanceSchema.safeParse({ ...liveInstance, status: "error", socket_path: null, pid: null }).success
    ).toBe(true);
  });

  it("still rejects a genuinely malformed instance", () => {
    expect(AgentInstanceSchema.safeParse({ ...liveInstance, thread_id: "" }).success).toBe(false);
    expect(AgentInstanceSchema.safeParse({ ...liveInstance, status: "bogus" }).success).toBe(false);
  });
});
