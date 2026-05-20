import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import { ChatterStateStore } from "../chatter-state-store";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../../types";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
};

describe("BATCH-3-GATE background trigger synthetic fixture", () => {
  it("runs the RC-2 throttle to candidate observation confirmation sequence", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-batch3-gate-")));
    const manifestPath = writeManifest(root, { minRecords: 3, minInterval: "1s" });
    writeStructuredRecord(root, "style_short_drama", "u_001", {
      id: "u_001",
      voice: "fast hooks",
      agent_observed: {
        recurring_motifs: ["family reversal"]
      }
    });

    let now = new Date("2026-05-21T00:00:00.000Z");
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => now
    });
    await role.onActivate(ctx);
    await bindAgentSession(role, sent, "claude_07");
    sent.length = 0;

    await role.handleAgentToolCall("structured.upsert", storyRecord("s1"));
    await role.handleAgentToolCall("structured.upsert", storyRecord("s2"));
    expect(triggerRuns(sent)).toEqual([]);

    await role.handleAgentToolCall("structured.upsert", storyRecord("s3"));
    const firstRun = latestTriggerRun(sent);
    expect(firstRun.payload.chatter).toMatchObject({
      origin: "trigger",
      system_prompt_id: "style_observe"
    });
    expect(new ChatterStateStore(root).load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 0,
      last_fire_at: "2026-05-21T00:00:00.000Z"
    });

    sent.length = 0;
    const suggestion = await role.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "User keeps rewarding sharp reversals.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: "u_001",
        patch: {
          agent_observed: {
            recurring_motifs: ["sharp reversal"]
          }
        }
      }
    });
    const observationId = (suggestion as { observation_id: string }).observation_id;
    expect(latestAdsReply(sent).payload.chatter?.candidate_observation).toMatchObject({
      observation_id: observationId,
      type: "style_short_drama"
    });
    expect(new ChatterStateStore(root).load().observations?.[observationId]).toBeDefined();

    const restartedCtx = makeCtx();
    const restarted = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => new Date("2026-05-21T00:00:00.500Z")
    });
    await restarted.onActivate(restartedCtx.ctx);
    await restarted.onInboundResult(makeControlResult("confirm_observation", observationId));

    expect(readStructuredRecord(root, "style_short_drama", "u_001")).toMatchObject({
      id: "u_001",
      voice: "fast hooks",
      agent_observed: {
        recurring_motifs: ["family reversal", "sharp reversal"],
        confirmed_at: "2026-05-21T00:00:00.500Z"
      }
    });
    expect(new ChatterStateStore(root).load().observations?.[observationId]).toBeUndefined();
    expect(latestAdsReply(restartedCtx.sent).payload.content).toContain("observation_confirmed");

    restartedCtx.sent.length = 0;
    await restarted.onInboundResult(makeControlResult("confirm_observation", observationId));
    expect(latestAdsReply(restartedCtx.sent).payload.content).toContain("observation_expired_or_unknown");

    restartedCtx.sent.length = 0;
    const rejectSuggestion = await restarted.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "Reject this one.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: "u_001",
        patch: {
          agent_observed: {
            recurring_motifs: ["slow burn"]
          }
        }
      }
    });
    const rejectId = (rejectSuggestion as { observation_id: string }).observation_id;
    await restarted.onInboundResult(makeControlResult("reject_observation", rejectId));
    expect(readStructuredRecord(root, "style_short_drama", "u_001")).toMatchObject({
      agent_observed: {
        recurring_motifs: ["family reversal", "sharp reversal"]
      }
    });
    expect(new ChatterStateStore(root).load().observations?.[rejectId]).toBeUndefined();

    restartedCtx.sent.length = 0;
    await restarted.handleAgentToolCall("structured.upsert", storyRecord("s4"));
    await restarted.handleAgentToolCall("structured.upsert", storyRecord("s5"));
    await restarted.handleAgentToolCall("structured.upsert", storyRecord("s6"));
    expect(triggerRuns(restartedCtx.sent)).toEqual([]);
    expect(new ChatterStateStore(root).load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 3,
      last_fire_at: "2026-05-21T00:00:00.000Z"
    });

    now = new Date("2026-05-21T00:00:01.001Z");
    const secondWindowCtx = makeCtx();
    const secondWindow = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => now
    });
    await secondWindow.onActivate(secondWindowCtx.ctx);

    await secondWindow.handleAgentToolCall("structured.upsert", storyRecord("s7"));
    expect(triggerRuns(secondWindowCtx.sent)).toHaveLength(1);
    expect(new ChatterStateStore(root).load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 0,
      last_fire_at: "2026-05-21T00:00:01.001Z"
    });
  });
});

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
    skill_allowlist: ["structured.upsert", "chatter.suggest_observation"],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
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

function makeAgentReply(run: HubMessage, content: string): HubResult {
  return {
    trace_id: run.trace_id,
    thread_id: run.target,
    source: run.target,
    status: "success",
    run_state: "completed",
    content,
    attachments: [],
    timestamp: new Date().toISOString()
  };
}

function makeControlResult(control: "confirm_observation" | "reject_observation", observationId: string): HubResult {
  return {
    trace_id: randomUUID(),
    thread_id: "chatter-tenant-a",
    source: "ads",
    status: "success",
    content: "",
    attachments: [],
    timestamp: new Date().toISOString(),
    payload: {
      chatter: {
        control,
        observation_id: observationId
      } as NonNullable<NonNullable<HubResult["payload"]>["chatter"]>
    }
  };
}

function latestAdsReply(sent: HubMessage[]): HubMessage {
  const reply = sent.filter((msg) => msg.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id).at(-1);
  expect(reply).toBeDefined();
  return reply!;
}

function triggerRuns(sent: HubMessage[]): HubMessage[] {
  return sent.filter((msg) => msg.intent === "run" && msg.payload.chatter?.origin === "trigger");
}

function latestTriggerRun(sent: HubMessage[]): HubMessage {
  const run = triggerRuns(sent).at(-1);
  expect(run).toBeDefined();
  return run!;
}

function storyRecord(id: string) {
  return {
    type: "story_short_drama",
    key: id,
    record: { id }
  };
}

function writeManifest(root: string, options: {
  minRecords: number;
  minInterval: string;
}): string {
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
        },
        style_short_drama: {
          type: "object",
          properties: {
            id: { type: "string" },
            voice: { type: "string" },
            agent_observed: {
              type: "object",
              properties: {
                recurring_motifs: {
                  type: "array",
                  items: { type: "string" }
                },
                confirmed_at: { type: "string" }
              },
              additionalProperties: false
            }
          },
          required: ["id", "voice"],
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
          min_records_since_last_fire: options.minRecords,
          min_interval: options.minInterval
        },
        action: { system_prompt_id: "style_observe" }
      }]
    })
  );
  return manifestPath;
}

function writeStructuredRecord(root: string, type: string, key: string, record: unknown): void {
  const dir = path.join(root, "structured", type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${key}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

function readStructuredRecord(root: string, type: string, key: string): unknown {
  const filePath = path.join(root, "structured", type, `${key}.json`);
  expect(existsSync(filePath)).toBe(true);
  return JSON.parse(readFileSync(filePath, "utf8"));
}
