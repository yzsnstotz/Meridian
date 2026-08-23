import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatterRole } from "../../definitions/chatter";
import {
  HubPayloadSchema,
  HubResultSchema,
  type ChatterRoleConfig,
  type HubMessage,
  type HubResult,
  type ReplyChannel
} from "../../../types";
import type { RoleContext } from "../../base-role";
import { ChatterManifestSchema } from "../manifest";
import {
  resetChatterReadOnlyQueryCountersForTests,
  snapshotChatterReadOnlyQueryCounters
} from "../observability";

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

function makeReadOnlyResult(skill: string, args: Record<string, unknown>): HubResult {
  return {
    trace_id: crypto.randomUUID(),
    thread_id: "chatter-tenant-a",
    source: "ads",
    status: "success",
    content: "",
    attachments: [],
    timestamp: new Date().toISOString(),
    payload: {
      chatter: {
        read_only_query: { skill, args }
      }
    }
  };
}

function writeManifest(root: string, readOnlyAllowlist: string[]): string {
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      read_only_allowlist: readOnlyAllowlist,
      record_schemas: {
        style_short_drama: {
          type: "object",
          properties: {
            id: { type: "string" },
            voice: { type: "string" }
          },
          required: ["id", "voice"],
          additionalProperties: false
        }
      }
    })
  );
  return manifestPath;
}

function writeStructuredRecord(root: string): void {
  const dir = path.join(root, "structured", "style_short_drama");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "u_001.json"),
    `${JSON.stringify({ id: "u_001", voice: "sharp reversals" }, null, 2)}\n`
  );
}

function latestReadOnlyReply(sent: HubMessage[]): HubMessage {
  const reply = sent.find((msg) => msg.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id);
  expect(reply).toBeDefined();
  return reply!;
}

describe("read_only_query schemas", () => {
  it("accepts manifest read_only_allowlist and bidirectional payload fields", () => {
    const manifest = ChatterManifestSchema.parse({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      read_only_allowlist: ["structured.get", "structured.query"]
    });
    expect(manifest.read_only_allowlist).toEqual(["structured.get", "structured.query"]);

    const outbound = HubPayloadSchema.parse({
      content: "",
      attachments: [],
      chatter: {
        read_only_query: {
          skill: "structured.get",
          args: { type: "style_short_drama", key: "u_001" }
        },
        read_only_query_result: {
          ok: true,
          result: { record: { id: "u_001" } }
        }
      }
    });
    expect(outbound.chatter?.read_only_query?.skill).toBe("structured.get");
    expect(outbound.chatter?.read_only_query_result?.ok).toBe(true);

    const inbound = HubResultSchema.parse({
      trace_id: crypto.randomUUID(),
      thread_id: "chatter-tenant-a",
      source: "ads",
      status: "success",
      content: "",
      attachments: [],
      timestamp: new Date().toISOString(),
      payload: {
        chatter: {
          read_only_query: {
            skill: "structured.get",
            args: { type: "style_short_drama", key: "u_001" }
          }
        }
      }
    });
    expect(inbound.payload?.chatter?.read_only_query?.args.key).toBe("u_001");
  });
});

describe("ChatterRole read_only_query bypass", () => {
  let root: string;
  let role: ChatterRole;
  let sent: HubMessage[];

  beforeEach(async () => {
    resetChatterReadOnlyQueryCountersForTests();
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-read-only-")));
    const manifestPath = writeManifest(root, ["structured.get"]);
    writeStructuredRecord(root);
    const made = makeCtx();
    sent = made.sent;
    role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(made.ctx);
  });

  it("returns an allowlisted structured result without spawning or running an LLM turn", async () => {
    const started = performance.now();
    await role.onInboundResult(makeReadOnlyResult("structured.get", {
      type: "style_short_drama",
      key: "u_001"
    }));
    const elapsedMs = performance.now() - started;

    expect(sent.find((msg) => msg.intent === "spawn")).toBeUndefined();
    expect(sent.find((msg) => msg.target !== "global")).toBeUndefined();
    expect(elapsedMs).toBeLessThan(50);

    const reply = latestReadOnlyReply(sent);
    expect(reply.payload.chatter?.read_only_query_result).toEqual({
      ok: true,
      result: { record: { id: "u_001", voice: "sharp reversals" } }
    });
    expect(snapshotChatterReadOnlyQueryCounters()).toEqual({
      "structured.get|ok": 1
    });
  });

  it("denies skills outside manifest read_only_allowlist and names the offending skill", async () => {
    await role.onInboundResult(makeReadOnlyResult("memory.write", {
      binding: "conversation_log",
      vars: {},
      content: "nope"
    }));

    expect(sent.find((msg) => msg.intent === "spawn")).toBeUndefined();
    const reply = latestReadOnlyReply(sent);
    expect(reply.payload.chatter?.read_only_query_result).toEqual({
      ok: false,
      error: "denied_skill: memory.write"
    });
    expect(reply.payload.content).toContain("denied_skill: memory.write");
    expect(snapshotChatterReadOnlyQueryCounters()).toEqual({
      "memory.write|denied_skill": 1
    });
  });

  it("still enforces structured storage sandbox checks", async () => {
    await role.onInboundResult(makeReadOnlyResult("structured.get", {
      type: "style_short_drama",
      key: "../etc/passwd"
    }));

    expect(sent.find((msg) => msg.intent === "spawn")).toBeUndefined();
    const reply = latestReadOnlyReply(sent);
    expect(reply.payload.chatter?.read_only_query_result).toMatchObject({
      ok: false,
      error: "sandbox_violation"
    });
    expect(snapshotChatterReadOnlyQueryCounters()).toEqual({
      "structured.get|error": 1
    });
  });
});
