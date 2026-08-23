import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import { ChatterStateStore } from "../chatter-state-store";
import {
  HubPayloadSchema,
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

const NOW = new Date("2026-05-21T00:00:00.000Z");

describe("candidate_observation schemas", () => {
  it("preserves candidate_observation, observation_id, and observation controls both ways", () => {
    const observationId = "12345678-1234-4234-8234-123456789012";
    const candidate = {
      observation_id: observationId,
      type: "style_short_drama",
      description: "User favors sharp reversals.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: "u_001",
        patch: {
          agent_observed: {
            recurring_motifs: ["sharp reversal"]
          }
        }
      }
    };

    const outbound = HubPayloadSchema.parse({
      content: "",
      attachments: [],
      chatter: {
        candidate_observation: candidate,
        observation_id: observationId,
        control: "confirm_observation"
      }
    });
    expect(outbound.chatter?.candidate_observation).toEqual(candidate);
    expect(outbound.chatter?.observation_id).toBe(observationId);
    expect(outbound.chatter?.control).toBe("confirm_observation");

    const inbound = HubResultSchema.parse({
      trace_id: randomUUID(),
      thread_id: "chatter-tenant-a",
      source: "ads",
      status: "success",
      content: "",
      attachments: [],
      timestamp: NOW.toISOString(),
      payload: {
        chatter: {
          candidate_observation: candidate,
          observation_id: observationId,
          control: "reject_observation"
        }
      }
    });
    expect(inbound.payload?.chatter?.candidate_observation).toEqual(candidate);
    expect(inbound.payload?.chatter?.observation_id).toBe(observationId);
    expect(inbound.payload?.chatter?.control).toBe("reject_observation");

    const existingControl = HubPayloadSchema.parse({
      content: "",
      attachments: [],
      chatter: { mode: "session", control: "new" }
    });
    expect(existingControl.chatter?.control).toBe("new");
  });
});

describe("ChatterRole candidate observations", () => {
  it("emits and persists candidate observations from the built-in tool", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-candidate-")));
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, writeManifest(root)), {
      now: () => NOW
    });
    await role.onActivate(ctx);

    const result = await role.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "User favors sharp reversals.",
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

    expect(result).toEqual({ ok: true, observation_id: expect.any(String) });
    const observationId = (result as { observation_id: string }).observation_id;
    expect(observationId).toMatch(/^[0-9a-f-]{36}$/);

    const reply = latestAdsReply(sent);
    expect(reply.payload.chatter?.candidate_observation).toEqual({
      observation_id: observationId,
      type: "style_short_drama",
      description: "User favors sharp reversals.",
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
    expect(new ChatterStateStore(root).load().observations?.[observationId]).toMatchObject({
      proposed_patch: {
        record_type: "style_short_drama",
        key: "u_001"
      },
      created_at: NOW.toISOString()
    });
  });

  it("confirms a restarted cached observation by deep-merging the proposed patch", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-candidate-confirm-")));
    const manifestPath = writeManifest(root);
    writeStructuredRecord(root, {
      id: "u_001",
      voice: "fast hooks",
      agent_observed: {
        recurring_motifs: ["family reversal"]
      }
    });

    const first = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => NOW
    });
    const firstCtx = makeCtx();
    await first.onActivate(firstCtx.ctx);
    const suggestion = await first.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "A second motif emerged.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: "u_001",
        patch: {
          agent_observed: {
            recurring_motifs: ["mistaken identity"]
          }
        }
      }
    });
    const observationId = (suggestion as { observation_id: string }).observation_id;

    const secondCtx = makeCtx();
    const restarted = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => new Date("2026-05-21T00:02:00.000Z")
    });
    await restarted.onActivate(secondCtx.ctx);
    await restarted.onInboundResult(makeControlResult("confirm_observation", observationId));

    const record = readStructuredRecord(root);
    expect(record).toMatchObject({
      id: "u_001",
      voice: "fast hooks",
      agent_observed: {
        recurring_motifs: ["family reversal", "mistaken identity"],
        confirmed_at: "2026-05-21T00:02:00.000Z"
      }
    });
    expect(new ChatterStateStore(root).load().observations?.[observationId]).toBeUndefined();
    expect(latestAdsReply(secondCtx.sent).payload.content).toContain("observation_confirmed");
  });

  it("rejects a cached observation without writing and evicts it", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-candidate-reject-")));
    const manifestPath = writeManifest(root);
    writeStructuredRecord(root, {
      id: "u_001",
      voice: "fast hooks",
      agent_observed: {
        recurring_motifs: ["family reversal"]
      }
    });
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => NOW
    });
    await role.onActivate(ctx);
    const suggestion = await role.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "Reject me.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: "u_001",
        patch: {
          agent_observed: {
            recurring_motifs: ["mistaken identity"]
          }
        }
      }
    });
    const observationId = (suggestion as { observation_id: string }).observation_id;
    sent.length = 0;

    await role.onInboundResult(makeControlResult("reject_observation", observationId));

    expect(readStructuredRecord(root)).toMatchObject({
      agent_observed: {
        recurring_motifs: ["family reversal"]
      }
    });
    expect(new ChatterStateStore(root).load().observations?.[observationId]).toBeUndefined();
    expect(latestAdsReply(sent).payload.content).toContain("observation_rejected");
  });

  it("evicts expired observations from memory and persisted state", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-candidate-expired-")));
    const manifestPath = writeManifest(root);
    writeStructuredRecord(root, { id: "u_001", voice: "fast hooks" });
    const firstCtx = makeCtx();
    const first = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => NOW
    });
    await first.onActivate(firstCtx.ctx);
    const suggestion = await first.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "Old observation.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: "u_001",
        patch: {
          agent_observed: {
            recurring_motifs: ["old motif"]
          }
        }
      }
    });
    const observationId = (suggestion as { observation_id: string }).observation_id;

    const expiredCtx = makeCtx();
    const expiredRole = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      now: () => new Date("2026-05-29T00:00:00.000Z")
    });
    await expiredRole.onActivate(expiredCtx.ctx);
    await expiredRole.onInboundResult(makeControlResult("confirm_observation", observationId));

    expect(readStructuredRecord(root)).toEqual({ id: "u_001", voice: "fast hooks" });
    expect(new ChatterStateStore(root).load().observations?.[observationId]).toBeUndefined();
    expect(latestAdsReply(expiredCtx.sent).payload.content).toContain("observation_expired_or_unknown");
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
    skill_allowlist: [],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
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
    timestamp: NOW.toISOString(),
    payload: {
      chatter: {
        control,
        observation_id: observationId
      } as unknown as NonNullable<NonNullable<HubResult["payload"]>["chatter"]>
    }
  };
}

function latestAdsReply(sent: HubMessage[]): HubMessage {
  const reply = sent.filter((msg) => msg.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id).at(-1);
  expect(reply).toBeDefined();
  return reply!;
}

function writeManifest(root: string): string {
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      record_schemas: {
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
      }
    })
  );
  return manifestPath;
}

function writeStructuredRecord(root: string, record: unknown): void {
  const dir = path.join(root, "structured", "style_short_drama");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "u_001.json"), `${JSON.stringify(record, null, 2)}\n`);
}

function readStructuredRecord(root: string): unknown {
  const filePath = path.join(root, "structured", "style_short_drama", "u_001.json");
  expect(existsSync(filePath)).toBe(true);
  return JSON.parse(readFileSync(filePath, "utf8"));
}
