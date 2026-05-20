import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../../types";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
};

interface WarnCall {
  message: string;
  meta?: unknown;
}

function makeCtx() {
  const sent: HubMessage[] = [];
  const warns: WarnCall[] = [];
  const ctx: RoleContext = {
    sendToHub: async (msg) => {
      sent.push(msg as HubMessage);
    },
    listInstances: async () => [],
    log: {
      debug() {},
      info() {},
      warn(message, meta) {
        warns.push({ message: String(message), meta });
      },
      error() {}
    }
  };
  return { ctx, sent, warns };
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

function writeStructuredManifest(root: string): string {
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: { conversation_log: "turns/<turn_id>.md" },
      record_schemas: {
        template_short_drama: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            beats: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["id", "title", "beats"],
          additionalProperties: false
        }
      }
    })
  );
  return manifestPath;
}

function writeStructuredRecord(root: string, type: string, key: string, record: unknown): void {
  const dir = path.join(root, "structured", type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${key}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function dispatchFirstRun(
  role: ChatterRole,
  sent: HubMessage[],
  turn: HubResult
): Promise<HubMessage> {
  await role.onInboundResult(turn);
  const spawn = sent.find((m) => m.intent === "spawn")!;
  expect(spawn).toBeDefined();
  await role.onInboundResult({
    trace_id: spawn.trace_id,
    thread_id: "claude_07",
    source: spawn.target,
    status: "success",
    content: "spawned claude_07",
    attachments: [],
    timestamp: new Date().toISOString()
  });
  const run = sent.find((m) => m.intent === "run" && m.target === "claude_07")!;
  expect(run).toBeDefined();
  return run;
}

describe("ChatterRole payload.chatter.context_refs", () => {
  it("pre-loads valid structured records at the head of the turn prompt", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-context-refs-")));
    const manifestPath = writeStructuredManifest(root);
    writeStructuredRecord(root, "template_short_drama", "template-abc", {
      id: "template-abc",
      title: "Opening Hook",
      beats: ["cold open", "choice point"]
    });
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(ctx);

    const run = await dispatchFirstRun(role, sent, makeTurnResult("draft episode one", {
      payload: {
        chatter: {
          mode: "session",
          chatter_session_id: "ads-session-1",
          context_refs: [{ type: "template_short_drama", key: "template-abc" }]
        }
      }
    }));

    expect(run.payload.content).toContain("## Pre-loaded context");
    expect(run.payload.content).toContain("### type: template_short_drama, key: template-abc");
    expect(run.payload.content).toContain('"title": "Opening Hook"');
    expect(run.payload.content.indexOf("## Pre-loaded context")).toBeLessThan(
      run.payload.content.indexOf("User turn:")
    );
    expect(run.payload.content).toContain("draft episode one");
  });

  it("injects a placeholder and logs a warning when a referenced record is missing", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-context-refs-")));
    const manifestPath = writeStructuredManifest(root);
    const { ctx, sent, warns } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(ctx);

    const run = await dispatchFirstRun(role, sent, makeTurnResult("continue anyway", {
      payload: {
        chatter: {
          mode: "session",
          context_refs: [{ type: "template_short_drama", key: "missing-template" }]
        }
      }
    }));

    expect(run.payload.content).toContain("**[context not found: template_short_drama/missing-template]**");
    expect(warns.some((w) => w.message.includes("context ref not found"))).toBe(true);
  });

  it("injects a placeholder and logs a warning for unknown record types without crashing the turn", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-context-refs-")));
    const manifestPath = writeStructuredManifest(root);
    const { ctx, sent, warns } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(ctx);

    const run = await dispatchFirstRun(role, sent, makeTurnResult("continue anyway", {
      payload: {
        chatter: {
          mode: "session",
          context_refs: [{ type: "unknown_type", key: "abc" }]
        }
      }
    }));

    expect(run.payload.content).toContain("**[context not found: unknown_type/abc]**");
    expect(warns.some((w) => w.message.includes("unknown context ref type"))).toBe(true);
  });

  it("injects a placeholder and logs a warning when a record fails manifest schema validation", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-context-refs-")));
    const manifestPath = writeStructuredManifest(root);
    writeStructuredRecord(root, "template_short_drama", "invalid-template", {
      id: "invalid-template",
      title: "Missing beats"
    });
    const { ctx, sent, warns } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(ctx);

    const run = await dispatchFirstRun(role, sent, makeTurnResult("continue anyway", {
      payload: {
        chatter: {
          mode: "session",
          context_refs: [{ type: "template_short_drama", key: "invalid-template" }]
        }
      }
    }));

    expect(run.payload.content).toContain("**[context not found: template_short_drama/invalid-template]**");
    expect(warns.some((w) => w.message.includes("context ref failed schema validation"))).toBe(true);
  });

  it("does not alter turn content when context_refs is absent", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-context-refs-")));
    const manifestPath = writeStructuredManifest(root);
    const { ctx, sent } = makeCtx();
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath));
    await role.onActivate(ctx);

    const run = await dispatchFirstRun(role, sent, makeTurnResult("plain user turn", {
      payload: { chatter: { mode: "session", chatter_session_id: "ads-session-1" } }
    }));

    expect(run.payload.content).toBe("plain user turn");
  });
});
