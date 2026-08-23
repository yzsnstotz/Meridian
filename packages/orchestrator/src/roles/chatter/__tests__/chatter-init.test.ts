import { describe, it, expect } from "vitest";
import { buildChatterCreateBody, type ChatterInitAnswers } from "../../../bin/chatter-init";

const validAnswers: ChatterInitAnswers = {
  rolesApiUrl: "http://localhost:7701",
  chatterId: "tenant-a",
  memoryFolder: "/tmp/tenant-a",
  template: "flat-log",
  allowedModes: ["session"],
  skillAllowlist: ["dispatch_coding_job"],
  llmAgentKind: "claude-code",
  userReplyChannelSocket: "/tmp/ads.sock",
  userReplyChannelChatId: "ads:tenant-a"
};

describe("buildChatterCreateBody", () => {
  it("builds a valid create body from minimal answers", () => {
    const body = buildChatterCreateBody(validAnswers);
    expect(body.role_type).toBe("chatter");
    expect(body.thread_id).toBe("chatter-tenant-a");
    expect(body.config.chatter_id).toBe("tenant-a");
    expect(body.config.template).toBe("flat-log");
    expect(body.config.user_reply_channel.channel).toBe("socket");
    expect(body.config.user_reply_channel.socket_path).toBe("/tmp/ads.sock");
  });

  it("substitutes manifest_path when template is 'custom'", () => {
    const body = buildChatterCreateBody({
      ...validAnswers,
      template: "custom",
      manifestPath: "/tmp/my-manifest.json"
    });
    expect(body.config.template).toBeUndefined();
    expect(body.config.manifest_path).toBe("/tmp/my-manifest.json");
  });

  it("rejects 'custom' template without manifest_path", () => {
    expect(() => buildChatterCreateBody({ ...validAnswers, template: "custom" })).toThrow();
  });

  it("rejects empty allowed_modes", () => {
    expect(() => buildChatterCreateBody({ ...validAnswers, allowedModes: [] })).toThrow();
  });

  it("rejects non-absolute memory_folder", () => {
    expect(() => buildChatterCreateBody({ ...validAnswers, memoryFolder: "relative" })).toThrow();
  });

  it("derives thread_id as 'chatter-<chatter_id>'", () => {
    const body = buildChatterCreateBody({ ...validAnswers, chatterId: "tenant-z" });
    expect(body.thread_id).toBe("chatter-tenant-z");
  });

  it("includes credential_id when provided (multi-codex credential binding)", () => {
    const body = buildChatterCreateBody({ ...validAnswers, credentialId: "cred-xyz" });
    expect(body.config.credential_id).toBe("cred-xyz");
  });

  it("omits credential_id when not provided or empty", () => {
    const body = buildChatterCreateBody({ ...validAnswers });
    expect(body.config.credential_id).toBeUndefined();
    const bodyEmpty = buildChatterCreateBody({ ...validAnswers, credentialId: "   " });
    expect(bodyEmpty.config.credential_id).toBeUndefined();
  });

  it("accepts non-claude-code llm_agent_kind values (no chatter-side constraint)", () => {
    for (const kind of ["codex", "claude", "gemini", "custom-kind"]) {
      const body = buildChatterCreateBody({ ...validAnswers, llmAgentKind: kind });
      expect(body.config.llm_agent_kind).toBe(kind);
    }
  });

  it("includes llm_model when provided and omits it when blank", () => {
    const body = buildChatterCreateBody({ ...validAnswers, llmModel: "claude-opus-4-7" });
    expect(body.config.llm_model).toBe("claude-opus-4-7");

    const omitted = buildChatterCreateBody({ ...validAnswers });
    expect(omitted.config.llm_model).toBeUndefined();

    const blank = buildChatterCreateBody({ ...validAnswers, llmModel: "   " });
    expect(blank.config.llm_model).toBeUndefined();
  });
});
