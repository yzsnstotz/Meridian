import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../../types";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:mumu:test-user",
  socket_path: "/tmp/ads-mumu.sock"
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
    chatter_id: "mumu-test-user",
    memory_folder: memoryFolder,
    manifest_path: manifestPath,
    allowed_modes: ["stateless", "session"],
    skill_allowlist: ["structured.upsert", "structured.get", "structured.query", "structured.list"],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
  };
}

function makeTurnResult(content: string, overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: crypto.randomUUID(),
    thread_id: "chatter-mumu-test-user",
    source: "ads",
    status: "success",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
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

describe("BATCH-4-GATE mumu real-manifest dry run", () => {
  it("dispatches a create_from_template turn with Phase 2 sandbox roots and a real template context ref", async () => {
    const repoRoot = process.cwd();
    const memoryFolder = realpathSync(mkdtempSync(path.join(tmpdir(), "mumu-batch4-memory-")));
    const manifestDir = realpathSync(mkdtempSync(path.join(tmpdir(), "mumu-batch4-manifest-")));
    const liveManifestPath = path.join(repoRoot, "config/projects/mumu/manifest.json");
    const manifestPath = path.join(manifestDir, "manifest.json");
    const seedsRoot = path.join(repoRoot, "config/projects/mumu/seeds");
    const seedFile = "chongsheng-guilai.json";
    const manifest = JSON.parse(readFileSync(liveManifestPath, "utf8")) as {
      sandbox_roots?: unknown;
      system_prompts?: Record<string, { prompt_path: string }>;
    };
    manifest.sandbox_roots = [
      { root: memoryFolder, mode: "rw" },
      { root: seedsRoot, mode: "ro" }
    ];
    for (const prompt of Object.values(manifest.system_prompts ?? {})) {
      prompt.prompt_path = path.join(repoRoot, "config/projects/mumu", prompt.prompt_path);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-mumu-test-user", makeConfig(memoryFolder, manifestPath));
    await role.onActivate(ctx);

    expect(existsSync(path.join(memoryFolder, ".seeds_initialized"))).toBe(false);
    const seed = JSON.parse(
      readFileSync(path.join(seedsRoot, "templates/short_drama", seedFile), "utf8")
    ) as { id: string; title: string };
    const structuredDir = path.join(memoryFolder, "structured/template_short_drama");
    mkdirSync(structuredDir, { recursive: true });
    writeFileSync(path.join(structuredDir, `${seed.id}.json`), `${JSON.stringify(seed, null, 2)}\n`);

    await role.onInboundResult(
      makeTurnResult("请基于这个模版生成一个 12 集短剧大纲。", {
        payload: {
          chatter: {
            mode: "session",
            chatter_session_id: "ads-session-mumu-batch4",
            system_prompt_id: "create_from_template",
            context_refs: [{ type: "template_short_drama", key: seed.id }]
          }
        }
      })
    );

    const spawn = sent.find((m) => m.intent === "spawn");
    expect(spawn).toBeDefined();
    await driveSpawnResponse(role, spawn!, "claude_mumu_batch4");

    const run = sent.find((m) => m.intent === "run" && m.target === "claude_mumu_batch4");
    expect(run).toBeDefined();
    expect(run!.payload.content).toContain("## Pre-loaded context");
    expect(run!.payload.content).toContain(`"title": "${seed.title}"`);
    expect(run!.payload.content).toContain("# 创建剧本 (create_from_template)");
    expect(run!.payload.content).toContain("请基于这个模版生成一个 12 集短剧大纲。");
  });
});
