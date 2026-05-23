import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../../types";
import { loadManifestFromFile } from "../manifest";
import { DeniedReadOnlyRootError, MemoryResolver } from "../memory-resolver";
import { makeStructuredSkills } from "../skills/structured";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:multi-root",
  socket_path: "/tmp/ads-multi-root.sock"
};

function makeCtx(): RoleContext {
  const sent: HubMessage[] = [];
  return {
    sendToHub: async (msg) => {
      sent.push(msg as HubMessage);
    },
    listInstances: async () => [],
    log: { debug() {}, info() {}, warn() {}, error() {} }
  };
}

function makeConfig(memoryFolder: string, manifestPath: string): ChatterRoleConfig {
  return {
    chatter_id: "tenant-a",
    memory_folder: memoryFolder,
    manifest_path: manifestPath,
    allowed_modes: ["stateless", "session"],
    skill_allowlist: ["structured.upsert", "structured.get", "structured.query", "structured.list"],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
  };
}

function writeManifest(baseDir: string, extras: Record<string, unknown> = {}): string {
  const manifestPath = path.join(baseDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {
        conversation_log: "turns/<date>/turn-<turn_id>.md"
      },
      record_schemas: {
        story_test: {
          type: "object",
          "x-indexed-fields": ["genre", "status"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            genre: { type: "string" },
            status: { type: "string" }
          },
          required: ["id", "title", "genre", "status"],
          additionalProperties: false
        }
      },
      ...extras
    })
  );
  return manifestPath;
}

function story(id: string, title = id, genre = "seed", status = "draft"): Record<string, string> {
  return { id, title, genre, status };
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

async function driveSpawnResponse(role: ChatterRole, spawnMsg: HubMessage, newAgentThreadId: string): Promise<void> {
  await role.onInboundResult({
    trace_id: spawnMsg.trace_id,
    thread_id: newAgentThreadId,
    source: spawnMsg.target,
    status: "success",
    content: `spawned ${newAgentThreadId}`,
    attachments: [],
    timestamp: new Date().toISOString()
  });
}

function writeStructuredRecord(root: string, key: string, value: unknown): void {
  const dir = path.join(root, "structured", "story_test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

describe("multi-root chatter sandbox", () => {
  it("keeps Phase 1 project-policy seeds_init copy_on_provision working through a live-manifest chatter turn", async () => {
    const memoryFolder = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-phase1-memory-")));
    const seedsSource = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-phase1-seeds-")));
    await fs.mkdir(path.join(seedsSource, "templates", "short_drama"), { recursive: true });
    await fs.writeFile(
      path.join(seedsSource, "templates", "short_drama", "phase1.json"),
      "{\"id\":\"phase1\"}",
      "utf8"
    );

    const manifestPath = path.resolve("config/projects/mumu/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sandbox_roots?: unknown };
    const policy = JSON.parse(readFileSync(path.resolve("config/projects/mumu.json"), "utf8")) as {
      allowed_modes: ChatterRoleConfig["allowed_modes"];
      skill_allowlist: ChatterRoleConfig["skill_allowlist"];
      llm_agent_kind: ChatterRoleConfig["llm_agent_kind"];
      seeds_init?: { mode?: string };
    };
    expect(manifest.sandbox_roots).toBeUndefined();
    expect(policy.seeds_init?.mode).toBe("copy_on_provision");

    const sent: HubMessage[] = [];
    const role = new ChatterRole("chatter-tenant-a", {
      ...makeConfig(memoryFolder, manifestPath),
      allowed_modes: policy.allowed_modes,
      skill_allowlist: policy.skill_allowlist,
      llm_agent_kind: policy.llm_agent_kind,
      seeds_init: { mode: "copy_on_provision", source_path: seedsSource }
    });

    await role.onActivate({
      ...makeCtx(),
      sendToHub: async (msg) => {
        sent.push(msg as HubMessage);
      }
    });

    expect(readFileSync(path.join(memoryFolder, "templates", "short_drama", "phase1.json"), "utf8")).toBe(
      "{\"id\":\"phase1\"}"
    );
    expect(existsSync(path.join(memoryFolder, ".seeds_initialized"))).toBe(true);

    await role.onInboundResult(makeTurnResult("hello from Phase 1 shape", {
      payload: { chatter: { mode: "session", chatter_session_id: "ads-phase1" } }
    }));
    const spawn = sent.find((msg) => msg.intent === "spawn");
    expect(spawn).toBeDefined();

    await driveSpawnResponse(role, spawn!, "claude_phase1");
    const run = sent.find((msg) => msg.intent === "run" && msg.target === "claude_phase1");
    expect(run?.payload.content).toBe("hello from Phase 1 shape");

    await role.onInboundResult({
      trace_id: run!.trace_id,
      thread_id: "claude_phase1",
      source: "claude",
      status: "success",
      content: "phase1 reply",
      attachments: [],
      timestamp: new Date().toISOString(),
      run_state: "completed"
    });
    const reply = sent.find(
      (msg) => msg.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id && msg.payload.content === "phase1 reply"
    );
    expect(reply).toBeDefined();
  });

  it("activates a Phase 2 manifest with RW and RO roots without copying seeds", async () => {
    const userRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-user-root-")));
    const roRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-ro-root-")));
    writeStructuredRecord(roRoot, "seed-only", story("seed-only"));
    const manifestPath = writeManifest(userRoot, {
      sandbox_roots: [
        { root: userRoot, mode: "rw" },
        { root: roRoot, mode: "ro" }
      ]
    });

    const role = new ChatterRole("chatter-tenant-a", makeConfig(userRoot, manifestPath));
    await role.onActivate(makeCtx());

    expect(existsSync(path.join(userRoot, ".seeds_initialized"))).toBe(false);
    const settings = JSON.parse(readFileSync(path.join(userRoot, ".chatter-sandbox", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([
      `Read(${userRoot}/**)`,
      `Write(${userRoot}/**)`,
      `Read(${roRoot}/**)`
    ]));
    expect(settings.permissions.allow).not.toContain(`Write(${roRoot}/**)`);
  });

  it("supports B-1 style {user_id} sandbox root interpolation", async () => {
    const usersBase = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-users-")));
    const userRoot = path.join(usersBase, "user-123");
    mkdirSync(userRoot, { recursive: true });
    const roRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-ro-root-")));
    const manifestPath = writeManifest(userRoot, {
      sandbox_roots: [
        { root: path.join(usersBase, "{user_id}"), mode: "rw" },
        { root: roRoot, mode: "ro" }
      ]
    });

    const role = new ChatterRole("chatter-tenant-a", makeConfig(userRoot, manifestPath));
    await role.onActivate(makeCtx());

    const settings = JSON.parse(readFileSync(path.join(userRoot, ".chatter-sandbox", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([`Write(${userRoot}/**)`]));
  });

  it("rejects manifest sandbox_roots combined with config seed copying", async () => {
    const userRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-conflict-root-")));
    const roRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-conflict-ro-")));
    const manifestPath = writeManifest(userRoot, {
      sandbox_roots: [
        { root: userRoot, mode: "rw" },
        { root: roRoot, mode: "ro" }
      ]
    });

    const role = new ChatterRole("chatter-tenant-a", {
      ...makeConfig(userRoot, manifestPath),
      seeds_init: { mode: "copy_on_provision", source_path: roRoot }
    });

    await expect(role.onActivate(makeCtx())).rejects.toMatchObject({
      message: expect.stringContaining("manifest_sandbox_mode_conflict")
    });
  });
});

describe("multi-root structured skills", () => {
  it("writes new records to RW, refuses RO-only overwrites with denied_ro_root, and reads RW before RO", async () => {
    const userRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-structured-rw-")));
    const roRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-structured-ro-")));
    writeStructuredRecord(roRoot, "seed-only", story("seed-only", "Seed"));
    writeStructuredRecord(roRoot, "collision", story("collision", "Seed Collision"));
    writeStructuredRecord(userRoot, "collision", story("collision", "User Collision", "user"));
    const manifestPath = writeManifest(userRoot, {
      sandbox_roots: [
        { root: userRoot, mode: "rw" },
        { root: roRoot, mode: "ro" }
      ]
    });
    const resolver = new MemoryResolver(userRoot, loadManifestFromFile(manifestPath));
    const skills = makeStructuredSkills(resolver);

    await expect(skills.upsert("story_test", "new-user", story("new-user", "New", "user"))).resolves.toEqual({
      record: story("new-user", "New", "user")
    });
    expect(existsSync(path.join(userRoot, "structured", "story_test", "new-user.json"))).toBe(true);

    await expect(skills.get("story_test", "seed-only")).resolves.toEqual({
      record: story("seed-only", "Seed")
    });
    await expect(skills.get("story_test", "collision")).resolves.toEqual({
      record: story("collision", "User Collision", "user")
    });

    await expect(skills.upsert("story_test", "seed-only", story("seed-only", "Edited"))).resolves.toMatchObject({
      error: "denied_ro_root",
      attempted_path: path.join(roRoot, "structured", "story_test", "seed-only.json")
    });
    expect(readFileSync(path.join(roRoot, "structured", "story_test", "seed-only.json"), "utf8")).toContain(
      "\"title\": \"Seed\""
    );
  });

  it("throws a typed denied_ro_root error at the resolver write boundary", () => {
    const userRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-denied-rw-")));
    const roRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-denied-ro-")));
    writeStructuredRecord(roRoot, "seed-only", story("seed-only"));
    const manifestPath = writeManifest(userRoot, {
      sandbox_roots: [
        { root: userRoot, mode: "rw" },
        { root: roRoot, mode: "ro" }
      ]
    });
    const resolver = new MemoryResolver(userRoot, loadManifestFromFile(manifestPath));

    expect(() => resolver.resolveMemoryPathForWrite("structured", "story_test", "seed-only.json")).toThrow(
      DeniedReadOnlyRootError
    );
  });

  it("allows RW index shadowing when an RO seed root already has _index.json", async () => {
    const userRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-index-shadow-rw-")));
    const roRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-index-shadow-ro-")));
    writeStructuredRecord(roRoot, "seed-a", story("seed-a", "Seed A", "seed"));
    const roIndexPath = path.join(roRoot, "structured", "story_test", "_index.json");
    writeFileSync(
      roIndexPath,
      `${JSON.stringify({
        keys: ["seed-a"],
        by_field: {
          genre: { seed: ["seed-a"] },
          status: { draft: ["seed-a"] }
        }
      }, null, 2)}\n`
    );
    const roRecordPath = path.join(roRoot, "structured", "story_test", "seed-a.json");
    const roRecordBefore = readFileSync(roRecordPath, "utf8");
    const roIndexBefore = readFileSync(roIndexPath, "utf8");
    const manifestPath = writeManifest(userRoot, {
      sandbox_roots: [
        { root: userRoot, mode: "rw" },
        { root: roRoot, mode: "ro" }
      ]
    });
    const resolver = new MemoryResolver(userRoot, loadManifestFromFile(manifestPath));
    const skills = makeStructuredSkills(resolver);

    await expect(skills.upsert("story_test", "new-user", story("new-user", "New User", "user"))).resolves.toEqual({
      record: story("new-user", "New User", "user")
    });

    expect(existsSync(path.join(userRoot, "structured", "story_test", "new-user.json"))).toBe(true);
    expect(existsSync(path.join(userRoot, "structured", "story_test", "_index.json"))).toBe(true);
    expect(readFileSync(roRecordPath, "utf8")).toBe(roRecordBefore);
    expect(readFileSync(roIndexPath, "utf8")).toBe(roIndexBefore);
    await expect(skills.list("story_test")).resolves.toEqual({ keys: ["new-user", "seed-a"] });
    await expect(skills.query("story_test", { field: "status", op: "eq", value: "draft" })).resolves.toEqual({
      records: [
        story("new-user", "New User", "user"),
        story("seed-a", "Seed A", "seed")
      ]
    });
  });

  it("reconciles direct JSON records from both RW and RO roots into list and query", async () => {
    const userRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-reconcile-rw-")));
    const roRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-reconcile-ro-")));
    writeStructuredRecord(roRoot, "seed-a", story("seed-a", "Seed A", "seed"));
    writeStructuredRecord(userRoot, "user-a", story("user-a", "User A", "user"));
    const manifestPath = writeManifest(userRoot, {
      sandbox_roots: [
        { root: userRoot, mode: "rw" },
        { root: roRoot, mode: "ro" }
      ]
    });
    const resolver = new MemoryResolver(userRoot, loadManifestFromFile(manifestPath));
    const skills = makeStructuredSkills(resolver);

    await expect(skills.list("story_test")).resolves.toEqual({ keys: ["seed-a", "user-a"] });
    await expect(skills.query("story_test", { field: "genre", op: "eq", value: "seed" })).resolves.toEqual({
      records: [story("seed-a", "Seed A", "seed")]
    });
    expect(existsSync(path.join(userRoot, "structured", "story_test", "_index.json"))).toBe(true);
  });
});
