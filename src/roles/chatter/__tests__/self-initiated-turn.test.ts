import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import { ChatterStateStore } from "../chatter-state-store";
import {
  resetChatterSelfInitiatedTurnCountersForTests,
  snapshotChatterSelfInitiatedTurnErrorCounters,
  snapshotChatterSelfInitiatedTurnCounters
} from "../observability";
import {
  HubMessageSchema,
  HubResultSchema,
  type ChatterRoleConfig,
  type HubMessage,
  type HubResult,
  type ReplyChannel
} from "../../../types";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
};

const NOW = new Date("2026-05-21T00:10:00.000Z");

beforeEach(() => {
  resetChatterSelfInitiatedTurnCountersForTests();
});

describe("payload.chatter.origin schema symmetry", () => {
  it("preserves trigger origin through outbound HubMessage and inbound HubResult parsing", () => {
    const chatter = {
      mode: "session" as const,
      system_prompt_id: "style_observe",
      origin: "trigger" as const
    };

    const outbound = HubMessageSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "chatter-tenant-a",
      actor_id: "service:meridian-roles",
      intent: "run",
      target: "claude_07",
      payload: {
        content: "",
        attachments: [],
        chatter
      },
      mode: "bridge",
      reply_channel: ADS_REPLY_CHANNEL
    });
    expect(outbound.payload.chatter?.origin).toBe("trigger");

    const inbound = HubResultSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789012",
      thread_id: "chatter-tenant-a",
      source: "ads",
      status: "success",
      run_state: "completed",
      content: "",
      attachments: [],
      timestamp: "2026-05-21T00:00:00.000Z",
      payload: { chatter }
    });
    expect(inbound.payload?.chatter?.origin).toBe("trigger");

    const defaultedOutbound = HubMessageSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789013",
      thread_id: "chatter-tenant-a",
      actor_id: "service:meridian-roles",
      intent: "run",
      target: "claude_07",
      payload: {
        content: "user turn",
        attachments: [],
        chatter: { mode: "session" }
      },
      mode: "bridge",
      reply_channel: ADS_REPLY_CHANNEL
    });
    expect(defaultedOutbound.payload.chatter?.origin).toBe("user");

    const defaultedInbound = HubResultSchema.parse({
      trace_id: "12345678-1234-4234-8234-123456789013",
      thread_id: "chatter-tenant-a",
      source: "ads",
      status: "success",
      content: "user turn",
      attachments: [],
      timestamp: "2026-05-21T00:00:00.000Z",
      payload: { chatter: { mode: "session" } }
    });
    expect(defaultedInbound.payload?.chatter?.origin).toBe("user");
  });
});

describe("ChatterRole self-initiated trigger turns", () => {
  it("schedules a trigger-origin run on the existing agent session and replies to the user channel", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-self-trigger-")));
    const manifestPath = writeManifest(root, { minRecords: 1 });
    const logEntries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const { ctx, sent } = makeCtx({
      info(message, fields) {
        logEntries.push({
          message: String(message),
          fields: fields as Record<string, unknown>
        });
      }
    });
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => NOW
    });
    await role.onActivate(ctx);
    await bindAgentSession(role, sent, "claude_07");
    sent.length = 0;

    await role.handleAgentToolCall("structured.upsert", {
      type: "story_short_drama",
      key: "s1",
      record: { id: "s1" }
    });

    const run = sent.find((m) => m.intent === "run" && m.target === "claude_07");
    expect(run).toBeDefined();
    expect(run!.payload).toMatchObject({
      content: "",
      attachments: [],
      chatter: {
        origin: "trigger",
        system_prompt_id: "style_observe"
      }
    });
    expect(run!.reply_channel).toEqual(ADS_REPLY_CHANNEL);
    expect(snapshotChatterSelfInitiatedTurnCounters()).toEqual({
      style_observe_after_stories: 1
    });
    expect(logEntries).toContainEqual({
      message: "chatter: scheduled self-initiated turn",
      fields: expect.objectContaining({
        trigger_name: "style_observe_after_stories",
        origin: "trigger"
      })
    });
  });

  it("queues a trigger turn behind an active user turn and drains it FIFO", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-self-trigger-")));
    const manifestPath = writeManifest(root, { minRecords: 1 });
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => NOW
    });
    await role.onActivate(ctx);
    await bindAgentSession(role, sent, "claude_07");

    sent.length = 0;
    await role.onInboundResult(makeTurnResult("user turn", {
      payload: { chatter: { mode: "session" } }
    }));
    const userRun = sent.find((m) => m.intent === "run" && m.target === "claude_07")!;
    expect(userRun.payload.content).toBe("user turn");

    await role.handleAgentToolCall("structured.upsert", {
      type: "story_short_drama",
      key: "s1",
      record: { id: "s1" }
    });
    expect(sent.find((m) => m.payload.chatter?.origin === "trigger")).toBeUndefined();

    await role.onInboundResult(makeAgentReply(userRun, "user answer"));

    const triggerRun = sent.find((m) => m.payload.chatter?.origin === "trigger");
    expect(triggerRun).toBeDefined();
    expect(sent.indexOf(triggerRun!)).toBeGreaterThan(sent.indexOf(userRun));
  });

  it("records a failed trigger dispatch without retrying in the same throttle window", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-self-trigger-")));
    const manifestPath = writeManifest(root, { minRecords: 1, minInterval: "10m" });
    const sent: HubMessage[] = [];
    let selfInitiatedAttempts = 0;
    const ctx = makeRoleContext(sent, {
      sendToHub: async (msg) => {
        const message = msg as HubMessage;
        if (message.payload.chatter?.origin === "trigger") {
          selfInitiatedAttempts += 1;
          throw new Error("hub unavailable");
        }
        sent.push(message);
      }
    });
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => NOW
    });
    await role.onActivate(ctx);
    await bindAgentSession(role, sent, "claude_07");
    sent.length = 0;

    await role.handleAgentToolCall("structured.upsert", {
      type: "story_short_drama",
      key: "s1",
      record: { id: "s1" }
    });
    await role.handleAgentToolCall("structured.upsert", {
      type: "story_short_drama",
      key: "s2",
      record: { id: "s2" }
    });

    expect(selfInitiatedAttempts).toBe(1);
    expect(snapshotChatterSelfInitiatedTurnCounters()).toEqual({
      style_observe_after_stories: 1
    });
    expect(snapshotChatterSelfInitiatedTurnErrorCounters()).toEqual({
      style_observe_after_stories: 1
    });
    expect(new ChatterStateStore(root).load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 1,
      last_fire_at: NOW.toISOString()
    });
  });
});

function makeCtx(logOverrides: Partial<RoleContext["log"]> = {}) {
  const sent: HubMessage[] = [];
  return {
    sent,
    ctx: makeRoleContext(sent, { log: logOverrides })
  };
}

function makeRoleContext(
  sent: HubMessage[],
  overrides: {
    sendToHub?: (msg: Partial<HubMessage>) => Promise<void>;
    log?: Partial<RoleContext["log"]>;
  } = {}
): RoleContext {
  return {
    sendToHub: overrides.sendToHub ?? (async (msg) => {
      sent.push(msg as HubMessage);
    }),
    listInstances: async () => [],
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      ...overrides.log
    }
  };
}

function makeConfig(memoryFolder: string, manifestPath: string): ChatterRoleConfig {
  return {
    chatter_id: "tenant-a",
    memory_folder: memoryFolder,
    manifest_path: manifestPath,
    allowed_modes: ["stateless", "session"],
    skill_allowlist: ["structured.upsert"],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
  };
}

function makeTurnResult(content: string, overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: randomUUID(),
    thread_id: "chatter-tenant-a",
    source: "ads",
    status: "success",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

function makeAgentReply(run: HubMessage, content: string, overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: run.trace_id,
    thread_id: run.target,
    source: run.target,
    status: "success",
    run_state: "completed",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

async function bindAgentSession(
  role: ChatterRole,
  sent: HubMessage[],
  agentThreadId: string
): Promise<void> {
  await role.onInboundResult(makeTurnResult("start", {
    payload: { chatter: { mode: "session" } }
  }));
  const spawn = sent.find((m) => m.intent === "spawn")!;
  await role.onInboundResult({
    trace_id: spawn.trace_id,
    thread_id: agentThreadId,
    source: spawn.target,
    status: "success",
    content: `spawned ${agentThreadId}`,
    attachments: [],
    timestamp: new Date().toISOString()
  });
  const initialRun = sent.find((m) => m.intent === "run" && m.target === agentThreadId)!;
  await role.onInboundResult(makeAgentReply(initialRun, "ready"));
}

function writeManifest(root: string, options: {
  minRecords?: number;
  minInterval?: string;
} = {}): string {
  const promptsDir = path.join(root, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(path.join(promptsDir, "style_observe.md"), "observe style");

  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      record_schemas: {
        story_short_drama: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false
        }
      },
      system_prompts: {
        style_observe: { prompt_path: "prompts/style_observe.md" }
      },
      background_triggers: [{
        name: "style_observe_after_stories",
        fires_on: {
          type: "after_structured_upsert",
          record_type: "story_short_drama"
        },
        throttle: {
          min_records_since_last_fire: options.minRecords ?? 1,
          min_interval: options.minInterval ?? "10m"
        },
        action: { system_prompt_id: "style_observe" }
      }]
    })
  );
  return manifestPath;
}
