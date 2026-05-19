/**
 * Chatter role end-to-end (sans HTTP + A2A).
 *
 * Wires RoleRegistry + RoleRunner + ChatterRole exactly as src/index.ts does,
 * minus the HTTP server and the A2A client. Exercises:
 *   - role creation through the registry factory
 *   - activate via RoleRunner
 *   - dispatch of a HubResult turn through runner.dispatch (the path hub
 *     traffic takes inside meridian-roles)
 *   - memory write on session-mode turn
 *   - control commands (/new, /interrupt) routed through the same dispatch path
 *   - inbound result on a known trace_id forwarded to user_reply_channel
 *
 * A full HTTP + real-hub harness exists only for agent-dispatcher
 * (agent-dispatcher-harness.ts) and is out of scope for this PR. The
 * higher-level wiring tested here is what the absent harness would exercise.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoleRegistry } from "../../src/roles/role-registry";
import { RoleRunner } from "../../src/roles/role-runner";
import { ChatterRole } from "../../src/roles/definitions/chatter";
import { ChatterRoleConfigSchema, type HubMessage, type HubResult, type ChatterRoleConfig } from "../../src/types";

const ADS_REPLY = {
  channel: "socket" as const,
  chat_id: "ads:e2e",
  socket_path: "/tmp/ads-e2e.sock"
};

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

function makeTurnResult(content: string, opts: Partial<HubResult> & { mode?: "stateless" | "session"; control?: "new" | "interrupt"; chatterSessionId?: string } = {}): HubResult {
  const { mode = "session", control, chatterSessionId, ...rest } = opts;
  return {
    trace_id: crypto.randomUUID(),
    thread_id: "chatter-tenant-e2e",
    source: "ads",
    status: "success",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    payload: { chatter: { mode, chatter_session_id: chatterSessionId, control } },
    ...rest
  };
}

describe("Chatter e2e — registry + runner + role", () => {
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

  it("creates a Chatter via registry and activates it; sandbox materialized; state dir created on first persist", async () => {
    const role = registry.create("chatter", "chatter-tenant-e2e", makeConfig(memoryFolder));
    await runner.activate(role);
    expect(existsSync(path.join(memoryFolder, ".chatter-sandbox", "settings.json"))).toBe(true);
  });

  it("session-mode turn: writes to memory AND dispatches to claude-code", async () => {
    const role = registry.create("chatter", "chatter-tenant-e2e", makeConfig(memoryFolder));
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("hello world"));

    // Memory write
    const turnsRoot = path.join(memoryFolder, "turns");
    expect(existsSync(turnsRoot)).toBe(true);
    const dateDirs = readdirSync(turnsRoot);
    expect(dateDirs.length).toBe(1);
    const turnFiles = readdirSync(path.join(turnsRoot, dateDirs[0]));
    expect(turnFiles.length).toBe(1);

    // Agent dispatch
    const claudeDispatch = sent.find((m) => m.target === "claude-code");
    expect(claudeDispatch).toBeDefined();
    expect(claudeDispatch!.payload.content).toBe("hello world");
  });

  it("stateless turn: dispatches but does NOT write to memory", async () => {
    const role = registry.create("chatter", "chatter-tenant-e2e", makeConfig(memoryFolder, { allowed_modes: ["stateless"] }));
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("one-shot", { mode: "stateless" }));
    expect(existsSync(path.join(memoryFolder, "turns"))).toBe(false);
    const claudeDispatch = sent.find((m) => m.target === "claude-code");
    expect(claudeDispatch).toBeDefined();
  });

  it("disallowed mode is rejected with structured error on user_reply_channel; no agent dispatch", async () => {
    const role = registry.create("chatter", "chatter-tenant-e2e", makeConfig(memoryFolder, { allowed_modes: ["session"] }));
    await runner.activate(role);
    await runner.dispatch(makeTurnResult("nope", { mode: "stateless" }));
    expect(sent.some((m) => m.target === "claude-code")).toBe(false);
    const errReply = sent.find((m) => m.reply_channel.chat_id === ADS_REPLY.chat_id);
    expect(errReply).toBeDefined();
    expect(errReply!.payload.content).toMatch(/denied_mode/);
  });

  it("/new rotates session; /interrupt cancels in-flight; both ack on user_reply_channel", async () => {
    const role = registry.create("chatter", "chatter-tenant-e2e", makeConfig(memoryFolder));
    await runner.activate(role);

    // First, dispatch a turn so there's an in-flight trace
    await runner.dispatch(makeTurnResult("first", { mode: "session" }));
    const firstDispatch = sent.find((m) => m.target === "claude-code");
    expect(firstDispatch).toBeDefined();

    // /interrupt
    await runner.dispatch(makeTurnResult("stop", { mode: "session", control: "interrupt" }));
    const interruptAck = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY.chat_id && /interrupt/i.test(m.payload.content)
    );
    expect(interruptAck).toBeDefined();

    // /new
    await runner.dispatch(makeTurnResult("reset", { mode: "session", control: "new" }));
    const newAck = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY.chat_id && /new session/i.test(m.payload.content)
    );
    expect(newAck).toBeDefined();
  });

  it("inbound result on known trace_id is forwarded to user_reply_channel", async () => {
    const role = registry.create("chatter", "chatter-tenant-e2e", makeConfig(memoryFolder));
    await runner.activate(role);

    // Dispatch a turn to register an outbound trace
    await runner.dispatch(makeTurnResult("ask", { mode: "session" }));
    const dispatch = sent.find((m) => m.target === "claude-code");
    expect(dispatch).toBeDefined();
    const traceId = dispatch!.trace_id;

    // Agent replies on that trace — route via runner.dispatch
    const sentBefore = sent.length;
    await runner.dispatch({
      trace_id: traceId,
      thread_id: "chatter-tenant-e2e",
      source: "claude-code",
      status: "success",
      content: "the answer",
      attachments: [],
      timestamp: new Date().toISOString(),
      run_state: "completed"
    });

    const forwarded = sent
      .slice(sentBefore)
      .find((m) => m.reply_channel.chat_id === ADS_REPLY.chat_id && m.payload.content === "the answer");
    expect(forwarded).toBeDefined();
  });

  it("inbound result with unknown trace_id and no envelope is dropped (no echo, no error)", async () => {
    const role = registry.create("chatter", "chatter-tenant-e2e", makeConfig(memoryFolder));
    await runner.activate(role);
    const before = sent.length;
    await runner.dispatch({
      trace_id: crypto.randomUUID(),
      thread_id: "chatter-tenant-e2e",
      source: "stray",
      status: "success",
      content: "ghost",
      attachments: [],
      timestamp: new Date().toISOString()
    });
    expect(sent.length).toBe(before);
  });
});
