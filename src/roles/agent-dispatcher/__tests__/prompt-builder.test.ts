import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../prompt-builder";
import { MERIDIAN_TOOL_DISPLAY_COMMAND } from "../tool-entrypoint";

describe("buildSystemPrompt", () => {
  function createVars() {
    return {
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      dispatcher_role_id: "agent-dispatcher-r03",
      dispatch_repo_root: "/tmp",
      docs_root: "/tmp/Docs",
      user_reply_channels: "[{\"channel\":\"telegram\",\"chat_id\":\"123\"}]",
      default_agent_type: "codex",
      default_mode: "bridge",
      kill_policy: "always",
      auto_approve: true,
      resolved_model_map_json: "{\"CODEX\":{\"provider\":\"codex\",\"model_id\":\"gpt-5.4\"}}",
      pm_resolver_config_json: "{\"enabled\":true,\"agent_type\":\"codex\",\"mode\":\"bridge\",\"auto_approve\":false}"
    };
  }

  it("substitutes all runtime variables", () => {
    const prompt = buildSystemPrompt({
      ...createVars(),
      user_reply_channels: "[{\"channel\":\"telegram\",\"chat_id\":\"123\"},{\"channel\":\"web\",\"chat_id\":\"web:ops\"}]"
    });

    expect(prompt).toContain("dispatch_plan_path: /tmp/dispatch_plan.md");
    expect(prompt).toContain("command_file_path: /tmp/agent_dispatch_command.md");
    expect(prompt).toContain("dispatcher_role_id: agent-dispatcher-r03");
    expect(prompt).toContain("dispatch_repo_root: /tmp");
    expect(prompt).toContain("docs_root: /tmp/Docs");
    expect(prompt).toContain('user_reply_channels: [{"channel":"telegram","chat_id":"123"},{"channel":"web","chat_id":"web:ops"}]');
    expect(prompt).toContain("default_agent_type: codex");
    expect(prompt).toContain("default_mode: bridge");
    expect(prompt).toContain("kill_policy: always");
    expect(prompt).toContain("auto_approve: true");
    expect(prompt).toContain('resolved_model_map_json: {"CODEX":{"provider":"codex","model_id":"gpt-5.4"}}');
    expect(prompt).toContain('pm_resolver_config_json: {"enabled":true,"agent_type":"codex","mode":"bridge","auto_approve":false}');
  });

  it("does not leave template markers in the output", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).not.toContain("{{");
  });

  it("documents the service-owned dispatcher control surface", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).toContain(MERIDIAN_TOOL_DISPLAY_COMMAND);
    expect(prompt).not.toContain("npx meridian-tool");
    expect(prompt).not.toContain("/tmp/tsx-");
    expect(prompt).toContain("continue-dispatcher --dispatcher agent-dispatcher-r03 [--worker <worker_id>]");
    expect(prompt).toContain("kill --thread-id <id>");
    expect(prompt).toContain("resume-worker --plan <dispatch_plan_path> --worker <worker_id>");
    expect(prompt).toContain("notify --message \"<text>\" [--urgency <level>] [--reply-channel '<json>' | --reply-channels '<json-array>']");
    expect(prompt).toContain("pm-resolve --dispatcher agent-dispatcher-r03");
    expect(prompt).toContain("Approval policy crosses the Meridian boundary as neutral `auto_approve`");
    expect(prompt).toContain("executable lives in the Meridian-roles repo");
    expect(prompt).toContain("run inside the worker sandbox rooted at `dispatch_repo_root`");
    expect(prompt).toContain("Meridian owns worker launch transport behind the API boundary");
    expect(prompt).toContain("owns next-worker selection");
    expect(prompt).toContain("Do not resolve model routing or call worker `spawn` / `run` yourself");
    expect(prompt).not.toContain("update-status --plan");
    expect(prompt).not.toContain("update-status --status");
  });

  it("documents service-owned continuation, explicit terminal exit, and bounded recovery", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).toContain("resolved_model_map_json");
    expect(prompt).toContain("service applies the selection priority");
    expect(prompt).toContain("`⚠️ ABANDONED` first, then retryable `❌`, then `⬜` rows");
    expect(prompt).toContain("send the final completion notify and stop");
    expect(prompt).toContain("status: \"continued\"");
    expect(prompt).toContain("status: \"still_blocked\"");
    expect(prompt).toContain("status: \"manual_intervention_required\"");
    expect(prompt).toContain("status: \"local_tool_bootstrap_failed\"");
    expect(prompt).toContain("call `pm-resolve --dispatcher <dispatcher_role_id>`");
    expect(prompt).toContain("PM resolver is disabled");
    expect(prompt).toContain("If a worker reply says `:hit limit`");
    expect(prompt).toContain("Hit limit: `[Dispatcher] ⛔ worker hit limit");
    expect(prompt).toContain("If any non-human row is already `🔄`");
    expect(prompt).toContain("do not try to route around it locally");
    expect(prompt).toContain("service enforces `kill_policy`");
    expect(prompt).toContain("Do not resolve agent provider/model routing locally");
    expect(prompt).toContain("do not inspect tool internals");
    expect(prompt).toContain("alternate wrappers/transports");
  });

  it("includes scope constraints that fence the dispatcher to control-flow only", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).toContain("# Scope Constraints");
    expect(prompt).toContain("MUST NOT");
    expect(prompt).toContain("source code");
    expect(prompt).toContain("git branches");
    expect(prompt).toContain("Fix bugs");
    expect(prompt).toContain("Meridian-roles internals");
    expect(prompt).toContain("non-dispatch work");
    expect(prompt).toContain("notify and pause instead");
  });

  it("includes abandoned worker recovery instructions", () => {
    const prompt = buildSystemPrompt(createVars());

    expect(prompt).toContain("⚠️ ABANDONED");
    expect(prompt).toContain("continue-dispatcher");
    expect(prompt).toContain("resume-worker");
    expect(prompt).toContain("go back to Step 2");
  });
});
