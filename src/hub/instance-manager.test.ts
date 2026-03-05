import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { InstanceManager } from "./instance-manager";
import { InstanceRegistry } from "./registry";

class FakeChildProcess extends EventEmitter {
  pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.signalCode = signal ?? "SIGTERM";
    this.emit("exit", this.exitCode, this.signalCode);
    return true;
  }
}

test("spawn registers instance and uses bridge args", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: Array<{ command: string; args: string[] }> = [];

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 4101,
    spawnFn: ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return new FakeChildProcess(1101) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");
  const instance = registry.get(threadId);

  assert.equal(threadId, "codex_01");
  assert.equal(instance?.socket_path, "http://127.0.0.1:4101");
  assert.equal(instance?.pid, 1101);
  assert.deepEqual(spawnCalls[0]?.args, ["server", "--type=codex", "--port=4101", "--", "codex"]);
});

test("spawn claude bridge includes --allowedTools args", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 4202,
    spawnFn: ((_: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(1202) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("claude", "bridge");
  assert.equal(threadId, "claude_01");
  assert.deepEqual(spawnCalls[0], [
    "server",
    "--type=claude",
    "--port=4202",
    "--",
    "claude",
    "--allowedTools",
    "Bash Edit Replace"
  ]);
});

test("spawn pane_bridge starts interactive tmux CLI and attaches agentapi bridge", async () => {
  const registry = new InstanceRegistry();
  const execCalls: string[] = [];
  const spawnCalls: Array<{ command: string; args: string[] }> = [];

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 4303,
    paneBridgeUsePtyWrapper: false,
    execSyncFn: ((command: string) => {
      execCalls.push(command);
      return Buffer.from("");
    }) as never,
    spawnFn: ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return new FakeChildProcess(2202) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("claude", "pane_bridge");
  const instance = registry.get(threadId);

  assert.equal(threadId, "claude_01");
  assert.equal(instance?.tmux_pane, "agent_claude_01");
  assert.equal(instance?.pid, 2202);
  assert.equal(instance?.socket_path, "http://127.0.0.1:4303");
  assert.equal(execCalls.length, 3);
  assert.match(execCalls[0] ?? "", /tmux kill-session -t .*agent_claude_01/);
  assert.match(execCalls[1] ?? "", /tmux new-session -d -s .*agent_claude_01/);
  assert.match(execCalls[1] ?? "", /'attach'/);
  assert.match(execCalls[1] ?? "", /'--url=http:\/\/127.0.0.1:4303'/);
  assert.match(execCalls[2] ?? "", /tmux pipe-pane -o -t .*agent_claude_01/);
  assert.match(execCalls[2] ?? "", /pane-claude_01\.log/);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.command, "/Users/yzliu/work/Meridian/bin/agentapi");
  assert.deepEqual(spawnCalls[0]?.args, [
    "server",
    "--type=claude",
    "--port=4303",
    "--",
    "claude",
    "--allowedTools",
    "Bash Edit Replace"
  ]);
});

test("spawn retries after transient readiness failure", async () => {
  const registry = new InstanceRegistry();
  let spawnCount = 0;
  let failReadiness = true;

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 4400 + spawnCount,
    spawnFn: ((_: string, _args: string[]) => {
      spawnCount += 1;
      const child = new FakeChildProcess(2400 + spawnCount);
      if (spawnCount === 1) {
        setImmediate(() => {
          child.emit("exit", 1, null);
        });
      } else {
        failReadiness = false;
      }
      return child as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => {
        if (failReadiness) {
          throw new Error("connect ECONNREFUSED 127.0.0.1");
        }
      },
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("gemini", "bridge");
  assert.equal(threadId, "gemini_01");
  assert.equal(spawnCount, 2);
  assert.equal(registry.get(threadId)?.socket_path, "http://127.0.0.1:4401");

  await manager.kill(threadId);
});

test("spawn honors explicit working directory", async () => {
  const registry = new InstanceRegistry();
  let observedCwd: string | undefined;

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 4555,
    spawnFn: ((command: string, args: string[], options?: { cwd?: string }) => {
      void command;
      void args;
      observedCwd = options?.cwd;
      return new FakeChildProcess(2555) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge", "/tmp");
  assert.equal(threadId, "codex_01");
  assert.equal(observedCwd, "/tmp");

  await manager.kill(threadId);
});

test("attach + status + list + kill + restart lifecycle", async () => {
  const registry = new InstanceRegistry();
  const children = new Map<string, FakeChildProcess>();
  let spawnCounter = 0;

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 5000 + spawnCounter,
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

test("switchModel keeps thread id and updates agent type", async () => {
  const registry = new InstanceRegistry();
  let spawnCounter = 0;

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 5400 + spawnCounter,
    spawnFn: ((_: string, args: string[]) => {
      spawnCounter += 1;
      return new FakeChildProcess(6400 + spawnCounter) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "pane_bridge");
  const switchedThread = await manager.switchModel(threadId, "gemini");
  const switched = registry.get(switchedThread);

  assert.equal(switchedThread, threadId);
  assert.equal(switched?.thread_id, threadId);
  assert.equal(switched?.agent_type, "gemini");
  assert.equal(switched?.mode, "pane_bridge");

  await manager.kill(threadId);
});

test("spawn fails fast when child already exited before readiness polling", async () => {
  const registry = new InstanceRegistry();
  let connectCalls = 0;

  const manager = new InstanceManager(registry, {
    portAllocator: async () => 6303,
    spawnFn: ((_: string, _args: string[]) => {
      const child = new FakeChildProcess(9303);
      child.exitCode = 1;
      child.signalCode = null;
      return child as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => {
        connectCalls += 1;
      },
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  await assert.rejects(
    async () => await manager.spawn("gemini", "bridge"),
    /exited before readiness check succeeded \(exit_code=1, signal=null\)/
  );
  assert.equal(connectCalls, 0);
});
