import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseNormalizedAgentDispatcherConfig } from "../config-normalization";
import { buildSystemPrompt, materializeDispatcherSystemPrompt } from "../prompt-builder";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("parseNormalizedAgentDispatcherConfig", () => {
  it("preserves explicit dispatch_repo_root without overriding to inferred repo root", async () => {
    const harness = await createDetachedDispatchHarness();
    const threadId = "agent-dispatcher-rehydrated";
    const prompt = materializeDispatcherSystemPrompt(
      buildSystemPrompt({
        dispatch_plan_path: harness.dispatchPlanPath,
        command_file_path: harness.commandFilePath,
        dispatcher_role_id: threadId,
        dispatch_repo_root: harness.workspaceRoot,
        docs_root: path.join(harness.workspaceRoot, "Docs"),
        user_reply_channels: JSON.stringify(harness.baseConfig.user_reply_channels),
        default_agent_type: harness.baseConfig.agent_type,
        default_mode: harness.baseConfig.mode,
        kill_policy: harness.baseConfig.kill_policy,
        auto_approve: harness.baseConfig.auto_approve,
        resolved_model_map_json: "{}"
      }),
      threadId
    );

    const normalized = parseNormalizedAgentDispatcherConfig(
      {
        ...harness.baseConfig,
        dispatch_repo_root: harness.workspaceRoot,
        docs_root: path.join(harness.workspaceRoot, "Docs"),
        system_prompt: prompt
      },
      { threadId }
    );

    expect(normalized).toMatchObject({
      dispatch_plan_path: harness.dispatchPlanPath,
      command_file_path: harness.commandFilePath,
      dispatch_repo_root: harness.workspaceRoot,
      docs_root: path.join(harness.workspaceRoot, "Docs")
    });
    expect(normalized?.system_prompt).toContain(`dispatcher_role_id: ${threadId}`);
    expect(normalized?.system_prompt).toContain(`dispatch_repo_root: ${harness.workspaceRoot}`);
  });

  it("preserves custom prompts without modifying explicit roots", async () => {
    const harness = await createDetachedDispatchHarness();

    const normalized = parseNormalizedAgentDispatcherConfig(
      {
        ...harness.baseConfig,
        dispatch_repo_root: harness.workspaceRoot,
        docs_root: path.join(harness.workspaceRoot, "Docs"),
        system_prompt: "Custom dispatcher instructions stay exactly as written."
      },
      { threadId: "agent-dispatcher-custom" }
    );

    expect(normalized).toMatchObject({
      dispatch_repo_root: harness.workspaceRoot,
      docs_root: path.join(harness.workspaceRoot, "Docs"),
      system_prompt: "Custom dispatcher instructions stay exactly as written."
    });
  });
});

async function createDetachedDispatchHarness(): Promise<{
  workspaceRoot: string;
  repoRoot: string;
  docsRoot: string;
  dispatchPlanPath: string;
  commandFilePath: string;
  baseConfig: {
    tasks: [];
    dispatch_plan_path: string;
    command_file_path: string;
    user_reply_channels: Array<{ channel: "telegram"; chat_id: string }>;
    agent_type: "codex";
    mode: "pane_bridge";
    kill_policy: "always";
    auto_approve: false;
    use_agent_dispatcher: true;
  };
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-config-normalization-"));
  tempDirectories.add(workspaceRoot);

  const repoRoot = path.join(workspaceRoot, "projects/clawso");
  await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "Docs"), { recursive: true });
  const docsRoot = await fs.realpath(path.join(workspaceRoot, "Docs"));

  const dispatchPlanPath = path.join(
    workspaceRoot,
    "Docs/Projects/clawso/branch/feat-cli/taskspec/dispatch_plan.md"
  );
  const commandFilePath = path.join(
    workspaceRoot,
    "Docs/Projects/clawso/branch/feat-cli/taskspec/agent_dispatch_command.md"
  );
  await fs.mkdir(path.dirname(dispatchPlanPath), { recursive: true });
  await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
  await fs.writeFile(commandFilePath, "# Agent Dispatch Command\n", "utf8");

  return {
    workspaceRoot,
    repoRoot: await fs.realpath(repoRoot),
    docsRoot,
    dispatchPlanPath,
    commandFilePath,
    baseConfig: {
      tasks: [],
      dispatch_plan_path: dispatchPlanPath,
      command_file_path: commandFilePath,
      user_reply_channels: [
        {
          channel: "telegram",
          chat_id: "telegram:ops"
        }
      ],
      agent_type: "codex",
      mode: "pane_bridge",
      kill_policy: "always",
      auto_approve: false,
      use_agent_dispatcher: true
    }
  };
}
