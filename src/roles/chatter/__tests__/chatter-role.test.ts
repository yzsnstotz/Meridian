import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, realpathSync, readFileSync, existsSync } from "node:fs";
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

function makeHubResult(overrides: Partial<HubResult> & { content: string }): HubResult {
  return {
    trace_id: crypto.randomUUID(),
    thread_id: "chatter-tenant-a",
    source: "ads",
    status: "success",
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

describe("ChatterRole — activation", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
  });

  it("onActivate loads manifest, materializes sandbox, and starts a session manager", async () => {
    const { ctx } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root));
    await role.onActivate(ctx);
    expect(existsSync(path.join(root, ".chatter-sandbox", "settings.json"))).toBe(true);
    const settings = JSON.parse(readFileSync(path.join(root, ".chatter-sandbox", "settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Bash(*)");
  });
});

describe("ChatterRole — turn intake (session mode)", () => {
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

  it("forwards config.credential_id on the outbound agent run when set", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-cred-")));
    const { ctx, sent: localSent } = makeCtx();
    const role = new ChatterRole(
      "chatter-tenant-cred",
      makeConfig(root, { credential_id: "cred-1234" })
    );
    await role.onActivate(ctx);
    await role.onInboundResult(
      makeHubResult({ content: "hi", payload: { chatter: { mode: "session" } } })
    );
    const dispatch = localSent.find((m) => m.target === "claude-code");
    expect(dispatch).toBeDefined();
    expect(dispatch!.payload.credential_id).toBe("cred-1234");
  });

  it("omits credential_id from outbound when config does not set it", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-nocred-")));
    const { ctx, sent: localSent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-nocred", makeConfig(root));
    await role.onActivate(ctx);
    await role.onInboundResult(
      makeHubResult({ content: "hi", payload: { chatter: { mode: "session" } } })
    );
    const dispatch = localSent.find((m) => m.target === "claude-code");
    expect(dispatch).toBeDefined();
    expect(dispatch!.payload.credential_id).toBeUndefined();
  });

  it("dispatches the user content to the claude-code target via sendToHub", async () => {
    await role.onInboundResult(
      makeHubResult({ content: "hello chatter", payload: { chatter: { mode: "session" } } })
    );
    expect(sent.length).toBe(1);
    const msg = sent[0];
    expect(msg.intent).toBe("run");
    expect(msg.target).toBe("claude-code");
    expect(msg.payload.content).toBe("hello chatter");
    expect(msg.reply_channel.channel).toBe("socket");
  });

  it("writes the turn to memory in session mode", async () => {
    await role.onInboundResult(
      makeHubResult({ content: "remember this", payload: { chatter: { mode: "session" } } })
    );
    // Verify a file was written under turns/<date>/
    const turnsDir = path.join(root, "turns");
    expect(existsSync(turnsDir)).toBe(true);
  });

  it("rejects the turn when mode is not in allowed_modes", async () => {
    const sessionOnly = new ChatterRole(
      "chatter-tenant-a",
      makeConfig(root, { allowed_modes: ["session"], chatter_id: "tenant-b", memory_folder: root })
    );
    const { ctx, sent: localSent } = makeCtx();
    await sessionOnly.onActivate(ctx);
    await sessionOnly.onInboundResult(
      makeHubResult({ content: "x", payload: { chatter: { mode: "stateless" } } })
    );
    // No agent dispatch
    expect(localSent.filter((m) => m.target === "claude-code").length).toBe(0);
    // A reply went back to user_reply_channel with a denial
    const replyMsg = localSent.find((m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id);
    expect(replyMsg).toBeDefined();
    expect(replyMsg!.payload.content).toMatch(/denied_mode/);
  });
});

describe("ChatterRole — turn intake (stateless mode)", () => {
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

  it("dispatches but does NOT write to memory", async () => {
    await role.onInboundResult(
      makeHubResult({ content: "one-shot", payload: { chatter: { mode: "stateless" } } })
    );
    expect(sent.length).toBe(1);
    expect(existsSync(path.join(root, "turns"))).toBe(false);
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

  it("/new starts a new agent session and acknowledges", async () => {
    await role.onInboundResult(
      makeHubResult({ content: "x", payload: { chatter: { mode: "session", control: "new" } } })
    );
    // Should send an ack to user_reply_channel, no claude-code dispatch
    const claudeDispatches = sent.filter((m) => m.target === "claude-code");
    const acks = sent.filter((m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id);
    expect(claudeDispatches.length).toBe(0);
    expect(acks.length).toBe(1);
    expect(acks[0].payload.content).toMatch(/new session/i);
  });

  it("/interrupt clears in-flight and acknowledges", async () => {
    // First, dispatch a normal turn to put a trace in flight
    await role.onInboundResult(
      makeHubResult({ content: "do something", payload: { chatter: { mode: "session" } } })
    );
    expect(sent.length).toBe(1);
    // Now interrupt
    await role.onInboundResult(
      makeHubResult({ content: "stop", payload: { chatter: { mode: "session", control: "interrupt" } } })
    );
    const acks = sent.filter((m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id);
    expect(acks.length).toBe(1);
    expect(acks[0].payload.content).toMatch(/interrupt/i);
  });
});

describe("ChatterRole — inbound result forwarding", () => {
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

  it("forwards a result that matches a known in-flight trace_id to user_reply_channel", async () => {
    // Dispatch a turn to register a trace
    await role.onInboundResult(
      makeHubResult({ content: "ask", payload: { chatter: { mode: "session" } } })
    );
    const dispatched = sent[0];
    expect(dispatched.target).toBe("claude-code");
    const traceId = dispatched.trace_id;

    // Now the agent replies on that trace
    const agentReply = makeHubResult({
      trace_id: traceId,
      source: "claude-code",
      content: "the answer",
      run_state: "completed"
    });
    await role.onInboundResult(agentReply);

    const forwarded = sent.find(
      (m) => m.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id && m.payload.content === "the answer"
    );
    expect(forwarded).toBeDefined();
  });

  it("ignores a result with unknown trace_id and no envelope (no new turn, no echo)", async () => {
    const beforeCount = sent.length;
    await role.onInboundResult(
      makeHubResult({
        trace_id: crypto.randomUUID(),
        source: "unknown",
        content: "ghost"
        // no payload.chatter envelope, so this isn't a turn
      })
    );
    expect(sent.length).toBe(beforeCount);
  });
});

describe("ChatterRole — onDeactivate", () => {
  it("clears the ctx so subsequent inbound is a no-op", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-role-")));
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root));
    await role.onActivate(ctx);
    await role.onDeactivate();
    await role.onInboundResult(
      makeHubResult({ content: "x", payload: { chatter: { mode: "session" } } })
    );
    expect(sent.length).toBe(0);
  });
});
