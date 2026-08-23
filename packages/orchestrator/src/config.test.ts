import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.resetModules();
  process.chdir(originalCwd);

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnv);

  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("config", () => {
  it("loads defaults from env files in the resolved config directory", async () => {
    const directory = await createTempDirectory();
    await fs.writeFile(
      path.join(directory, ".env"),
      "HUB_SOCKET_PATH=/tmp/from-dot-env.sock\nGUI_PORT=7709\nGUI_LISTEN_HOST=127.0.0.1\n",
      "utf8"
    );
    await fs.writeFile(path.join(directory, ".env.local"), "HUB_SOCKET_PATH=/tmp/from-dot-env-local.sock\n", "utf8");

    delete process.env.HUB_SOCKET_PATH;
    delete process.env.GUI_PORT;
    delete process.env.GUI_LISTEN_HOST;
    process.env.MERIDIAN_CONFIG_DIR = directory;
    process.chdir(directory);

    const config = await import("./config");

    expect(config.HUB_SOCKET_PATH).toBe("/tmp/from-dot-env-local.sock");
    expect(config.GUI_PORT).toBe(7709);
    expect(config.GUI_LISTEN_HOST).toBe("127.0.0.1");
  });

  it("does not override explicit process env values", async () => {
    const directory = await createTempDirectory();
    await fs.writeFile(path.join(directory, ".env.local"), "HUB_SOCKET_PATH=/tmp/from-dot-env-local.sock\n", "utf8");

    process.env.HUB_SOCKET_PATH = "/tmp/from-process-env.sock";
    process.env.MERIDIAN_CONFIG_DIR = directory;
    process.chdir(directory);

    const config = await import("./config");

    expect(config.HUB_SOCKET_PATH).toBe("/tmp/from-process-env.sock");
  });

  it("defaults STATE_FILE_PATH to the resolved persistent state directory and does not warn", async () => {
    const directory = await createTempDirectory();
    const stateDir = path.join(os.homedir(), ".meridian-test-state", path.basename(directory));

    delete process.env.STATE_FILE_PATH;
    process.env.MERIDIAN_STATE_DIR = stateDir;
    process.chdir(directory);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const config = await import("./config");
      expect(config.STATE_FILE_PATH).toBe(path.join(stateDir, "orchestrator-state.json"));
      expect(config.DEFAULT_STATE_FILE_PATH).toBe(config.STATE_FILE_PATH);
      expect(config.IS_EPHEMERAL_STATE_FILE_PATH).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when STATE_FILE_PATH resolves to an ephemeral filesystem", async () => {
    const directory = await createTempDirectory();

    process.env.STATE_FILE_PATH = "/tmp/meridian-roles/state.json";
    process.chdir(directory);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const config = await import("./config");
      expect(config.STATE_FILE_PATH).toBe("/tmp/meridian-roles/state.json");
      expect(config.IS_EPHEMERAL_STATE_FILE_PATH).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("ephemeral filesystem");
    } finally {
      warn.mockRestore();
    }
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-config-"));
  tempDirectories.add(directory);
  return directory;
}
