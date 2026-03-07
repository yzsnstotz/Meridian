import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
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

function socketPathForThread(threadId: string): string {
  return path.join("/tmp", `agentapi-${threadId}.sock`);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const socketModeOptions = {
  agentapiSocketSupport: true,
  agentapiAttachSocketSupport: true
} as const;

test("spawn registers instance and uses bridge args", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: Array<{ command: string; args: string[]; detached?: boolean }> = [];

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[], options?: { detached?: boolean }) => {
      spawnCalls.push({ command, args, detached: options?.detached });
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
  const socketPath = socketPathForThread(threadId);

  assert.equal(threadId, "codex_01");
  assert.equal(instance?.socket_path, socketPath);
  assert.equal(instance?.pid, 1101);
  assert.equal(instance?.restart_safe, true);
  assert.equal(spawnCalls[0]?.detached, true);
  assert.deepEqual(spawnCalls[0]?.args, ["server", "--type=codex", `--socket=${socketPath}`, "--", "codex"]);
});

test("spawn falls back to --port when server does not support --socket", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    agentapiSocketSupport: false,
    spawnFn: ((_: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(1111) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");
  const instance = registry.get(threadId);
  const portArg = spawnCalls[0]?.find((arg) => arg.startsWith("--port="));

  assert.equal(threadId, "codex_01");
  assert.match(portArg ?? "", /^--port=\d+$/);
  assert.match(instance?.socket_path ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("spawn forwards selected model to provider CLI", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((_: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(1102) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge", undefined, "gpt-5.4");

  assert.equal(threadId, "codex_01");
  assert.equal(registry.get(threadId)?.model_id, "gpt-5.4");
  assert.deepEqual(spawnCalls[0], [
    "server",
    "--type=codex",
    `--socket=${socketPathForThread(threadId)}`,
    "--",
    "codex",
    "--model",
    "gpt-5.4"
  ]);
});

test("spawn claude bridge includes --allowedTools args", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
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
  const socketPath = socketPathForThread(threadId);
  assert.equal(threadId, "claude_01");
  assert.deepEqual(spawnCalls[0], [
    "server",
    "--type=claude",
    `--socket=${socketPath}`,
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
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
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
  const socketPath = socketPathForThread(threadId);

  assert.equal(threadId, "claude_01");
  assert.equal(instance?.tmux_pane, "agent_claude_01");
  assert.equal(instance?.pid, 2202);
  assert.equal(instance?.socket_path, socketPath);
  assert.equal(execCalls.length, 6);
  assert.match(execCalls[0] ?? "", /tmux kill-session -t .*agent_claude_01/);
  assert.match(execCalls[1] ?? "", /tmux new-session -d -s .*agent_claude_01/);
  assert.match(execCalls[1] ?? "", /'attach'/);
  assert.match(execCalls[1] ?? "", new RegExp(`'--socket=${escapeForRegExp(socketPath)}'`));
  assert.match(execCalls[2] ?? "", /tmux set-option -t .*agent_claude_01.* history-limit 200000/);
  assert.match(execCalls[3] ?? "", /tmux set-window-option -t .*agent_claude_01.* alternate-screen off/);
  assert.match(execCalls[4] ?? "", /tmux set-option -t .*agent_claude_01.* mouse on/);
  assert.match(execCalls[5] ?? "", /tmux pipe-pane -o -t .*agent_claude_01/);
  assert.match(execCalls[5] ?? "", /pane-claude_01\.log/);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.command, "/Users/yzliu/work/Meridian/bin/agentapi");
  assert.deepEqual(spawnCalls[0]?.args, [
    "server",
    "--type=claude",
    `--socket=${socketPath}`,
    "--",
    "claude",
    "--allowedTools",
    "Bash Edit Replace"
  ]);
});

test("pane_bridge uses attach --url when running in port mode", async () => {
  const registry = new InstanceRegistry();
  const execCalls: string[] = [];

  const manager = new InstanceManager(registry, {
    agentapiSocketSupport: false,
    execSyncFn: ((command: string) => {
      execCalls.push(command);
      return Buffer.from("");
    }) as never,
    spawnFn: ((_: string, _args: string[]) => {
      return new FakeChildProcess(2212) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "pane_bridge");
  const instance = registry.get(threadId);

  assert.match(instance?.socket_path ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(execCalls[1] ?? "", /tmux new-session -d -s .*agent_codex_01/);
  assert.match(execCalls[1] ?? "", /'attach'/);
  assert.match(execCalls[1] ?? "", /'--url=http:\/\/127\.0\.0\.1:\d+'/);
});

test("sendTerminalInput forwards approval action to tmux pane", async () => {
  const registry = new InstanceRegistry();
  const execCalls: string[] = [];

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    execSyncFn: ((command: string) => {
      execCalls.push(command);
      return Buffer.from("");
    }) as never,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      return new FakeChildProcess(2203) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("cursor", "pane_bridge");
  execCalls.length = 0;

  const message = manager.sendTerminalInput(threadId, "allow");

  assert.equal(message, `Sent approval action 'allow' to ${threadId}.`);
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0] ?? "", /tmux send-keys -t .*agent_cursor_01.*'Tab'/);
});

test("sendTerminalInput rejects bridge threads", async () => {
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    execSyncFn: (() => Buffer.from("")) as never,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      return new FakeChildProcess(2204) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("cursor", "bridge");

  assert.throws(
    () => manager.sendTerminalInput(threadId, "run"),
    /\/approve requires a pane_bridge thread with tmux/
  );
});

test("spawn retries after transient readiness failure", async () => {
  const registry = new InstanceRegistry();
  let spawnCount = 0;
  let failReadiness = true;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    execSyncFn: (() => Buffer.from("")) as never,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
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
  assert.equal(registry.get(threadId)?.socket_path, socketPathForThread(threadId));

  await manager.kill(threadId);
});

test("spawn honors explicit working directory", async () => {
  const registry = new InstanceRegistry();
  let observedCwd: string | undefined;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
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
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
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

test("rehydrateFromState restores live instances and session bindings", async () => {
  const registry = new InstanceRegistry();
  const failingSocketPath = socketPathForThread("codex_02");
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    clientFactory: (threadId: string) => ({
      connect: async (endpoint: string) => {
        if (threadId === "codex_02" || endpoint === failingSocketPath) {
          throw new Error(`connect ENOENT ${failingSocketPath}`);
        }
      },
      disconnect: () => undefined,
      getStatus: async () => ({ status: "waiting" })
    })
  });

  const result = await manager.rehydrateFromState({
    version: 1,
    updated_at: new Date().toISOString(),
    instances: [
      {
        thread_id: "codex_01",
        agent_type: "codex",
        mode: "bridge",
        socket_path: socketPathForThread("codex_01"),
        working_dir: "/tmp",
        pid: 6501,
        tmux_pane: null,
        status: "idle",
        created_at: new Date().toISOString()
      },
      {
        thread_id: "codex_02",
        agent_type: "codex",
        mode: "bridge",
        socket_path: failingSocketPath,
        working_dir: "/tmp",
        pid: 6502,
        tmux_pane: null,
        status: "idle",
        created_at: new Date().toISOString()
      }
    ],
    session_bindings: {
      "777:chat-a": "codex_01",
      "777:chat-b": "codex_02"
    }
  });

  assert.deepEqual(result.restored_thread_ids, ["codex_01"]);
  assert.deepEqual(result.pruned_thread_ids, ["codex_02"]);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("codex_01")?.status, "waiting");
  assert.equal(manager.getAttachedThread("777:chat-a"), "codex_01");
  assert.equal(manager.getAttachedThread("777:chat-b"), null);
});

test("switchModel keeps thread id and updates selected model", async () => {
  const registry = new InstanceRegistry();
  let spawnCounter = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      spawnCounter += 1;
      return new FakeChildProcess(6400 + spawnCounter) as never;
    }) as never,
    execSyncFn: (() => Buffer.from("")) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "pane_bridge", undefined, "gpt-5");
  const switchedThread = await manager.switchModel(threadId, "codex-5.3-max");
  const switched = registry.get(switchedThread);

  assert.equal(switchedThread, threadId);
  assert.equal(switched?.thread_id, threadId);
  assert.equal(switched?.agent_type, "codex");
  assert.equal(switched?.model_id, "codex-5.3-max");
  assert.equal(switched?.mode, "pane_bridge");

  await manager.kill(threadId);
});

test("listModels returns provider catalog and current selection", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    model_id: "gpt-5.4",
    mode: "bridge",
    socket_path: socketPathForThread("codex_01"),
    pid: 100,
    tmux_pane: null,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    modelCatalog: {
      listModels: async () => ({
        provider: "codex",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4" },
          { id: "codex-5.3-max", label: "Codex-5.3-Max" }
        ]
      })
    } as never
  });

  const catalog = await manager.listModels("codex_01");

  assert.equal(catalog.provider, "codex");
  assert.equal(catalog.current_model_id, "gpt-5.4");
  assert.deepEqual(catalog.models, [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "codex-5.3-max", label: "Codex-5.3-Max" }
  ]);
});

test("attach enforces single interface owner per thread", async () => {
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      return new FakeChildProcess(7201) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");
  manager.attach(threadId, "777:chat-a");

  const attachment = manager.getThreadAttachment(threadId);
  assert.equal(attachment.interface_id, "777");
  assert.deepEqual(attachment.sessions, ["777:chat-a"]);
  assert.equal(manager.isThreadAttachableBySession(threadId, "777:chat-b"), true);
  assert.equal(manager.isThreadAttachableBySession(threadId, "888:chat-z"), false);

  manager.attach(threadId, "777:chat-b");
  assert.deepEqual(manager.getSessionsForThread(threadId).sort(), ["777:chat-a", "777:chat-b"]);

  assert.throws(() => manager.attach(threadId, "888:chat-z"), /already attached to interface=777/);

  await manager.kill(threadId);
});

test("spawn fails fast when child already exited before readiness polling", async () => {
  const registry = new InstanceRegistry();
  let connectCalls = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
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

test("kill removes the thread socket path", async () => {
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      const socketArg = args.find((arg) => arg.startsWith("--socket="));
      assert.ok(socketArg);
      const socketPath = socketArg.slice("--socket=".length);
      fs.writeFileSync(socketPath, "");
      return new FakeChildProcess(9404) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");
  const socketPath = socketPathForThread(threadId);
  assert.equal(fs.existsSync(socketPath), true);

  await manager.kill(threadId);
  assert.equal(fs.existsSync(socketPath), false);
});

test("crash exit preserves instance and session bindings for monitor alerting", async () => {
  const registry = new InstanceRegistry();
  const children = new Map<string, FakeChildProcess>();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      const child = new FakeChildProcess(9501);
      children.set("claude_01", child);
      return child as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("claude", "bridge");
  manager.attach(threadId, "777:chat-a");
  assert.equal(manager.getAttachedThread("777:chat-a"), threadId);

  // Simulate crash (SIGKILL)
  const child = children.get(threadId)!;
  child.exitCode = null;
  child.signalCode = "SIGKILL" as NodeJS.Signals;
  child.emit("exit", null, "SIGKILL");

  // Instance stays in registry with error status
  assert.equal(registry.has(threadId), true);
  assert.equal(registry.get(threadId)?.status, "error");

  // Session bindings preserved for monitor alerting
  assert.equal(manager.getAttachedThread("777:chat-a"), threadId);
  assert.deepEqual(manager.getSessionsForThread(threadId), ["777:chat-a"]);

  // Cleanup
  await manager.kill(threadId);
});

test("graceful exit (SIGTERM) unregisters instance and clears session bindings", async () => {
  const registry = new InstanceRegistry();
  const children = new Map<string, FakeChildProcess>();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      const child = new FakeChildProcess(9502);
      children.set("codex_01", child);
      return child as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");
  manager.attach(threadId, "777:chat-b");

  // Simulate graceful exit (SIGTERM from /kill)
  const child = children.get(threadId)!;
  child.exitCode = 0;
  child.signalCode = "SIGTERM";
  child.emit("exit", 0, "SIGTERM");

  // Instance removed from registry
  assert.equal(registry.has(threadId), false);

  // Session bindings cleared
  assert.equal(manager.getAttachedThread("777:chat-b"), null);
});
