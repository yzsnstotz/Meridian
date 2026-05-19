import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatterRole } from "../../definitions/chatter";
import type { HubMessage, HubResult, ChatterRoleConfig, ReplyChannel } from "../../../types";
import type { RoleContext } from "../../base-role";

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

function makeConfig(memoryFolder: string, overrides: Partial<ChatterRoleConfig> = {}): ChatterRoleConfig {
  return {
    chatter_id: "tenant-a",
    memory_folder: memoryFolder,
    template: "flat-log",
    allowed_modes: ["stateless", "session"],
    skill_allowlist: [],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL,
    ...overrides
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

async function driveSpawnResponse(
  role: ChatterRole,
  spawnMsg: HubMessage,
  newAgentThreadId: string,
  overrides: Partial<HubResult> = {}
): Promise<void> {
  const response: HubResult = {
    trace_id: spawnMsg.trace_id,
    thread_id: newAgentThreadId,
    source: spawnMsg.target,
    status: "success",
    content: `spawned ${newAgentThreadId}`,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
  await role.onInboundResult(response);
}

describe("ChatterRole — activation + spawn handshake", () => {
  let root: string;
  let role: ChatterRole;
  let sent: HubMessage[];

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
    const made = makeCtx();
    sent = made.sent;
    role = new ChatterRole("chatter-tenant-a", makeConfig(root));
    await role.onActivate(made.ctx);
  });

  it("onActivate materializes sandbox but does NOT spawn", () => {
    expect(existsSync(path.join(root, ".chatter-sandbox", "settings.json"))).toBe(true);
    expect(sent.length).toBe(0);
  });

  it("first user turn kicks off intent:'spawn' to mapped agent_type (claude)", async () => {
    await role.onInboundResult(
      makeTurnResult("hi", { payload: { chatter: { mode: "session" } } })
    );
    const spawnMsgs = sent.filter((m) => m.intent === "spawn");
    expect(spawnMsgs.length).toBe(1);
    expect(spawnMsgs[0].target).toBe("claude");
  });

  it("spawn payload carries spawn_dir and credential_id when configured", async () => {
    const root2 = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-cred-")));
    const made = makeCtx();
    const roleCred = new ChatterRole(
      "chatter-tenant-cred",
      makeConfig(root2, { credential_id: "cred-uuid-1" })
    );
    await roleCred.onActivate(made.ctx);
    await roleCred.onInboundResult(
      makeTurnResult("hi", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = made.sent.find((m) => m.intent === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn!.payload.spawn_dir).toBe(root2);
    expect(spawn!.payload.credential_id).toBe("cred-uuid-1");
  });

  it("spawn payload omits credential_id when config does not set one", async () => {
    await role.onInboundResult(
      makeTurnResult("hi", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn!.payload.credential_id).toBeUndefined();
  });

  it("second turn during pending spawn is queued, not double-spawned", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    await role.onInboundResult(
      makeTurnResult("second", { payload: { chatter: { mode: "session" } } })
    );
    const spawnMsgs = sent.filter((m) => m.intent === "spawn");
    expect(spawnMsgs.length).toBe(1);
    const runMsgs = sent.filter((m) => m.intent === "run" && m.target !== "global");
    expect(runMsgs.length).toBe(0);
  });

  it("spawn response binds the agent thread and flushes queued turns in FIFO", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    await role.onInboundResult(
      makeTurnResult("second", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn")!;

    await driveSpawnResponse(role, spawn, "claude_07");

    const runs = sent.filter((m) => m.intent === "run" && m.target === "claude_07");
    expect(runs.length).toBe(2);
    expect(runs[0].payload.content).toBe("first");
    expect(runs[1].payload.content).toBe("second");
  });

  it("run dispatches DO NOT carry credential_id (credential is consumed at spawn)", async () => {
    const root2 = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-cred-")));
    const made = makeCtx();
    const roleCred = new ChatterRole(
      "chatter-tenant-cred",
      makeConfig(root2, { credential_id: "cred-uuid-1" })
    );
    await roleCred.onActivate(made.ctx);
    await roleCred.onInboundResult(
      makeTurnResult("hi", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = made.sent.find((m) => m.intent === "spawn")!;
    await driveSpawnResponse(roleCred, spawn, "claude_07");
    const run = made.sent.find((m) => m.intent === "run" && m.target === "claude_07")!;
    expect(run.payload.credential_id).toBeUndefined();
  });

  it("post-bind turns dispatch immediately via intent:'run' (no new spawn)", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn")!;
    await driveSpawnResponse(role, spawn, "claude_07");

    sent.length = 0;
    await role.onInboundResult(
      makeTurnResult("next", { payload: { chatter: { mode: "session" } } })
    );
    expect(sent.filter((m) => m.intent === "spawn").length).toBe(0);
    const run = sent.find((m) => m.intent === "run" && m.target === "claude_07");
    expect(run).toBeDefined();
    expect(run!.payload.content).toBe("next");
  });
});

describe("ChatterRole — session-mode memory + stateless behavior", () => {
  let root: string;
  let role: ChatterRole;
  let sent: HubMessage[];

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
    const made = makeCtx();
    sent = made.sent;
    role = new ChatterRole("chatter-tenant-a", makeConfig(root));
    await role.onActivate(made.ctx);
  });

  it("session-mode turn writes memory BEFORE the spawn handshake fires", async () => {
    await role.onInboundResult(
      makeTurnResult("remember this", { payload: { chatter: { mode: "session" } } })
    );
    expect(existsSync(path.join(root, "turns"))).toBe(true);
    const dateDirs = readdirSync(path.join(root, "turns"));
    expect(dateDirs.length).toBe(1);
  });

  it("stateless-mode turn does NOT write memory but still spawns", async () => {
    await role.onInboundResult(
      makeTurnResult("one-shot", { payload: { chatter: { mode: "stateless" } } })
    );
    expect(existsSync(path.join(root, "turns"))).toBe(false);
    expect(sent.find((m) => m.intent === "spawn")).toBeDefined();
  });
});

describe("ChatterRole — mode policy gate", () => {
  it("disallowed mode replies with denied_mode and does NOT spawn", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole(
      "chatter-tenant-a",
      makeConfig(root, { allowed_modes: ["session"] })
    );
    await role.onActivate(ctx);
    await role.onInboundResult(
      makeTurnResult("nope", { payload: { chatter: { mode: "stateless" } } })
    );
    expect(sent.find((m) => m.intent === "spawn")).toBeUndefined();
    const errReply = sent.find((m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id);
    expect(errReply).toBeDefined();
    expect(errReply!.payload.content).toMatch(/denied_mode/);
  });
});

describe("ChatterRole — control commands", () => {
  let root: string;
  let role: ChatterRole;
  let sent: HubMessage[];

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
    const made = makeCtx();
    sent = made.sent;
    role = new ChatterRole("chatter-tenant-a", makeConfig(root));
    await role.onActivate(made.ctx);
  });

  it("/new with bound session: sends kill to old thread, unbinds, acks", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn")!;
    await driveSpawnResponse(role, spawn, "claude_07");
    sent.length = 0;

    await role.onInboundResult(
      makeTurnResult("reset", { payload: { chatter: { mode: "session", control: "new" } } })
    );

    const kill = sent.find((m) => m.intent === "kill" && m.target === "claude_07");
    expect(kill).toBeDefined();
    const ack = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id && /new session pending/i.test(m.payload.content)
    );
    expect(ack).toBeDefined();
  });

  it("/new during pending spawn is rejected (no state change)", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    const before = sent.length;
    await role.onInboundResult(
      makeTurnResult("rotate", { payload: { chatter: { mode: "session", control: "new" } } })
    );
    expect(sent.find((m) => m.intent === "kill")).toBeUndefined();
    const replies = sent.slice(before).filter((m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].payload.content).toMatch(/cannot rotate session/);
  });

  it("/new before any spawn: unbinds, no kill, acks", async () => {
    await role.onInboundResult(
      makeTurnResult("reset", { payload: { chatter: { mode: "session", control: "new" } } })
    );
    expect(sent.find((m) => m.intent === "kill")).toBeUndefined();
    expect(sent.find((m) => m.intent === "spawn")).toBeUndefined();
    const ack = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id && /new session pending/i.test(m.payload.content)
    );
    expect(ack).toBeDefined();
  });

  it("/interrupt cancels pending spawn + clears in-flight + acks", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    const before = sent.length;
    await role.onInboundResult(
      makeTurnResult("stop", { payload: { chatter: { mode: "session", control: "interrupt" } } })
    );
    const ack = sent.slice(before).find(
      (m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id && /interrupt/i.test(m.payload.content)
    );
    expect(ack).toBeDefined();
  });

  it("/interrupt drops late spawn responses (unknown trace path)", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn")!;
    await role.onInboundResult(
      makeTurnResult("stop", { payload: { chatter: { mode: "session", control: "interrupt" } } })
    );
    const sentBeforeLate = sent.length;
    await driveSpawnResponse(role, spawn, "claude_07");
    const newRuns = sent.slice(sentBeforeLate).filter((m) => m.intent === "run" && m.target === "claude_07");
    expect(newRuns.length).toBe(0);
  });
});

describe("ChatterRole — claimsTrace + inbound forwarding", () => {
  let root: string;
  let role: ChatterRole;
  let sent: HubMessage[];

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
    const made = makeCtx();
    sent = made.sent;
    role = new ChatterRole("chatter-tenant-a", makeConfig(root));
    await role.onActivate(made.ctx);
  });

  it("claimsTrace returns true for in-flight, false otherwise", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn")!;
    expect(role.claimsTrace(spawn.trace_id)).toBe(true);
    expect(role.claimsTrace(crypto.randomUUID())).toBe(false);
  });

  it("agent reply on known run trace forwards content to user_reply_channel", async () => {
    await role.onInboundResult(
      makeTurnResult("ask", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn")!;
    await driveSpawnResponse(role, spawn, "claude_07");
    const run = sent.find((m) => m.intent === "run" && m.target === "claude_07")!;

    const agentReply: HubResult = {
      trace_id: run.trace_id,
      thread_id: "claude_07",
      source: "claude",
      status: "success",
      content: "the answer",
      attachments: [],
      timestamp: new Date().toISOString(),
      run_state: "completed"
    };
    await role.onInboundResult(agentReply);

    const forwarded = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id && m.payload.content === "the answer"
    );
    expect(forwarded).toBeDefined();
  });

  it("unknown trace + no envelope is dropped silently", async () => {
    const before = sent.length;
    await role.onInboundResult({
      trace_id: crypto.randomUUID(),
      thread_id: "some-other-thread",
      source: "stray",
      status: "success",
      content: "ghost",
      attachments: [],
      timestamp: new Date().toISOString()
    });
    expect(sent.length).toBe(before);
  });

  it("spawn error (status:'error') triggers error reply to user", async () => {
    await role.onInboundResult(
      makeTurnResult("first", { payload: { chatter: { mode: "session" } } })
    );
    const spawn = sent.find((m) => m.intent === "spawn")!;
    const errorResponse: HubResult = {
      trace_id: spawn.trace_id,
      thread_id: "n/a",
      source: spawn.target,
      status: "error",
      content: "credential_not_found",
      attachments: [],
      timestamp: new Date().toISOString()
    };
    await role.onInboundResult(errorResponse);
    const errReply = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id && /spawn failed/.test(m.payload.content)
    );
    expect(errReply).toBeDefined();
  });
});

describe("ChatterRole — onDeactivate", () => {
  it("clears ctx so subsequent inbound is a no-op", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root));
    await role.onActivate(ctx);
    await role.onDeactivate();
    await role.onInboundResult(
      makeTurnResult("x", { payload: { chatter: { mode: "session" } } })
    );
    expect(sent.length).toBe(0);
  });
});
