import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../prompt-builder";
import { MERIDIAN_TOOL_DISPLAY_COMMAND } from "../tool-entrypoint";

describe("buildSystemPrompt", () => {
  function createVars() {
    return {
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      dispatch_repo_root: "/tmp",
      user_reply_channels: "[{\"channel\":\"telegram\",\"chat_id\":\"123\"}]",
      default_agent_type: "codex",
      default_mode: "bridge",
      kill_policy: "always",
      resolved_model_map_json: "{\"CODEX\":{\"provider\":\"codex\",\"model_id\":\"gpt-5.4\"}}"
    };
  }

  it("substitutes all runtime variables", () => {
    const prompt = buildSystemPrompt({
      ...createVars(),
      user_reply_channels: "[{\"channel\":\"telegram\",\"chat_id\":\"123\"},{\"channel\":\"web\",\"chat_id\":\"web:ops\"}]"
    });

    expect(prompt).toContain("dispatch_plan_path: /tmp/dispatch_plan.md");
    expect(prompt).toContain("command_file_path: /tmp/agent_dispatch_command.md");
    expect(prompt).toContain("dispatch_repo_root: /tmp");
    expect(prompt).toContain('user_reply_channels: [{"channel":"telegram","chat_id":"123"},{"channel":"web","chat_id":"web:ops"}]');
    expect(prompt).toContain("default_agent_type: codex");
    expect(prompt).toContain("default_mode: bridge");
    expect(prompt).toContain("kill_policy: always");
    expect(prompt).toContain('resolved_model_map_json: {"CODEX":{"provider":"codex","model_id":"gpt-5.4"}}');
  });

  it("does not leave template markers in the output", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).not.toContain("{{");
  });

  it("documents the meridian-tool entrypoint and the current CLI surface", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).toContain(MERIDIAN_TOOL_DISPLAY_COMMAND);
    expect(prompt).not.toContain("npx meridian-tool");
    expect(prompt).not.toContain("/tmp/tsx-");
    expect(prompt).toContain("spawn --agent-type <agent_type> [--model-id <model_id>] [--spawn-dir <path>] [--mode bridge|pane_bridge]");
    expect(prompt).toContain("run --thread-id <id> --command <path> --worker <id>");
    expect(prompt).toContain("kill --thread-id <id>");
    expect(prompt).toContain("resume-worker --plan <dispatch_plan_path> --worker <worker_id>");
    expect(prompt).toContain("notify --message \"<text>\" [--urgency <level>] [--reply-channel '<json>' | --reply-channels '<json-array>']");
    expect(prompt).toContain("stays anchored to the Meridian-roles repo");
    expect(prompt).not.toContain("update-status --plan");
    expect(prompt).not.toContain("update-status --status");
  });

  it("documents deterministic routing, derived plan writes, explicit terminal exit, and non-final run handling", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).toContain("values starting with `CODEX` -> `codex`");
    expect(prompt).toContain("values starting with `GEMINI` -> `gemini`");
    expect(prompt).toContain("resolved_model_map_json");
    expect(prompt).toContain("override precedence is already applied");
    expect(prompt).toContain("use that exact `provider` and `model_id`");
    expect(prompt).toContain("you do not need to write plan status yourself");
    expect(prompt).toContain("marks the worker 🔄 in `dispatch_plan.md`");
    expect(prompt).toContain("send the final completion notify and stop");
    expect(prompt).toContain("data.run_state");
    expect(prompt).toContain("still_running");
    expect(prompt).toContain("timeout");
    expect(prompt).toContain("do not auto-kill the worker");
    expect(prompt).toContain("if any non-human row is already `🔄`, do not select or spawn another worker");
    expect(prompt).toContain("do not dispatch another row");
    expect(prompt).toContain("every dependency is either `✅` or `⛔ SKIPPED`");
    expect(prompt).toContain("always pass `--spawn-dir /tmp`");
    expect(prompt).toContain("Do not inspect Meridian tool internals");
    expect(prompt).toContain("alternate wrappers/transports");
  });

  it("includes abandoned worker recovery instructions", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).toContain("⚠️ ABANDONED");
    expect(prompt).toContain("resume-worker");
    expect(prompt).toContain("go back to Step 1a to retry it");
  });
});
