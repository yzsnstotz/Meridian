import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSandboxSpawnPlan } from "../sandbox";

describe("buildSandboxSpawnPlan", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "chatter-sb-"));
  });

  it("sets cwd to memory folder root", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: ["dispatch_coding_job"],
      llmAgentKind: "claude-code"
    });
    expect(plan.cwd).toBe(root);
  });

  it("settingsPath is under <memoryFolder>/.chatter-sandbox/", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: [],
      llmAgentKind: "claude-code"
    });
    expect(plan.settingsPath).toBe(path.join(root, ".chatter-sandbox", "settings.json"));
  });

  it("materialize() writes settings.json with deny + allow rules", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: [],
      llmAgentKind: "claude-code"
    });
    plan.materialize();
    expect(existsSync(plan.settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(plan.settingsPath, "utf8"));
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Bash(*)", "WebFetch(*)", "WebSearch(*)", "Read(/**)", "Write(/**)"])
    );
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining([`Read(${root}/**)`, `Write(${root}/**)`])
    );
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.enabledMcpjsonServers).toEqual([]);
  });

  it("toolDescriptors include built-in chatter tools + dispatch_coding_job + allowlisted extras", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: ["dispatch_coding_job", "web_search"],
      llmAgentKind: "claude-code"
    });
    const names = plan.toolDescriptors.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "chatter.memory.list",
        "chatter.memory.read",
        "chatter.memory.write",
        "chatter.suggest_observation",
        "chatter.skill.dispatch_coding_job",
        "chatter.skill.web_search"
      ].sort()
    );
  });

  it("toolDescriptors expose allowlisted structured tools by their raw names", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: ["structured.upsert", "structured.get"],
      llmAgentKind: "claude-code"
    });
    const names = plan.toolDescriptors.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "chatter.memory.list",
        "chatter.memory.read",
        "chatter.memory.write",
        "chatter.suggest_observation",
        "structured.get",
        "structured.upsert"
      ].sort()
    );
  });

  it("never includes shell/web/exec tools by default (only built-in chatter tools when allowlist is empty)", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: [],
      llmAgentKind: "claude-code"
    });
    const names = plan.toolDescriptors.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "chatter.memory.read",
        "chatter.memory.write",
        "chatter.memory.list",
        "chatter.suggest_observation"
      ])
    );
    expect(names).not.toContain("Bash");
    expect(names).not.toContain("WebFetch");
    expect(names).not.toContain("WebSearch");
    // No "chatter.skill.*" tool when allowlist is empty
    expect(names.filter((n) => n.startsWith("chatter.skill."))).toEqual([]);
  });

  it("spawnArgs include --settings and --cwd flags pointing at the right paths", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: [],
      llmAgentKind: "claude-code"
    });
    expect(plan.spawnArgs).toEqual(
      expect.arrayContaining(["--settings", plan.settingsPath, "--cwd", root])
    );
  });

  it("two Chatters produce non-overlapping settings file paths", () => {
    const root2 = mkdtempSync(path.join(tmpdir(), "chatter-sb-"));
    const a = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: [],
      llmAgentKind: "claude-code"
    });
    const b = buildSandboxSpawnPlan({
      memoryFolder: root2,
      skillAllowlist: [],
      llmAgentKind: "claude-code"
    });
    expect(a.settingsPath).not.toBe(b.settingsPath);
    a.materialize();
    b.materialize();
    expect(existsSync(a.settingsPath)).toBe(true);
    expect(existsSync(b.settingsPath)).toBe(true);
  });

  it("materialize() is idempotent (safe to call twice)", () => {
    const plan = buildSandboxSpawnPlan({
      memoryFolder: root,
      skillAllowlist: [],
      llmAgentKind: "claude-code"
    });
    plan.materialize();
    expect(() => plan.materialize()).not.toThrow();
    expect(existsSync(plan.settingsPath)).toBe(true);
  });
});
