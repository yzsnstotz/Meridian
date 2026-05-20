import { describe, it, expect } from "vitest";
import { assertModeAllowed, assertSkillAllowed, ChatterPolicyError } from "../allowlist";

describe("assertModeAllowed", () => {
  it("passes when mode is in allowed_modes", () => {
    expect(() => assertModeAllowed("session", ["session"])).not.toThrow();
  });

  it("rejects when mode is not in allowed_modes", () => {
    expect(() => assertModeAllowed("stateless", ["session"])).toThrow(ChatterPolicyError);
  });

  it("accepts when both modes are allowed", () => {
    expect(() => assertModeAllowed("stateless", ["stateless", "session"])).not.toThrow();
    expect(() => assertModeAllowed("session", ["stateless", "session"])).not.toThrow();
  });

  it("attaches code 'denied_mode' on the error", () => {
    try {
      assertModeAllowed("stateless", ["session"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChatterPolicyError);
      expect((e as ChatterPolicyError).code).toBe("denied_mode");
    }
  });
});

describe("assertSkillAllowed", () => {
  it("permits built-in memory tools implicitly", () => {
    expect(() => assertSkillAllowed("chatter.memory.read", [])).not.toThrow();
    expect(() => assertSkillAllowed("chatter.memory.write", [])).not.toThrow();
    expect(() => assertSkillAllowed("chatter.memory.list", [])).not.toThrow();
  });

  it("permits built-in dispatch_coding_job implicitly", () => {
    expect(() => assertSkillAllowed("chatter.skill.dispatch_coding_job", [])).not.toThrow();
  });

  it("permits operator-allowlisted skill", () => {
    expect(() => assertSkillAllowed("chatter.skill.web_search", ["web_search"])).not.toThrow();
  });

  it("permits raw structured tool names only when explicitly allowlisted", () => {
    expect(() => assertSkillAllowed("structured.upsert", ["structured.upsert"])).not.toThrow();
    expect(() => assertSkillAllowed("structured.get", ["structured.upsert"])).toThrow(
      ChatterPolicyError
    );
  });

  it("rejects skill not in allowlist", () => {
    expect(() => assertSkillAllowed("chatter.skill.exec", ["web_search"])).toThrow(ChatterPolicyError);
  });

  it("rejects unknown tool name pattern", () => {
    expect(() => assertSkillAllowed("Bash", ["web_search"])).toThrow(ChatterPolicyError);
    expect(() => assertSkillAllowed("WebFetch", ["web_search"])).toThrow(ChatterPolicyError);
  });

  it("attaches code 'denied_skill' on the error", () => {
    try {
      assertSkillAllowed("chatter.skill.exec", []);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChatterPolicyError);
      expect((e as ChatterPolicyError).code).toBe("denied_skill");
    }
  });

  it("does not accept fake memory tool variants", () => {
    expect(() => assertSkillAllowed("chatter.memory.exec", [])).toThrow(ChatterPolicyError);
    expect(() => assertSkillAllowed("chatter.memory", [])).toThrow(ChatterPolicyError);
  });

  it("rejects empty-skill name even when '' is in the allowlist", () => {
    expect(() => assertSkillAllowed("chatter.skill.", [""])).toThrow(ChatterPolicyError);
  });
});
