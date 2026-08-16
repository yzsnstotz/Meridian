import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import type { ChatterRoleConfig, HubMessage, ReplyChannel } from "../../../types";
import type { AdsHmacTransport } from "../../../transport/ads-hmac";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
};

describe("ChatterRole project-scoped skill wiring", () => {
  it("registers a project-scoped skill from the mumu2 manifest and dispatches it through the transport", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-project-")));
    const manifestPath = writeMinimalManifest(root);

    const posts: Array<{ url: string; body: unknown; userId: string }> = [];
    const factoryCalls: string[] = [];
    const transportFactory = (userId: string): AdsHmacTransport => {
      factoryCalls.push(userId);
      return {
        post: async (url, body) => {
          posts.push({ url, body, userId });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              kind: "dna_template",
              id: (body as { id?: string }).id ?? "?",
              content: { id: "dna-1", name: "Template Alpha", beats: [] }
            })
          };
        }
      };
    };

    const config: ChatterRoleConfig = {
      chatter_id: "tenant-a",
      memory_folder: root,
      manifest_path: manifestPath,
      allowed_modes: ["stateless", "session"],
      skill_allowlist: ["fetch_dna_template"],
      llm_agent_kind: "claude-code",
      project_id: "mumu2",
      user_reply_channel: ADS_REPLY_CHANNEL
    };

    const role = new ChatterRole("chatter-tenant-a", config, {
      adsTransportFactory: transportFactory
    });
    const ctx = makeCtx();
    await role.onActivate(ctx.ctx);

    // The agent calls the project-scoped skill via the prefixed tool name
    // (same convention assertSkillAllowed enforces — short name in allowlist,
    // prefixed name on the wire).
    const result = await role.handleAgentToolCall("chatter.skill.fetch_dna_template", { id: "dna-1" });

    // End-to-end chain:
    //   handler → factory(userId) → transport.post(url, body) → skill returns body.content
    expect(result).toEqual({ id: "dna-1", name: "Template Alpha", beats: [] });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: "/api/mumu2/read-only-query",
      body: { kind: "dna_template", id: "dna-1" }
    });
    expect(factoryCalls).toEqual([path.basename(root)]);
  });

  it("rejects a project-scoped skill that is not in the allowlist (dispatch-time gate)", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-project-deny-")));
    const manifestPath = writeMinimalManifest(root);

    const config: ChatterRoleConfig = {
      chatter_id: "tenant-a",
      memory_folder: root,
      manifest_path: manifestPath,
      allowed_modes: ["stateless", "session"],
      skill_allowlist: [], // empty -> no project skills register
      llm_agent_kind: "claude-code",
      project_id: "mumu2",
      user_reply_channel: ADS_REPLY_CHANNEL
    };

    const role = new ChatterRole("chatter-tenant-a", config, {
      adsTransportFactory: () => ({
        post: async () => ({
          ok: true,
          status: 200,
          json: async () => ({})
        })
      })
    });
    const ctx = makeCtx();
    await role.onActivate(ctx.ctx);

    const result = await role.handleAgentToolCall("chatter.skill.fetch_dna_template", { id: "dna-1" });
    expect(result).toMatchObject({ error: "denied_skill" });
  });

  it("logs a warning when project_id is set but no adsTransportFactory is provided", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-project-nofactory-")));
    const manifestPath = writeMinimalManifest(root);

    const config: ChatterRoleConfig = {
      chatter_id: "tenant-a",
      memory_folder: root,
      manifest_path: manifestPath,
      allowed_modes: ["stateless", "session"],
      skill_allowlist: ["fetch_dna_template"],
      llm_agent_kind: "claude-code",
      project_id: "mumu2",
      user_reply_channel: ADS_REPLY_CHANNEL
    };

    const role = new ChatterRole("chatter-tenant-a", config);
    const ctx = makeCtx();
    await role.onActivate(ctx.ctx);

    // No project skill registered; agent tool call returns unknown_skill
    // (the allowlist check passes since the short name IS allowlisted, but
    // the dispatch Map has no entry under chatter.skill.fetch_dna_template).
    const result = await role.handleAgentToolCall("chatter.skill.fetch_dna_template", { id: "dna-1" });
    expect(result).toMatchObject({ error: "unknown_skill" });

    const sawWarn = ctx.warns.some((entry) => {
      const meta = entry[1];
      return (
        typeof meta === "object"
        && meta !== null
        && (meta as Record<string, unknown>).project_id === "mumu2"
      );
    });
    expect(sawWarn).toBe(true);
  });

  it("structured.* skills still resolve when project skills are also wired", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-project-structured-")));
    const manifestPath = writeMinimalManifest(root);

    const config: ChatterRoleConfig = {
      chatter_id: "tenant-a",
      memory_folder: root,
      manifest_path: manifestPath,
      allowed_modes: ["stateless", "session"],
      skill_allowlist: ["structured.upsert", "fetch_dna_template"],
      llm_agent_kind: "claude-code",
      project_id: "mumu2",
      user_reply_channel: ADS_REPLY_CHANNEL
    };

    const role = new ChatterRole("chatter-tenant-a", config, {
      adsTransportFactory: () => ({
        post: async () => ({
          ok: true,
          status: 200,
          json: async () => ({})
        })
      })
    });
    const ctx = makeCtx();
    await role.onActivate(ctx.ctx);

    const result = await role.handleAgentToolCall("structured.upsert", {
      type: "demo",
      key: "k1",
      record: { id: "k1", value: "v" }
    });
    expect(result).toMatchObject({ record: { id: "k1", value: "v" } });
  });
});

function makeCtx(): { ctx: RoleContext; sent: HubMessage[]; warns: unknown[][] } {
  const sent: HubMessage[] = [];
  const warns: unknown[][] = [];
  const ctx: RoleContext = {
    sendToHub: async (msg) => {
      sent.push(msg as HubMessage);
    },
    listInstances: async () => [],
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
      error: () => undefined
    }
  };
  return { ctx, sent, warns };
}

function writeMinimalManifest(root: string): string {
  const manifestPath = path.join(root, "manifest.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      record_schemas: {
        demo: {
          type: "object",
          properties: {
            id: { type: "string" },
            value: { type: "string" }
          },
          required: ["id"],
          additionalProperties: false
        }
      }
    })
  );
  return manifestPath;
}
