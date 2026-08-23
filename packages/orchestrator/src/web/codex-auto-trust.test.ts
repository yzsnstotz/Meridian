import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureCodexTrustEntry, llmAgentKindUsesCodexTrust } from "./codex-auto-trust";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

const makeTempConfig = (): { dir: string; configPath: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-auto-trust-"));
  return { dir, configPath: path.join(dir, "config.toml") };
};

describe("llmAgentKindUsesCodexTrust", () => {
  it("matches codex family kinds", () => {
    expect(llmAgentKindUsesCodexTrust("codex")).toBe(true);
    expect(llmAgentKindUsesCodexTrust("codex-high")).toBe(true);
    expect(llmAgentKindUsesCodexTrust("codex-xhigh")).toBe(true);
  });

  it("rejects non-codex kinds", () => {
    expect(llmAgentKindUsesCodexTrust("claude-code")).toBe(false);
    expect(llmAgentKindUsesCodexTrust("claude")).toBe(false);
    expect(llmAgentKindUsesCodexTrust("gemini")).toBe(false);
    expect(llmAgentKindUsesCodexTrust("codex-like-but-not")).toBe(true); // codex- prefix; intentional
    expect(llmAgentKindUsesCodexTrust("codexX")).toBe(false);
  });
});

describe("ensureCodexTrustEntry", () => {
  it("creates a fresh config.toml when none exists, with the trust block + chmod 600", async () => {
    const { dir, configPath } = makeTempConfig();
    try {
      const result = await ensureCodexTrustEntry({
        memoryFolder: "/data/mumu/users/abc-123",
        configTomlPath: configPath,
        log: noopLog
      });
      expect(result.appended).toBe(true);

      const contents = await fs.readFile(configPath, "utf8");
      expect(contents).toContain('[projects."/data/mumu/users/abc-123"]');
      expect(contents).toContain('trust_level = "trusted"');

      const stat = await fs.stat(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to an existing config.toml without overwriting prior content", async () => {
    const { dir, configPath } = makeTempConfig();
    try {
      const priorConfig = `[projects."/var/meridian"]\ntrust_level = "trusted"\napproval_policy = "never"\n`;
      await fs.writeFile(configPath, priorConfig);

      const result = await ensureCodexTrustEntry({
        memoryFolder: "/data/mumu/users/new-user",
        configTomlPath: configPath,
        log: noopLog
      });
      expect(result.appended).toBe(true);

      const contents = await fs.readFile(configPath, "utf8");
      expect(contents).toContain('[projects."/var/meridian"]'); // prior preserved
      expect(contents).toContain('[projects."/data/mumu/users/new-user"]'); // new appended
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — re-running with the same memoryFolder does not re-append", async () => {
    const { dir, configPath } = makeTempConfig();
    try {
      const memoryFolder = "/data/mumu/users/u-1";
      const first = await ensureCodexTrustEntry({ memoryFolder, configTomlPath: configPath, log: noopLog });
      expect(first.appended).toBe(true);

      const before = await fs.readFile(configPath, "utf8");

      const second = await ensureCodexTrustEntry({ memoryFolder, configTomlPath: configPath, log: noopLog });
      expect(second.appended).toBe(false);
      expect(second.reason).toBe("already_present");

      const after = await fs.readFile(configPath, "utf8");
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-ops when disabled=true", async () => {
    const { dir, configPath } = makeTempConfig();
    try {
      const result = await ensureCodexTrustEntry({
        memoryFolder: "/data/mumu/users/no-touch",
        configTomlPath: configPath,
        log: noopLog,
        disabled: true
      });
      expect(result.appended).toBe(false);
      expect(result.reason).toBe("disabled_by_env");

      await expect(fs.access(configPath)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw if the config file is unreadable — returns reason and logs warn", async () => {
    // Point at a directory instead of a file → read fails with EISDIR, not ENOENT
    const { dir } = makeTempConfig();
    try {
      const result = await ensureCodexTrustEntry({
        memoryFolder: "/data/mumu/users/u-2",
        configTomlPath: dir, // pointing at a directory
        log: noopLog
      });
      expect(result.appended).toBe(false);
      expect(result.reason).toBe("read_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
