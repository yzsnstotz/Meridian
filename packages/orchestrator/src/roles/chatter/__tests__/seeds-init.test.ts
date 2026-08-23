import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChatterRole } from "../../definitions/chatter";
import { loadManifestFromFile } from "../manifest";
import type { ChatterRoleConfig, HubMessage, ReplyChannel } from "../../../types";
import type { RoleContext } from "../../base-role";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
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
    skill_allowlist: [],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
  };
}

function writeManifest(root: string, seedsSourcePath?: string): string {
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      seeds_init: {
        mode: "copy_on_provision",
        ...(seedsSourcePath ? { source_path: seedsSourcePath } : {})
      }
    })
  );
  return manifestPath;
}

describe("ChatterRole seeds_init copy_on_provision", () => {
  it("copies seeds into an empty memory folder and writes the sentinel after success", async () => {
    const memoryFolder = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-memory-")));
    const seedsSource = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-source-")));
    await fs.mkdir(path.join(seedsSource, "templates", "short_drama"), { recursive: true });
    await fs.writeFile(path.join(seedsSource, "templates", "short_drama", "reversal.json"), "{\"id\":\"reversal\"}", "utf8");
    await fs.writeFile(path.join(seedsSource, "prompt.md"), "create prompt", "utf8");
    const manifestPath = writeManifest(memoryFolder, seedsSource);

    const role = new ChatterRole("chatter-tenant-a", makeConfig(memoryFolder, manifestPath));
    await role.onActivate(makeCtx());

    expect(readFileSync(path.join(memoryFolder, "templates", "short_drama", "reversal.json"), "utf8")).toBe("{\"id\":\"reversal\"}");
    expect(readFileSync(path.join(memoryFolder, "prompt.md"), "utf8")).toBe("create prompt");
    expect(existsSync(path.join(memoryFolder, ".seeds_initialized"))).toBe(true);
  });

  it("uses the sentinel as the once-only source of truth and does not re-copy deleted seeds", async () => {
    const memoryFolder = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-memory-")));
    const seedsSource = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-source-")));
    await fs.mkdir(path.join(seedsSource, "templates"), { recursive: true });
    await fs.writeFile(path.join(seedsSource, "templates", "original.json"), "{\"id\":\"original\"}", "utf8");
    const manifestPath = writeManifest(memoryFolder, seedsSource);

    const role = new ChatterRole("chatter-tenant-a", makeConfig(memoryFolder, manifestPath));
    await role.onActivate(makeCtx());
    await fs.rm(path.join(memoryFolder, "templates"), { recursive: true, force: true });
    await fs.writeFile(path.join(seedsSource, "templates", "new.json"), "{\"id\":\"new\"}", "utf8");

    const secondRole = new ChatterRole("chatter-tenant-a", makeConfig(memoryFolder, manifestPath));
    await secondRole.onActivate(makeCtx());

    expect(existsSync(path.join(memoryFolder, "templates"))).toBe(false);
    expect(existsSync(path.join(memoryFolder, ".seeds_initialized"))).toBe(true);
  });

  it("throws seeds_source_missing when copy_on_provision has no readable source", async () => {
    const memoryFolder = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-memory-")));
    const manifestPath = writeManifest(memoryFolder, path.join(memoryFolder, "missing-seeds"));

    const role = new ChatterRole("chatter-tenant-a", makeConfig(memoryFolder, manifestPath));

    await expect(role.onActivate(makeCtx())).rejects.toMatchObject({ message: expect.stringContaining("seeds_source_missing") });
    expect(existsSync(path.join(memoryFolder, ".seeds_initialized"))).toBe(false);
  });

  it("bubbles copy failures as seeds_init_failed and leaves the sentinel absent", async () => {
    const memoryFolder = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-memory-")));
    const seedsSource = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-source-")));
    await fs.mkdir(path.join(seedsSource, "templates"), { recursive: true });
    await fs.writeFile(path.join(seedsSource, "templates", "seed.json"), "{\"id\":\"seed\"}", "utf8");
    await fs.writeFile(path.join(memoryFolder, "templates"), "destination path conflict", "utf8");
    const manifestPath = writeManifest(memoryFolder, seedsSource);

    const role = new ChatterRole("chatter-tenant-a", makeConfig(memoryFolder, manifestPath));

    await expect(role.onActivate(makeCtx())).rejects.toMatchObject({ message: expect.stringContaining("seeds_init_failed") });
    expect(existsSync(path.join(memoryFolder, ".seeds_initialized"))).toBe(false);
  });
});

describe("Chatter manifest seeds_init schema", () => {
  it("accepts copy_on_provision and rejects Phase 2 mount_ro", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-seeds-manifest-")));
    const manifestPath = writeManifest(root, root);

    expect(loadManifestFromFile(manifestPath).seeds_init?.mode).toBe("copy_on_provision");

    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: {},
        seeds_init: { mode: "mount_ro", source_path: root }
      })
    );
    expect(() => loadManifestFromFile(manifestPath)).toThrow();
  });
});
