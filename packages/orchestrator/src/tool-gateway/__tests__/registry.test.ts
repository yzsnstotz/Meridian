import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadToolsFromDirectory } from "../loader";
import { ToolRegistry } from "../registry";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("ToolRegistry", () => {
  it("registers, retrieves, and lists tool definitions", async () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "spawn",
      description: "Spawn a worker thread",
      params: {
        worker: {
          type: "string" as const,
          required: true
        }
      },
      execute: vi.fn().mockResolvedValue({ ok: true })
    };

    registry.register(tool);

    expect(registry.get("spawn")).toBe(tool);
    expect(registry.list()).toEqual([tool]);
  });

  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "spawn",
      description: "Spawn a worker thread",
      params: {},
      execute: vi.fn().mockResolvedValue({ ok: true })
    };

    registry.register(tool);

    expect(() => registry.register(tool)).toThrow("Tool already registered: spawn");
  });
});

describe("loadToolsFromDirectory", () => {
  it("loads valid tool modules and skips invalid ones", async () => {
    const registry = new ToolRegistry();
    const toolsDir = await createTempDirectory();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await fs.writeFile(path.join(toolsDir, "valid.js"), buildToolModule("spawn", "Spawn a worker"));
    await fs.writeFile(path.join(toolsDir, "helper.js"), "exports.readHelper = () => 'helper';");
    await fs.writeFile(path.join(toolsDir, "invalid.js"), "module.exports = { default: { nope: true } };");
    await fs.writeFile(path.join(toolsDir, "broken.js"), "throw new Error('broken tool');");
    await fs.writeFile(path.join(toolsDir, "readme.md"), "# ignored\n");

    await loadToolsFromDirectory(toolsDir, registry);

    expect(registry.list().map((tool) => tool.name)).toEqual(["spawn"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not crash when the tools directory does not exist", async () => {
    const registry = new ToolRegistry();
    const missingDir = path.join("/tmp", `meridian-roles-missing-${Date.now()}`);

    await expect(loadToolsFromDirectory(missingDir, registry)).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp("/tmp/meridian-roles-tool-gateway-");
  tempDirectories.add(directory);
  return directory;
}

function buildToolModule(name: string, description: string): string {
  return `module.exports = {
  default: {
    name: ${JSON.stringify(name)},
    description: ${JSON.stringify(description)},
    params: {},
    execute: async () => ({ ok: true, data: { tool: ${JSON.stringify(name)} } })
  }
};`;
}
