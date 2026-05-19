import { describe, it, expect } from "vitest";
import { AgentDispatcherConfigSchema, type AgentDispatcherConfig } from "../../types";
import { resolveCredentialForSpawn } from "./credential-resolution";

const validReplyChannel = {
  channel: "telegram" as const,
  chat_id: "test-chat-123"
};

const mkCfg = (
  parent?: string,
  validator?: string,
  pm?: string
): AgentDispatcherConfig => {
  const raw: Record<string, unknown> = {
    dispatch_plan_path: "/tmp/plan.md",
    command_file_path: "/tmp/cmd.md",
    dispatch_repo_root: "/tmp/repo",
    docs_root: "/tmp/docs",
    user_reply_channels: [validReplyChannel],
    agent_type: "codex",
    mode: "bridge"
  };
  if (parent !== undefined) raw.credential_id = parent;
  if (validator !== undefined) {
    raw.validator = { agent_type: "codex", credential_id: validator };
  }
  if (pm !== undefined) {
    raw.pm_resolver = { agent_type: "codex", credential_id: pm };
  }
  return AgentDispatcherConfigSchema.parse(raw);
};

describe("resolveCredentialForSpawn — inheritance matrix", () => {
  it("main uses top-level credential_id", () => {
    expect(resolveCredentialForSpawn("main", mkCfg("cred-A"))).toBe("cred-A");
  });

  it("validator inherits top-level when own unset", () => {
    expect(resolveCredentialForSpawn("validator", mkCfg("cred-A"))).toBe("cred-A");
  });

  it("validator overrides top-level when own set", () => {
    expect(resolveCredentialForSpawn("validator", mkCfg("cred-A", "cred-B"))).toBe("cred-B");
  });

  it("validator override applies even without parent", () => {
    expect(resolveCredentialForSpawn("validator", mkCfg(undefined, "cred-B"))).toBe("cred-B");
  });

  it("pm_resolver inherits top-level when own unset", () => {
    expect(resolveCredentialForSpawn("pm_resolver", mkCfg("cred-A"))).toBe("cred-A");
  });

  it("pm_resolver overrides top-level when own set", () => {
    expect(resolveCredentialForSpawn("pm_resolver", mkCfg("cred-A", undefined, "cred-C"))).toBe("cred-C");
  });

  it("pm_resolver override applies even without parent", () => {
    expect(resolveCredentialForSpawn("pm_resolver", mkCfg(undefined, undefined, "cred-C"))).toBe("cred-C");
  });

  it("all unset → undefined (hub falls back to ~/.codex)", () => {
    expect(resolveCredentialForSpawn("main", mkCfg())).toBeUndefined();
    expect(resolveCredentialForSpawn("validator", mkCfg())).toBeUndefined();
    expect(resolveCredentialForSpawn("pm_resolver", mkCfg())).toBeUndefined();
  });
});
