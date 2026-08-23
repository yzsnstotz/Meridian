import { describe, expect, it } from "vitest";

import { ProjectPolicySchema } from "./project-policy-schema";

const mumuSamplePolicy = {
  project_id: "mumu",
  thread_id_pattern: "chatter-mumu-user-{user_id}",
  memory_folder_pattern: "/data/mumu/users/{user_id}",
  manifest_path: "/etc/meridian-roles/projects/mumu/manifest.json",
  seeds_source_path: "/etc/meridian-roles/projects/mumu/seeds",
  allowed_modes: ["session", "stateless"],
  skill_allowlist: [
    "structured.upsert",
    "structured.get",
    "structured.query",
    "structured.delete",
    "structured.list"
  ],
  llm_agent_kind: "claude-code",
  credential_id: null,
  user_reply_channel_template: {
    channel: "socket",
    chat_id: "ads:mumu:{user_id}",
    socket_path: "/var/run/ads-mumu.sock"
  },
  seeds_init: { mode: "copy_on_provision" }
};

describe("ProjectPolicySchema", () => {
  it("parses the mumu sample policy from the design", () => {
    expect(ProjectPolicySchema.parse(mumuSamplePolicy)).toEqual(mumuSamplePolicy);
  });

  it("rejects unknown top-level policy keys", () => {
    const result = ProjectPolicySchema.safeParse({
      ...mumuSamplePolicy,
      evil_key: "caller-controlled"
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Unrecognized key");
    }
  });

  it("requires allowed modes to be known bridge modes for chatter", () => {
    const result = ProjectPolicySchema.safeParse({
      ...mumuSamplePolicy,
      allowed_modes: ["session", "operator"]
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["allowed_modes", 1]);
    }
  });
});
