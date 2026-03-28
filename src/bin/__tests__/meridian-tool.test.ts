import { describe, expect, it, vi } from "vitest";

import { executeToolCommand, ToolRegistry } from "../../tool-gateway";
import { runCli, type CliDeps, type CliIo } from "../meridian-tool";

describe("runCli", () => {
  it("returns error JSON for an unknown tool", async () => {
    const registry = new ToolRegistry();
    const io = createIo();

    const exitCode = await runCli(["missing-tool"], createDeps(registry), io.streams);

    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: "Unknown tool: missing-tool"
    });
    expect(io.stderr()).toBe("");
  });

  it("prints help to stderr and lists registered tools", async () => {
    const registry = new ToolRegistry();
    const io = createIo();

    registry.register(createTool("kill", "Kill a worker"));
    registry.register(createTool("spawn", "Spawn a worker"));

    const exitCode = await runCli(["--help"], createDeps(registry), io.streams);
    const payload = JSON.parse(io.stdout());

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      tools: [
        { name: "kill", description: "Kill a worker", params: [] },
        { name: "spawn", description: "Spawn a worker", params: [] }
      ]
    });
    expect(io.stderr()).toContain("Usage: npx tsx src/bin/meridian-tool.ts <tool-name> [--param value ...]");
    expect(io.stderr()).toContain("kill");
    expect(io.stderr()).toContain("spawn");
  });

  it("dispatches params to the requested tool using snake_case keys", async () => {
    const registry = new ToolRegistry();
    const io = createIo();
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        thread_id: "thread-123"
      }
    });

    registry.register({
      name: "spawn",
      description: "Spawn a worker",
      params: {
        agent_type: {
          type: "string",
          required: true
        },
        mode: {
          type: "string",
          required: true
        }
      },
      execute
    });

    const exitCode = await runCli(["spawn", "--agent-type", "claude", "--mode", "bridge"], createDeps(registry), io.streams);

    expect(exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith({
      agent_type: "claude",
      mode: "bridge"
    });
    expect(JSON.parse(io.stdout())).toEqual({
      ok: true,
      data: {
        thread_id: "thread-123"
      }
    });
    expect(io.stderr()).toBe("");
  });
});

function createDeps(registry: ToolRegistry): CliDeps {
  return {
    createToolGateway: vi.fn().mockResolvedValue(registry),
    executeToolCommand
  };
}

function createIo(): {
  streams: CliIo;
  stdout(): string;
  stderr(): string;
} {
  let stdout = "";
  let stderr = "";

  return {
    streams: {
      stdout: {
        write(chunk: string): boolean {
          stdout += chunk;
          return true;
        }
      },
      stderr: {
        write(chunk: string): boolean {
          stderr += chunk;
          return true;
        }
      }
    },
    stdout(): string {
      return stdout;
    },
    stderr(): string {
      return stderr;
    }
  };
}

function createTool(name: string, description: string) {
  return {
    name,
    description,
    params: {},
    execute: vi.fn().mockResolvedValue({ ok: true })
  };
}
