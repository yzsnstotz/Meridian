import { describe, it, expect } from "vitest";
import {
  RoleTypeSchema,
  ChatterRoleConfigSchema,
  HubPayloadSchema,
  HubResultSchema
} from "../../../types";

describe("RoleTypeSchema with chatter", () => {
  it("accepts 'chatter'", () => {
    expect(RoleTypeSchema.parse("chatter")).toBe("chatter");
  });

  it("still accepts every prior role type unchanged", () => {
    for (const t of ["dispatcher", "agent-dispatcher", "scheduler"]) {
      expect(RoleTypeSchema.parse(t)).toBe(t);
    }
  });
});

describe("ChatterRoleConfigSchema", () => {
  const validBody = {
    chatter_id: "tenant-a",
    memory_folder: "/tmp/chatter-tenant-a",
    template: "flat-log",
    allowed_modes: ["session"],
    skill_allowlist: ["dispatch_coding_job"],
    llm_agent_kind: "claude-code",
    user_reply_channel: {
      channel: "socket",
      chat_id: "ads:demo",
      socket_path: "/tmp/ads.sock"
    }
  };

  it("accepts a minimal valid config", () => {
    const parsed = ChatterRoleConfigSchema.parse(validBody);
    expect(parsed.chatter_id).toBe("tenant-a");
    expect(parsed.allowed_modes).toEqual(["session"]);
  });

  it("rejects empty allowed_modes", () => {
    expect(() => ChatterRoleConfigSchema.parse({ ...validBody, allowed_modes: [] })).toThrow();
  });

  it("rejects non-absolute memory_folder", () => {
    expect(() => ChatterRoleConfigSchema.parse({ ...validBody, memory_folder: "relative/path" })).toThrow();
  });

  it("requires either template or manifest_path", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { template, ...noTemplate } = validBody;
    expect(() => ChatterRoleConfigSchema.parse(noTemplate)).toThrow();
  });

  it("accepts manifest_path instead of template", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { template, ...rest } = validBody;
    const parsed = ChatterRoleConfigSchema.parse({ ...rest, manifest_path: "/tmp/manifest.json" });
    expect(parsed.manifest_path).toBe("/tmp/manifest.json");
  });

  it("accepts an optional credential_id (multi-codex credential binding)", () => {
    const parsed = ChatterRoleConfigSchema.parse({ ...validBody, credential_id: "cred-uuid-1" });
    expect(parsed.credential_id).toBe("cred-uuid-1");
  });

  it("credential_id is undefined when omitted", () => {
    const parsed = ChatterRoleConfigSchema.parse(validBody);
    expect(parsed.credential_id).toBeUndefined();
  });

  it("rejects an empty-string credential_id", () => {
    expect(() => ChatterRoleConfigSchema.parse({ ...validBody, credential_id: "" })).toThrow();
  });

  it("rejects when user_reply_channel is missing", () => {
    const { user_reply_channel: _omitted, ...rest } = validBody;
    void _omitted;
    expect(() => ChatterRoleConfigSchema.parse(rest)).toThrow();
  });

  it("defaults llm_agent_kind to claude-code", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { llm_agent_kind, ...rest } = validBody;
    const parsed = ChatterRoleConfigSchema.parse(rest);
    expect(parsed.llm_agent_kind).toBe("claude-code");
  });
});

describe("HubResultSchema with optional payload.chatter", () => {
  const base = {
    trace_id: "12345678-1234-4234-8234-123456789012",
    thread_id: "t",
    source: "claude-code",
    status: "success" as const,
    content: "hi",
    attachments: [],
    timestamp: "2026-05-19T00:00:00.000Z"
  };

  it("parses without payload (existing roles unaffected)", () => {
    const parsed = HubResultSchema.parse(base);
    expect(parsed.payload).toBeUndefined();
  });

  it("parses with payload.chatter envelope", () => {
    const parsed = HubResultSchema.parse({
      ...base,
      payload: { chatter: { mode: "session", chatter_session_id: "s1", control: "new" } }
    });
    expect(parsed.payload?.chatter?.mode).toBe("session");
    expect(parsed.payload?.chatter?.control).toBe("new");
  });

  it("rejects payload.chatter with invalid mode", () => {
    expect(() =>
      HubResultSchema.parse({
        ...base,
        payload: { chatter: { mode: "broken" } }
      })
    ).toThrow();
  });
});

describe("HubPayloadSchema with chatter envelope", () => {
  it("accepts payload without chatter field (existing roles unaffected)", () => {
    const parsed = HubPayloadSchema.parse({ content: "hello", attachments: [] });
    expect(parsed.chatter).toBeUndefined();
  });

  it("accepts payload.chatter with mode session_id and control", () => {
    const parsed = HubPayloadSchema.parse({
      content: "hello",
      attachments: [],
      chatter: { mode: "session", chatter_session_id: "s1", control: "new" }
    });
    expect(parsed.chatter?.mode).toBe("session");
    expect(parsed.chatter?.control).toBe("new");
  });

  it("rejects invalid mode", () => {
    expect(() => HubPayloadSchema.parse({
      content: "hi",
      attachments: [],
      chatter: { mode: "broken" }
    })).toThrow();
  });
});
