#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ChatterRoleConfigSchema, type ChatterRoleConfig, type ChatterTemplateName } from "../types";

export interface ChatterInitAnswers {
  rolesApiUrl: string;          // e.g., http://localhost:7701
  chatterId: string;
  memoryFolder: string;
  template: ChatterTemplateName | "custom";
  manifestPath?: string;
  allowedModes: ("stateless" | "session")[];
  skillAllowlist: string[];
  llmAgentKind: "claude-code";
  userReplyChannelSocket: string;
  userReplyChannelChatId: string;
}

export interface ChatterCreateBody {
  role_type: "chatter";
  thread_id: string;
  config: ChatterRoleConfig;
}

/**
 * Pure function: maps wizard answers to a validated create-body. Throws on
 * schema violation so the wizard surface can re-prompt.
 */
export function buildChatterCreateBody(answers: ChatterInitAnswers): ChatterCreateBody {
  const baseConfig: Record<string, unknown> = {
    chatter_id: answers.chatterId,
    memory_folder: answers.memoryFolder,
    allowed_modes: answers.allowedModes,
    skill_allowlist: answers.skillAllowlist,
    llm_agent_kind: answers.llmAgentKind,
    user_reply_channel: {
      channel: "socket",
      chat_id: answers.userReplyChannelChatId,
      socket_path: answers.userReplyChannelSocket
    }
  };

  if (answers.template === "custom") {
    if (!answers.manifestPath) {
      throw new Error("manifest_path is required when template is 'custom'");
    }
    baseConfig.manifest_path = answers.manifestPath;
  } else {
    baseConfig.template = answers.template;
  }

  const parsed = ChatterRoleConfigSchema.parse(baseConfig);
  return {
    role_type: "chatter",
    thread_id: `chatter-${answers.chatterId}`,
    config: parsed
  };
}

async function ask(rl: readline.Interface, prompt: string, fallback?: string): Promise<string> {
  const suffix = fallback !== undefined ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  if (answer.length === 0 && fallback !== undefined) return fallback;
  return answer;
}

async function runWizard(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("\n=== Chatter init wizard ===\n");
    const rolesApiUrl = await ask(rl, "meridian-roles API URL", "http://localhost:7701");
    const chatterId = await ask(rl, "chatter_id (slug, e.g. tenant-a)");
    const memoryFolder = await ask(rl, "memory_folder (absolute path)");
    const templateRaw = await ask(rl, "template (flat-log | topic-tree | indexed-kb | custom)", "flat-log");
    const template = templateRaw as ChatterInitAnswers["template"];
    const manifestPath = template === "custom"
      ? await ask(rl, "manifest_path (absolute path)")
      : undefined;
    const allowedModesRaw = await ask(rl, "allowed_modes (comma: stateless,session)", "stateless,session");
    const allowedModes = allowedModesRaw.split(",").map((s) => s.trim()).filter(Boolean) as ("stateless" | "session")[];
    const skillAllowlistRaw = await ask(rl, "skill_allowlist (comma, blank for none)", "");
    const skillAllowlist = skillAllowlistRaw.length === 0
      ? []
      : skillAllowlistRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const userReplyChannelSocket = await ask(rl, "user_reply_channel socket_path", "/tmp/ads.sock");
    const userReplyChannelChatId = await ask(rl, "user_reply_channel chat_id", `ads:${chatterId}`);

    const body = buildChatterCreateBody({
      rolesApiUrl,
      chatterId,
      memoryFolder,
      template,
      manifestPath,
      allowedModes,
      skillAllowlist,
      llmAgentKind: "claude-code",
      userReplyChannelSocket,
      userReplyChannelChatId
    });

    stdout.write("\nPOST body:\n");
    stdout.write(`${JSON.stringify(body, null, 2)}\n\n`);
    stdout.write(`Send it with:\n  curl -X POST ${rolesApiUrl}/api/role \\\n    -H 'Content-Type: application/json' \\\n    -d '${JSON.stringify(body)}'\n`);
  } finally {
    rl.close();
  }
}

// Run the wizard when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return entry.endsWith("chatter-init.ts") || entry.endsWith("chatter-init.js");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runWizard().catch((e) => {
    stdout.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
