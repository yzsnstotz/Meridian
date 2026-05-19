import { describe, it, expect } from "vitest";
import {
  AgentDispatcherConfigSchema,
  PmResolverConfigSchema,
  ValidatorConfigSchema
} from "./types";

const validReplyChannel = {
  channel: "telegram" as const,
  chat_id: "test-chat-123"
};

const validBase = {
  dispatch_plan_path: "/tmp/plan.md",
  command_file_path: "/tmp/cmd.md",
  dispatch_repo_root: "/tmp/repo",
  docs_root: "/tmp/docs",
  user_reply_channels: [validReplyChannel]
};

describe("AgentDispatcherConfig.credential_id", () => {
  it("defaults to undefined when omitted", () => {
    const parsed = AgentDispatcherConfigSchema.parse(validBase);
    expect(parsed.credential_id).toBeUndefined();
  });

  it("accepts a string credential_id", () => {
    const parsed = AgentDispatcherConfigSchema.parse({
      ...validBase,
      credential_id: "cred-abc"
    });
    expect(parsed.credential_id).toBe("cred-abc");
  });

  it("rejects empty-string credential_id", () => {
    const result = AgentDispatcherConfigSchema.safeParse({
      ...validBase,
      credential_id: ""
    });
    expect(result.success).toBe(false);
  });
});
