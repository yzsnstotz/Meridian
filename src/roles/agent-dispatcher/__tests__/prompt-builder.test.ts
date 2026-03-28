import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../prompt-builder";

describe("buildSystemPrompt", () => {
  it("substitutes all runtime variables", () => {
    const prompt = buildSystemPrompt({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channel: "{\"channel\":\"telegram\",\"chat_id\":\"123\"}"
    });

    expect(prompt).toContain("dispatch_plan_path: /tmp/dispatch_plan.md");
    expect(prompt).toContain("command_file_path: /tmp/agent_dispatch_command.md");
    expect(prompt).toContain('user_reply_channel: {"channel":"telegram","chat_id":"123"}');
  });

  it("does not leave template markers in the output", () => {
    const prompt = buildSystemPrompt({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channel: "{\"channel\":\"telegram\",\"chat_id\":\"123\"}"
    });

    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("}}");
  });

  it("documents the tsx tool entrypoint and all five tools", () => {
    const prompt = buildSystemPrompt({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channel: "{\"channel\":\"telegram\",\"chat_id\":\"123\"}"
    });

    expect(prompt).toContain("npx tsx src/bin/meridian-tool.ts");
    expect(prompt).not.toContain("npx meridian-tool");
    expect(prompt).toContain("spawn --agent-type <type> --mode <mode>");
    expect(prompt).toContain("run --thread-id <id> --command <path> --worker <id>");
    expect(prompt).toContain("kill --thread-id <id>");
    expect(prompt).toContain("notify --message \"<text>\" --urgency <level>");
    expect(prompt).toContain("update-status --plan <path> --worker <id> --status <status>");
  });
});
