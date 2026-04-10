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
  it("loads defaults from local env files in the current working directory", async () => {
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
    process.chdir(directory);

    const config = await import("./config");

    expect(config.HUB_SOCKET_PATH).toBe("/tmp/from-process-env.sock");
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-config-"));
  tempDirectories.add(directory);
  return directory;
}
