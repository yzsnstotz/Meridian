import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { InstanceManager } from "./instance-manager";
import { InstanceRegistry } from "./registry";

class FakeChildProcess extends EventEmitter {
  pid: number;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", 0, signal ?? "SIGTERM");
    return true;
  }
}

test("spawn registers instance and uses bridge args", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: Array<{ command: string; args: string[] }> = [];

  const manager = new InstanceManager(registry, {
    spawnFn: ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return new FakeChildProcess(1101) as never;
    }) as never
  });

  const threadId = await manager.spawn("codex", "bridge");
  const instance = registry.get(threadId);

  assert.equal(threadId, "codex_01");
  assert.equal(instance?.socket_path, "/tmp/agentapi-codex_01.sock");
  assert.equal(instance?.pid, 1101);
  assert.deepEqual(spawnCalls[0]?.args, ["server", "--type=codex", "--", "codex"]);
});

test("spawn claude bridge includes --allowedTools args", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    spawnFn: ((_: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(1202) as never;
    }) as never
  });

  const threadId = await manager.spawn("claude", "bridge");
  assert.equal(threadId, "claude_01");
  assert.deepEqual(spawnCalls[0], [
    "server",
    "--type=claude",
    "--",
    "claude",
    "--allowedTools",
    "Bash Edit Replace"
  ]);
});

test("spawn pane_bridge creates tmux session and appends --tmux-session arg", async () => {
  const registry = new InstanceRegistry();
  const execCalls: string[] = [];
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    execSyncFn: ((command: string) => {
      execCalls.push(command);
      return Buffer.from("");
    }) as never,
    spawnFn: ((_: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(2202) as never;
    }) as never
  });

  const threadId = await manager.spawn("claude", "pane_bridge");
  const instance = registry.get(threadId);

  assert.equal(threadId, "claude_01");
  assert.equal(instance?.tmux_pane, "agent_claude_01");
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0] ?? "", /tmux new-session -d -s agent_claude_01/);
  assert.deepEqual(spawnCalls[0], [
    "server",
    "--type=claude",
    "--tmux-session=agent_claude_01",
    "--",
    "claude",
    "--allowedTools",
    "Bash Edit Replace"
  ]);
});

test("attach + status + list + kill + restart lifecycle", async () => {
  const registry = new InstanceRegistry();
  const children = new Map<string, FakeChildProcess>();
  let spawnCounter = 0;

  const manager = new InstanceManager(registry, {
    spawnFn: ((_: string, args: string[]) => {
      spawnCounter += 1;
      const typeArg = args.find((arg) => arg.startsWith("--type=")) ?? "--type=codex";
      const type = typeArg.split("=")[1] ?? "codex";
      const threadId = `${type}_01`;
      const child = new FakeChildProcess(3300 + spawnCounter);
      children.set(threadId, child);
      return child as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "running", health: "ok" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");
  const attachResult = manager.attach(threadId, "chat-1");
  assert.equal(attachResult.thread_id, threadId);
  assert.equal(manager.getAttachedThread("chat-1"), threadId);

  const status = await manager.status(threadId);
  assert.equal(status.instance.status, "running");

  const listed = manager.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.thread_id, threadId);

  const restartedThread = await manager.restart(threadId);
  assert.equal(restartedThread, threadId);
  assert.equal(manager.getAttachedThread("chat-1"), threadId);
  assert.equal(registry.get(threadId)?.status, "idle");

  await manager.kill(threadId);
  assert.equal(registry.has(threadId), false);
  assert.equal(manager.getAttachedThread("chat-1"), null);
});
