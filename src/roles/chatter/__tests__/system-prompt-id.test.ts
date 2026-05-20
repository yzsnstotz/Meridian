import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatterRole } from "../../definitions/chatter";
import { loadManifestFromFile } from "../manifest";
import type { RoleContext } from "../../base-role";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../../types";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
};

function makeCtx() {
  const sent: HubMessage[] = [];
  const ctx: RoleContext = {
    sendToHub: async (msg) => {
      sent.push(msg as HubMessage);
    },
    listInstances: async () => [],
    log: { debug() {}, info() {}, warn() {}, error() {} }
  };
  return { ctx, sent };
}

function makeConfig(memoryFolder: string, manifestPath: string): ChatterRoleConfig {
  return {
    chatter_id: "tenant-a",
    memory_folder: memoryFolder,
    manifest_path: manifestPath,
    allowed_modes: ["stateless", "session"],
    skill_allowlist: [],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
  };
}

function makeTurnResult(content: string, overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: crypto.randomUUID(),
    thread_id: "chatter-tenant-a",
    source: "ads",
    status: "success",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

function writeManifestWithPrompt(root: string, promptText = "Create prompt text"): string {
  const promptsDir = path.join(root, "prompts");
  const manifestPath = path.join(root, "manifest.json");
  mkdirSync(promptsDir);
  writeFileSync(path.join(promptsDir, "create_from_template.md"), promptText);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: { conversation_log: "turns/<turn_id>.md" },
      system_prompts: {
        create_from_template: { prompt_path: "prompts/create_from_template.md" }
      }
    })
  );
  return manifestPath;
}

async function driveSpawnResponse(role: ChatterRole, spawnMsg: HubMessage, newAgentThreadId: string): Promise<void> {
  await role.onInboundResult({
    trace_id: spawnMsg.trace_id,
    thread_id: newAgentThreadId,
    source: spawnMsg.target,
    status: "success",
    content: `spawned ${newAgentThreadId}`,
    attachments: [],
    timestamp: new Date().toISOString()
  });
}

describe("Chatter manifest system_prompts", () => {
  it("loads prompt files relative to the manifest and caches content by id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-system-prompts-"));
    const promptsDir = path.join(dir, "prompts");
    const manifestPath = path.join(dir, "manifest.json");
    const promptPath = path.join(promptsDir, "create_from_template.md");
    mkdirSync(promptsDir);
    writeFileSync(promptPath, "Create prompt text");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: "turns/<turn_id>.md" },
        system_prompts: {
          create_from_template: { prompt_path: "prompts/create_from_template.md" }
        }
      })
    );

    const manifest = loadManifestFromFile(manifestPath);

    expect(manifest.systemPromptContents?.get("create_from_template")).toBe("Create prompt text");
  });

  it("rejects manifests whose declared prompt file is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-system-prompts-"));
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: "turns/<turn_id>.md" },
        system_prompts: {
          create_from_template: { prompt_path: "prompts/missing.md" }
        }
      })
    );

    expect(() => loadManifestFromFile(manifestPath)).toThrow(/ENOENT/);
  });
});

describe("ChatterRole payload.chatter.system_prompt_id", () => {
  it("injects a declared system prompt for one turn and does not persist it to the next turn", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-system-prompt-role-")));
    const manifestPath = writeManifestWithPrompt(root, "SYSTEM: create-from-template instructions");
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(ctx);

    await role.onInboundResult(makeTurnResult("first user turn", {
      payload: {
        chatter: {
          mode: "session",
          chatter_session_id: "ads-session-1",
          system_prompt_id: "create_from_template"
        }
      }
    }));
    const spawn = sent.find((m) => m.intent === "spawn")!;
    await driveSpawnResponse(role, spawn, "claude_07");

    const firstRun = sent.find((m) => m.intent === "run" && m.target === "claude_07")!;
    expect(firstRun.payload.content).toContain("SYSTEM: create-from-template instructions");
    expect(firstRun.payload.content).toContain("first user turn");

    sent.length = 0;
    await role.onInboundResult(makeTurnResult("second user turn", {
      payload: { chatter: { mode: "session", chatter_session_id: "ads-session-1" } }
    }));

    const secondRun = sent.find((m) => m.intent === "run" && m.target === "claude_07")!;
    expect(secondRun.payload.content).toBe("second user turn");
  });

  it("replies with unknown_system_prompt_id and does not spawn for an unknown id", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-system-prompt-role-")));
    const manifestPath = writeManifestWithPrompt(root);
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(ctx);

    await role.onInboundResult(makeTurnResult("first user turn", {
      payload: {
        chatter: {
          mode: "session",
          chatter_session_id: "ads-session-1",
          system_prompt_id: "missing_prompt"
        }
      }
    }));

    expect(sent.find((m) => m.intent === "spawn")).toBeUndefined();
    const errorReply = sent.find((m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id);
    expect(errorReply).toBeDefined();
    expect(errorReply!.payload.content).toBe("error: unknown_system_prompt_id: missing_prompt");
  });
});
