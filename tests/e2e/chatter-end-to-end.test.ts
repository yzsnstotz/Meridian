/**
 * Chatter role end-to-end (sans HTTP + A2A socket).
 *
 * Wires RoleRegistry + RoleRunner + ChatterRole exactly as src/index.ts does,
 * minus the HTTP server and the A2A client. Drives the full spawn-then-run
 * contract:
 *
 *   1. user turn arrives via runner.dispatch(HubResult with payload.chatter)
 *   2. ChatterRole emits intent:"spawn" with payload.credential_id
 *   3. test drives a synthetic spawn HubResult back through runner.dispatch
 *      (role-runner routes by trace_id via the BaseRole.claimsTrace contract
 *      since result.thread_id is the NEW agent thread, not chatter's)
 *   4. ChatterRole binds the agent session and flushes the queued turn via
 *      intent:"run" target = the agent's thread_id
 *   5. agent reply HubResult is forwarded to user_reply_channel
 *
 * The hub itself is replaced by a mock — but the contract surface
 * (sendToHub outbound + dispatch inbound + claimsTrace routing) is real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoleRegistry } from "../../src/roles/role-registry";
import { RoleRunner } from "../../src/roles/role-runner";
import { ChatterRole } from "../../src/roles/definitions/chatter";
import {
  ChatterRoleConfigSchema,
  type HubMessage,
  type HubResult,
  type ChatterRoleConfig
} from "../../src/types";

const ADS_REPLY = {
  channel: "socket" as const,
  chat_id: "ads:mumu:e2e",
  socket_path: "/tmp/ads-e2e.sock"
};

const CHATTER_THREAD_ID = "chatter-tenant-e2e";

function makeConfig(memoryFolder: string, overrides: Partial<ChatterRoleConfig> = {}): ChatterRoleConfig {
  return ChatterRoleConfigSchema.parse({
    chatter_id: "tenant-e2e",
    memory_folder: memoryFolder,
    template: "flat-log",
    allowed_modes: ["stateless", "session"],
    skill_allowlist: [],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY,
    ...overrides
  });
}

function makeTurnResult(
  content: string,
  opts: { mode?: "stateless" | "session"; control?: "new" | "interrupt" } = {}
): HubResult {
  const { mode = "session", control } = opts;
  return {
    trace_id: crypto.randomUUID(),
    thread_id: CHATTER_THREAD_ID,
    source: "ads",
    status: "success",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    payload: { chatter: { mode, control } }
  };
}

function makeSpawnResponse(spawnMsg: HubMessage, newThreadId: string): HubResult {
  return {
    trace_id: spawnMsg.trace_id,
    thread_id: newThreadId,
    source: spawnMsg.target,
    status: "success",
    content: `spawned ${newThreadId}`,
    attachments: [],
    timestamp: new Date().toISOString()
  };
}

function makeAgentReply(runMsg: HubMessage, content: string): HubResult {
  return {
    trace_id: runMsg.trace_id,
    thread_id: runMsg.target,
    source: "claude",
    status: "success",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    run_state: "completed"
  };
}

describe("Chatter e2e — full spawn-then-run contract via RoleRunner", () => {
  let memoryFolder: string;
  let registry: RoleRegistry;
  let runner: RoleRunner;
  let sent: HubMessage[];

  beforeEach(async () => {
    memoryFolder = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-e2e-")));
    registry = new RoleRegistry();
    registry.register("chatter", (threadId, config) =>
      new ChatterRole(threadId, ChatterRoleConfigSchema.parse(config))
    );
    sent = [];
    runner = new RoleRunner({
      sendToHub: async (msg) => {
        sent.push(msg as HubMessage);
      },
      listInstances: () => []
    });
  });

  afterEach(() => {
    rmSync(memoryFolder, { recursive: true, force: true });
  });

  it("activates a Chatter via registry; sandbox materialized; no spawn yet", async () => {
    const role = registry.create("chatter", CHATTER_THREAD_ID, makeConfig(memoryFolder));
    await runner.activate(role);
    expect(existsSync(path.join(memoryFolder, ".chatter-sandbox", "settings.json"))).toBe(true);
    expect(sent.length).toBe(0);
  });

  it("first session-mode turn writes memory and emits intent:spawn with credential_id", async () => {
    const role = registry.create(
      "chatter",
      CHATTER_THREAD_ID,
      makeConfig(memoryFolder, { credential_id: "cred-uuid-1" })
    );
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("hello"));

    // Memory write happened before spawn
    expect(existsSync(path.join(memoryFolder, "turns"))).toBe(true);
    const dateDirs = readdirSync(path.join(memoryFolder, "turns"));
    expect(dateDirs.length).toBe(1);

    // Outbound is a spawn with credential_id
    const spawn = sent.find((m) => m.intent === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn!.target).toBe("claude");
    expect(spawn!.payload.credential_id).toBe("cred-uuid-1");
    expect(spawn!.payload.spawn_dir).toBe(memoryFolder);
  });

  it("spawn response binds agent thread via claimsTrace; queued turn flushes to intent:run", async () => {
    const role = registry.create("chatter", CHATTER_THREAD_ID, makeConfig(memoryFolder));
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("ask"));
    const spawn = sent.find((m) => m.intent === "spawn")!;

    // The spawn response carries thread_id = the new agent (e.g. claude_07),
    // NOT chatter's thread_id. role-runner routes via claimsTrace.
    await runner.dispatch(makeSpawnResponse(spawn, "claude_07"));

    const run = sent.find((m) => m.intent === "run" && m.target === "claude_07");
    expect(run).toBeDefined();
    expect(run!.payload.content).toBe("ask");
  });

  it("agent reply on the run trace forwards only the MUMU user reply block", async () => {
    const role = registry.create("chatter", CHATTER_THREAD_ID, makeConfig(memoryFolder));
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("question?"));
    const spawn = sent.find((m) => m.intent === "spawn")!;
    await runner.dispatch(makeSpawnResponse(spawn, "claude_07"));
    const run = sent.find((m) => m.intent === "run" && m.target === "claude_07")!;

    await runner.dispatch(makeAgentReply(run,
      "internal structured/story_douyin/a.json notes\n"
        + "<<<MUMU-USER-REPLY>>>\n"
        + "这是给用户看的回答\n"
        + "<<<END-MUMU-USER-REPLY>>>"
    ));

    const forwarded = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY.chat_id && m.payload.content === "这是给用户看的回答"
    );
    expect(forwarded).toBeDefined();
    expect(forwarded!.payload.chatter?.reply_parse).toMatchObject({
      ok: true,
      status: "parsed",
      fallback_used: false
    });
    expect(JSON.stringify(forwarded)).not.toContain("structured/story_douyin");
  });

  it("agent reply on the run trace uses fallback for malformed raw output", async () => {
    const role = registry.create("chatter", CHATTER_THREAD_ID, makeConfig(memoryFolder));
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("question?"));
    const spawn = sent.find((m) => m.intent === "spawn")!;
    await runner.dispatch(makeSpawnResponse(spawn, "claude_07"));
    const run = sent.find((m) => m.intent === "run" && m.target === "claude_07")!;

    await runner.dispatch(makeAgentReply(run, "已写入 structured/story_douyin/a.json，JSON 校验通过"));

    const forwarded = sent.find((m) => m.reply_channel.chat_id === ADS_REPLY.chat_id);
    expect(forwarded).toBeDefined();
    expect(forwarded!.payload.content).toBe("已生成初稿，我把结构放在右侧。你可以继续让我展开、修改或换一个方向。");
    expect(forwarded!.payload.chatter?.reply_parse).toMatchObject({
      ok: false,
      status: "missing_markers",
      fallback_used: true
    });
    expect(JSON.stringify(forwarded)).not.toContain("structured/story_douyin");
    expect(JSON.stringify(forwarded)).not.toContain("JSON 校验");
  });

  it("stateless turn does NOT write memory but still spawns", async () => {
    const role = registry.create(
      "chatter",
      CHATTER_THREAD_ID,
      makeConfig(memoryFolder, { allowed_modes: ["stateless"] })
    );
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("one-shot", { mode: "stateless" }));
    expect(existsSync(path.join(memoryFolder, "turns"))).toBe(false);
    expect(sent.find((m) => m.intent === "spawn")).toBeDefined();
  });

  it("disallowed mode replies on user_reply_channel; no spawn", async () => {
    const role = registry.create(
      "chatter",
      CHATTER_THREAD_ID,
      makeConfig(memoryFolder, { allowed_modes: ["session"] })
    );
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("nope", { mode: "stateless" }));
    expect(sent.find((m) => m.intent === "spawn")).toBeUndefined();
    const err = sent.find((m) => m.reply_channel.chat_id === ADS_REPLY.chat_id);
    expect(err).toBeDefined();
    expect(err!.payload.content).toMatch(/denied_mode/);
  });

  it("/new after bind: sends intent:kill to old thread, unbinds, next turn re-spawns", async () => {
    const role = registry.create("chatter", CHATTER_THREAD_ID, makeConfig(memoryFolder));
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("first"));
    const spawn1 = sent.find((m) => m.intent === "spawn")!;
    await runner.dispatch(makeSpawnResponse(spawn1, "claude_07"));
    sent.length = 0;

    await runner.dispatch(makeTurnResult("reset", { control: "new" }));
    expect(sent.find((m) => m.intent === "kill" && m.target === "claude_07")).toBeDefined();

    // Next turn re-spawns
    await runner.dispatch(makeTurnResult("after reset"));
    const spawn2 = sent.find((m) => m.intent === "spawn");
    expect(spawn2).toBeDefined();
  });

  it("inbound HubResult without envelope + unknown trace is dropped silently", async () => {
    const role = registry.create("chatter", CHATTER_THREAD_ID, makeConfig(memoryFolder));
    await runner.activate(role);
    const before = sent.length;
    await runner.dispatch({
      trace_id: crypto.randomUUID(),
      thread_id: CHATTER_THREAD_ID,
      source: "stray",
      status: "success",
      content: "ghost",
      attachments: [],
      timestamp: new Date().toISOString()
    });
    expect(sent.length).toBe(before);
  });
});
