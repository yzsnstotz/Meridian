import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { buildClaudeStreamArgs, DEFAULT_CLAUDE_ALLOWED_TOOLS } from "../agents/claude";
import { InstanceManager } from "./instance-manager";
import { InstanceRegistry } from "./registry";

class FakeChildProcess extends EventEmitter {
  pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

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

const socketModeOptions = {
  agentapiSocketSupport: true,
  agentapiAttachSocketSupport: true
} as const;

test("spawn registers a streaming-bridge codex instance without launching agentapi", async () => {
  // After the 2026-05-20 streaming-default change, codex/claude/gemini in
  // `bridge` mode are metadata-only: no agentapi child is forked at spawn,
  // and pid/socket_path stay null. Per-turn LLM work is forked by
  // tryHandleStreamRun via `codex exec --json`.
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

  assert.equal(threadId, "codex_01");
  assert.equal(spawnCalls.length, 0, "no agentapi child should be forked for stream-capable bridge agents");
  assert.equal(instance?.mode, "bridge");
  assert.equal(instance?.socket_path, null);
  assert.equal(instance?.pid, null);
  assert.equal(instance?.restart_safe, true);
  assert.equal(instance?.supportsStream, true);

  await manager.kill(threadId);
  assert.equal(registry.get(threadId), undefined);
});

test("spawn skips the agentapi child for every stream-capable bridge agent (codex / claude / gemini)", async () => {
  // Single test that pins the streaming-default invariant across all three
  // stream-capable agent types: no agentapi process is ever forked at
  // spawn-time. Per-turn LLM work is forked by tryHandleStreamRun via
  // `spawnStreamAgent`, not by this path.
  for (const agentType of ["codex", "claude", "gemini"] as const) {
    const registry = new InstanceRegistry();
    let spawnCalls = 0;

    const manager = new InstanceManager(registry, {
      ...socketModeOptions,
      socketPathFactory: socketPathForThread,
      spawnFn: (() => {
        spawnCalls += 1;
        return new FakeChildProcess(1100) as never;
      }) as never,
      clientFactory: () => ({
        connect: async () => undefined,
        disconnect: () => undefined,
        getStatus: async () => ({ status: "idle" })
      })
    });

    const threadId = await manager.spawn(agentType, "bridge");
    const instance = registry.get(threadId);

    assert.equal(
      spawnCalls,
      0,
      `${agentType} bridge spawn must not fork an agentapi child (streaming-default)`
    );
    assert.equal(instance?.agent_type, agentType);
    assert.equal(instance?.mode, "bridge");
    assert.equal(instance?.pid, null, `${agentType} streaming-bridge must have pid=null`);
    assert.equal(instance?.socket_path, null, `${agentType} streaming-bridge must have socket_path=null`);
    assert.equal(instance?.supportsStream, true);
    assert.equal(instance?.status, "idle");

    await manager.kill(threadId);
  }
});

test("kill removes a streaming-bridge registry entry without process kill or socket unlink", async () => {
  // Streaming-bridge kill is metadata-only: drop the registry entry, fire
  // onStateChange, clear session bindings. No child process is signaled and
  // no socket file is unlinked because neither exists.
  const registry = new InstanceRegistry();
  let spawnCalls = 0;
  let stateChangeCount = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => {
      spawnCalls += 1;
      return new FakeChildProcess(1109) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });
  manager.setOnStateChange(() => {
    stateChangeCount += 1;
  });

  const threadId = await manager.spawn("codex", "bridge");
  manager.attach(threadId, "777:chat-stream");
  assert.equal(manager.getAttachedThread("777:chat-stream"), threadId);
  assert.equal(spawnCalls, 0, "spawn must not have forked anything");

  const stateChangesAfterSpawn = stateChangeCount;
  await manager.kill(threadId);

  assert.equal(registry.get(threadId), undefined, "registry entry must be removed");
  assert.equal(manager.getAttachedThread("777:chat-stream"), null, "session binding must be cleared");
  assert.ok(stateChangeCount > stateChangesAfterSpawn, "kill must fire onStateChange so disk view tracks the removal");
});

test("spawn registers stateless_call codex instance without launching AgentAPI", async () => {
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((_command: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(1150) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "stateless_call", undefined, "gpt-5.4", true, "xhigh");
  const instance = registry.get(threadId);
  const status = await manager.status(threadId);

  assert.equal(threadId, "codex_01");
  assert.equal(spawnCalls.length, 0);
  assert.equal(instance?.mode, "stateless_call");
  assert.equal(instance?.socket_path, "stateless:codex_01");
  assert.equal(instance?.pid, 0);
  assert.equal(instance?.supportsStream, true);
  assert.equal(instance?.auto_approve, false);
  assert.equal(instance?.sandbox_mode, "read-only");
  assert.equal(instance?.model_id, "gpt-5.4");
  assert.equal(instance?.reasoning_effort, "xhigh");
  assert.deepEqual(status.agent_status, {
    status: "idle",
    mode: "stateless_call",
    stateless: true,
    current_model_id: "gpt-5.4"
  });

  await manager.kill(threadId);
  assert.equal(registry.get(threadId), undefined);
});

test("describeSpawnInvocation exposes the codex-exec command for streaming-bridge instances", async () => {
  // Streaming-bridge codex/claude/gemini have no agentapi pane to describe.
  // The agent card surfaces the per-turn `codex exec --json` invocation that
  // tryHandleStreamRun forks for every /api/run.
  const registry = new InstanceRegistry();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => {
      return new FakeChildProcess(1401) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge", undefined, "gpt-5.4", true, "high");
  const instance = registry.get(threadId);
  assert.ok(instance);

  const invocation = manager.describeSpawnInvocation(instance);
  assert.equal(invocation.command, "codex");
  assert.deepEqual(invocation.provider_args, [
    "codex",
    "exec",
    "--json",
    "-c",
    'model_reasoning_effort="high"',
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check"
  ]);
  assert.equal(
    invocation.provider_append,
    'codex exec --json -c model_reasoning_effort="high" --model gpt-5.4 --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check'
  );

  await manager.kill(threadId);
});

test("spawn rejects stateless_call for non-Codex providers", async () => {
  const registry = new InstanceRegistry();
  let spawnCalls = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    spawnFn: (() => {
      spawnCalls += 1;
      return new FakeChildProcess(1160) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  await assert.rejects(
    async () => await manager.spawn("claude", "stateless_call"),
    /stateless_call mode is only supported for codex/
  );
  assert.equal(spawnCalls, 0);
});

test("spawn does not reuse a thread id after a graceful kill", async () => {
  const registry = new InstanceRegistry();
  let nextPid = 1200;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => {
      nextPid += 1;
      return new FakeChildProcess(nextPid) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const firstThreadId = await manager.spawn("codex", "bridge");
  await manager.kill(firstThreadId);

  const secondThreadId = await manager.spawn("codex", "bridge");

  assert.equal(firstThreadId, "codex_01");
  assert.equal(secondThreadId, "codex_02");

  await manager.kill(secondThreadId);
});

test("spawn stores spawn_trace_id on instance and registry when provided", async () => {
  const registry = new InstanceRegistry();
  const traceId = "11111111-1111-4111-8111-111111111111";

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((_command: string, _args: string[], _options?: { detached?: boolean }) => {
      return new FakeChildProcess(1102) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge", undefined, undefined, undefined, undefined, traceId);
  assert.equal(registry.get(threadId)?.spawn_trace_id, traceId);

  await manager.kill(threadId);
});

test("spawn falls back to --port when server does not support --socket (cursor)", async () => {
  // Cursor is the only remaining non-streaming bridge agent, so it still
  // exercises the agentapi endpoint-binding path. codex/claude/gemini bridge
  // no longer spawn an agentapi pane (streaming-default change).
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

  const threadId = await manager.spawn("cursor", "bridge");
  const instance = registry.get(threadId);
  const portArg = spawnCalls[0]?.find((arg) => arg.startsWith("--port="));

  assert.equal(threadId, "cursor_01");
  assert.match(portArg ?? "", /^--port=\d+$/);
  assert.match(instance?.socket_path ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);

  await manager.kill(threadId);
});

test("spawn forwards selected model and reasoning effort into the streaming-bridge codex-exec invocation", async () => {
  // Streaming-bridge codex does not spawn an agentapi child, but model/effort
  // selections must be persisted on the registry so the per-turn
  // `codex exec --json` (forked by tryHandleStreamRun) and the GUI's agent
  // card (via describeSpawnInvocation) receive them.
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

  const threadId = await manager.spawn("codex", "bridge", undefined, "gpt-5.4", true, "xhigh");
  const instance = registry.get(threadId);
  assert.ok(instance);

  assert.equal(threadId, "codex_01");
  assert.equal(spawnCalls.length, 0, "streaming-bridge codex must not fork an agentapi child");
  assert.equal(instance.model_id, "gpt-5.4");
  assert.equal(instance.reasoning_effort, "xhigh");
  assert.equal(instance.auto_approve, true);

  const invocation = manager.describeSpawnInvocation(instance);
  assert.deepEqual(invocation.provider_args, [
    "codex",
    "exec",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check"
  ]);

  await manager.kill(threadId);
});

test("spawn stores auto_approve in the registry when requested", async () => {
  // Streaming-bridge claude is metadata-only; auto_approve still has to land
  // on the registry so the per-turn provider CLI receives the bypass flag.
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((_: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(1103) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("claude", "bridge", undefined, undefined, true);
  const instance = registry.get(threadId);

  assert.equal(threadId, "claude_01");
  assert.equal(spawnCalls.length, 0, "streaming-bridge claude must not fork an agentapi child");
  assert.equal(instance?.auto_approve, true);
  assert.equal(instance?.pid, null);
  assert.equal(instance?.socket_path, null);
  assert.equal(instance?.supportsStream, true);

  await manager.kill(threadId);
});

test("spawn stores integration_profile and sandbox_mode on the registry instance", async () => {
  // Streaming-bridge codex skips the agentapi fork, but integration_profile
  // and sandbox_mode still need to round-trip through the registry so the
  // per-turn `codex exec --json` (and the GUI agent card) see them.
  const registry = new InstanceRegistry();
  const spawnCalls: string[][] = [];

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((_: string, args: string[]) => {
      spawnCalls.push(args);
      return new FakeChildProcess(1104) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn(
    "codex",
    "bridge",
    undefined,
    undefined,
    false,
    undefined,
    null,
    "ads_public",
    "read-only"
  );
  const instance = registry.get(threadId);
  assert.ok(instance);

  assert.equal(threadId, "codex_01");
  assert.equal(spawnCalls.length, 0, "streaming-bridge codex must not fork an agentapi child");
  assert.equal(instance.integration_profile, "ads_public");
  assert.equal(instance.sandbox_mode, "read-only");

  const invocation = manager.describeSpawnInvocation(instance);
  assert.deepEqual(invocation.provider_args, [
    "codex",
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check"
  ]);

  await manager.kill(threadId);
});

test("spawn rejects unsupported providers for read-only sandbox mode", async () => {
  const registry = new InstanceRegistry();
  let spawnCalls = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => {
      spawnCalls += 1;
      return new FakeChildProcess(1105) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  await assert.rejects(
    async () => await manager.spawn("gemini", "bridge", undefined, undefined, false, undefined, null, "ads_public", "read-only"),
    /Agent type does not support read-only sandbox mode/
  );
  assert.equal(spawnCalls, 0);
});

// Deleted 2026-05-21: `spawn claude bridge includes --allowedTools args`,
// `spawn claude bridge threads reasoning_effort to the CLI --effort flag`,
// `spawn codex bridge includes auto-approve flag when requested`. All three
// asserted agentapi-pane spawn arguments for claude/codex bridge mode. The
// streaming-default change makes these instances metadata-only — no
// agentapi child is forked at spawn-time, so the assertions describe
// behavior that no longer exists. The provider-CLI arg construction is
// still covered by:
//   - `buildClaudeStreamArgs` (tested via `spawnStreamAgent launches a provider CLI directly` below)
//   - `buildCodexExecArgs`     (tested via `describeSpawnInvocation exposes the codex-exec command for streaming-bridge instances`
//                              and `spawn forwards selected model and reasoning effort into the streaming-bridge codex-exec invocation`)

test("spawnStreamAgent launches a provider CLI directly and pipes the prompt over stdin", () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "claude_01",
    agent_type: "claude",
    mode: "bridge",
    socket_path: "/tmp/agentapi-claude_01.sock",
    working_dir: "/tmp",
    pid: 999,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const spawnCalls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
  const child = new FakeChildProcess(3301);
  const manager = new InstanceManager(registry, {
    spawnFn: ((command: string, args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      return child as never;
    }) as never
  });

  const result = manager.spawnStreamAgent(
    "claude_01",
    "claude",
    buildClaudeStreamArgs("claude-3", true),
    "Summarize this"
  );

  assert.equal(result.process, child);
  assert.equal(result.stdout, child.stdout);
  assert.equal(spawnCalls[0]?.command, "claude");
  assert.deepEqual(spawnCalls[0]?.args, [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--allowedTools",
    DEFAULT_CLAUDE_ALLOWED_TOOLS.join(" "),
    "--model",
    "claude-3",
    "--dangerously-skip-permissions"
  ]);
  assert.equal(spawnCalls[0]?.options?.cwd, "/tmp");
  assert.deepEqual(spawnCalls[0]?.options?.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(child.stdin.read()?.toString("utf8"), "Summarize this");
});

test("interrupt sends raw Escape through AgentAPI for bridge threads without unregistering thread", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_01.sock",
    pid: 2302,
    status: "running",
    created_at: new Date().toISOString()
  });
  const rawInputs: string[] = [];
  const connected: string[] = [];
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    execSyncFn: (() => Buffer.from("")) as never,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      return new FakeChildProcess(2302) as never;
    }) as never,
    clientFactory: () => ({
      connect: async (endpoint: string) => {
        connected.push(endpoint);
      },
      disconnect: () => undefined,
      getStatus: async () => ({ status: "running" }),
      sendRawInput: async (content: string) => {
        rawInputs.push(content);
        return { ok: true };
      }
    })
  });

  const message = await manager.interrupt("codex_01");

  assert.equal(message, "Sent interrupt to codex_01.");
  assert.equal(registry.has("codex_01"), true);
  assert.deepEqual(connected, ["/tmp/agentapi-codex_01.sock"]);
  assert.deepEqual(rawInputs, ["\u001b"]);
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
    /is no longer supported/
  );

  await manager.kill(threadId);
});

test("spawn retries after transient readiness failure (cursor)", async () => {
  // Only `cursor` still spawns an agentapi pane (non-streaming bridge), so
  // the readiness-retry path is now cursor-only. Streaming-bridge codex /
  // claude / gemini are metadata-only and have no readiness probe to retry.
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

  const threadId = await manager.spawn("cursor", "bridge");
  assert.equal(threadId, "cursor_01");
  assert.equal(spawnCount, 2);
  assert.equal(registry.get(threadId)?.socket_path, socketPathForThread(threadId));

  await manager.kill(threadId);
});

test("spawn honors explicit working directory", async () => {
  // Streaming-bridge codex stores working_dir on the registry (no agentapi
  // spawn). The per-turn `codex exec --json` fork — see `spawnStreamAgent`
  // — reads `instance.working_dir` as its cwd. Cursor's cwd hand-off
  // through spawnFn is covered separately by the cursor lifecycle tests.
  const registry = new InstanceRegistry();
  let spawnCalls = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      spawnCalls += 1;
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
  assert.equal(spawnCalls, 0, "streaming-bridge codex must not fork an agentapi child");
  assert.equal(registry.get(threadId)?.working_dir, "/tmp");

  await manager.kill(threadId);
});

test("attach + status + list + kill + restart lifecycle (cursor)", async () => {
  // Lifecycle test for the agentapi-pane path. Cursor is the one remaining
  // non-streaming bridge agent that still spawns a pane, polls it via
  // client.getStatus(), and unlinks a socket on kill. Streaming-bridge
  // codex/claude/gemini are exercised by the dedicated streaming-bridge
  // spawn/kill tests at the top of this file.
  const registry = new InstanceRegistry();
  const children = new Map<string, FakeChildProcess>();
  let spawnCounter = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      spawnCounter += 1;
      const typeArg = args.find((arg) => arg.startsWith("--type=")) ?? "--type=cursor";
      const type = typeArg.split("=")[1] ?? "cursor";
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

  const threadId = await manager.spawn("cursor", "bridge");
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

test("status persists the live current model reported by agentapi (cursor)", async () => {
  // Live-model probing only runs against an agentapi pane. Streaming-bridge
  // codex/claude/gemini have no pane to probe, so status() returns the
  // registry's last-known model. Cursor still spawns a pane and exercises
  // the live-status → registry write-through path.
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((_command: string, _args: string[]) => {
      return new FakeChildProcess(3401) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({
        status: "running",
        current_model_id: "gpt-5.4"
      })
    })
  });

  const threadId = await manager.spawn("cursor", "bridge");
  const status = await manager.status(threadId);

  assert.equal(status.instance.model_id, "gpt-5.4");
  assert.equal(registry.get(threadId)?.model_id, "gpt-5.4");

  await manager.kill(threadId);
});

test("status normalizes stable agentapi state to waiting", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: socketPathForThread("codex_01"),
    pid: 3402,
    status: "running",
    created_at: new Date().toISOString()
  });

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({
        status: "stable",
        agent_type: "codex"
      })
    })
  });

  const status = await manager.status("codex_01");

  assert.equal(status.instance.status, "waiting");
  assert.equal(registry.get("codex_01")?.status, "waiting");
});

test("status infers the live current model from agent messages when status omits it (cursor)", async () => {
  // Pane-message model inference still belongs to the agentapi-pane path.
  // Cursor is the only agent type that still owns a pane; codex/claude/gemini
  // bridge instances do not probe a pane at all (streaming-default), so
  // status() returns the registry's last-known model for them.
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((_command: string, _args: string[]) => {
      return new FakeChildProcess(3402) as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({
        status: "running",
        agent_type: "cursor"
      }),
      getMessages: async () => ([
        {
          id: 0,
          role: "agent",
          content: [
            "╭─────────────────────────────────────────────╮",
            "│ >_ Cursor Agent                             │",
            "│                                             │",
            "│ model:     gpt-5.4 xhigh   /model to change │",
            "│ directory: ~/work/projects/clawso           │",
            "╰─────────────────────────────────────────────╯"
          ].join("\n")
        }
      ])
    })
  });

  const threadId = await manager.spawn("cursor", "bridge");
  const status = await manager.status(threadId);

  assert.equal(status.instance.model_id, "gpt-5.4");
  assert.equal(status.agent_status.current_model_id, "gpt-5.4");
  assert.equal(registry.get(threadId)?.model_id, "gpt-5.4");

  await manager.kill(threadId);
});

// Deleted 2026-05-21: `status infers the live Claude model from the interactive
// banner when status omits it`. Claude bridge is now streaming-only, with no
// agentapi pane to probe — status() never reads claude pane messages. The
// claude-banner regex itself is still covered by direct
// `extractReportedModelIdFromText` callers (listModels backfill path) if a
// future codepath surfaces it. No streaming-bridge equivalent exists because
// the streaming `codex exec --json` stream emits model metadata as JSON
// events (handled by stream-run code, not by InstanceManager.status).

test("rehydrateFromState restores live instances and session bindings", async () => {
  const registry = new InstanceRegistry();
  const failingSocketPath = socketPathForThread("codex_02");
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    // Fake pids in tests are not real OS processes — bypass the PID
    // liveness shortcut so the probe path is what's exercised here.
    pidLivenessFn: () => true,
    rehydrateProbeRetries: 1,
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
    version: 4,
    updated_at: new Date().toISOString(),
    instances: [
      {
        thread_id: "codex_01",
        agent_type: "codex",
        mode: "bridge",
        socket_path: socketPathForThread("codex_01"),
        working_dir: "/tmp",
        pid: 6501,
            status: "idle",
        created_at: new Date().toISOString(),
        auto_approve: false
      },
      {
        thread_id: "codex_02",
        agent_type: "codex",
        mode: "bridge",
        socket_path: failingSocketPath,
        working_dir: "/tmp",
        pid: 6502,
            status: "idle",
        created_at: new Date().toISOString(),
        auto_approve: false
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

test("rehydrateFromState does NOT carry the thread allocator counter across a restart with no live instances", async () => {
  // Regression: previously, the allocator was seeded from every persisted
  // thread_id (instances, session_bindings, push_subscriptions,
  // conversation_history) — including ids whose underlying agent process
  // had died with the prior service. That made the Hub keep stacking
  // thread_ids (codex_142, codex_143, ...) across restarts even when the
  // user expected a fresh counter. Now a restart with zero rehydrated
  // instances allocates the next id from 01.
  const registry = new InstanceRegistry();
  const nowIso = new Date().toISOString();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => new FakeChildProcess(6601) as never) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  await manager.rehydrateFromState({
    version: 4,
    updated_at: nowIso,
    instances: [],
    session_bindings: {},
    push_subscriptions: {},
    conversation_history: {
      codex_14: [
        {
          id: "history-1",
          sequence: 1,
          event_kind: "final_reply",
          source: "codex",
          content: "done",
          details_text: "",
          raw_content: "done",
          trace_id: null,
          timestamp: nowIso,
          replace_key: null
        }
      ]
    }
  });

  const threadId = await manager.spawn("codex", "bridge");

  assert.equal(threadId, "codex_01");

  await manager.kill(threadId);
});

test("rehydrateFromState drops persisted stateless_call instances instead of zombie-restoring them", async () => {
  // Regression: previously stateless_call instances unconditionally
  // survived rehydrate with `pid: 0`, even though the actual ephemeral
  // codex exec process had exited with the prior service. Those zombies
  // (a) kept appearing in /api/instances → dismissed stateless cards
  // revived on every restart, and (b) seeded nextThreadId via
  // registry.list(), keeping the thread allocator counter elevated
  // even after the prior allocator-counter fix.
  const registry = new InstanceRegistry();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => new FakeChildProcess(6603) as never) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await manager.rehydrateFromState({
    version: 4,
    updated_at: new Date().toISOString(),
    instances: [
      {
        thread_id: "codex_05",
        agent_type: "codex",
        mode: "stateless_call",
        socket_path: "stateless:codex_05",
        working_dir: "/tmp",
        pid: 6800,
            status: "idle",
        created_at: new Date().toISOString(),
        auto_approve: false
      },
      {
        thread_id: "codex_06",
        agent_type: "codex",
        mode: "stateless_call",
        socket_path: "stateless:codex_06",
        working_dir: "/tmp",
        pid: 6801,
            status: "running",
        created_at: new Date().toISOString(),
        auto_approve: false
      }
    ],
    session_bindings: {}
  });

  assert.deepEqual(result.restored_thread_ids, []);
  assert.deepEqual(result.pruned_thread_ids, ["codex_05", "codex_06"]);
  assert.equal(registry.list().length, 0);

  // Allocator must start fresh because no stateless instance survived.
  const threadId = await manager.spawn("codex", "bridge");
  assert.equal(threadId, "codex_01");

  await manager.kill(threadId);
});

test("rehydrateFromState keeps the allocator above live rehydrated instances to avoid id reuse", async () => {
  const registry = new InstanceRegistry();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    pidLivenessFn: () => true,
    spawnFn: (() => new FakeChildProcess(6602) as never) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  await manager.rehydrateFromState({
    version: 4,
    updated_at: new Date().toISOString(),
    instances: [
      {
        thread_id: "codex_07",
        agent_type: "codex",
        mode: "bridge",
        socket_path: socketPathForThread("codex_07"),
        working_dir: "/tmp",
        pid: 6700,
            status: "idle",
        created_at: new Date().toISOString(),
        auto_approve: false
      }
    ],
    session_bindings: {},
    push_subscriptions: {}
  });

  // codex_07 successfully rehydrated, so the next spawn must skip past it
  // even though the persisted-state seeding has been removed.
  const threadId = await manager.spawn("codex", "bridge");

  assert.equal(threadId, "codex_08");

  await manager.kill("codex_07");
  await manager.kill(threadId);
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

  const threadId = await manager.spawn("codex", "bridge", undefined, "gpt-5", undefined, "high");
  const switchedThread = await manager.switchModel(threadId, "codex-5.3-max");
  const switched = registry.get(switchedThread);

  assert.equal(switchedThread, threadId);
  assert.equal(switched?.thread_id, threadId);
  assert.equal(switched?.agent_type, "codex");
  assert.equal(switched?.model_id, "codex-5.3-max");
  assert.equal(switched?.mode, "bridge");
  assert.equal(switched?.reasoning_effort, "high");

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

test("listModels backfills the current model from live status when the registry has none", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: socketPathForThread("codex_01"),
    pid: 100,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({
        status: "idle",
        model: "gpt-5.4"
      })
    }),
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

  assert.equal(catalog.current_model_id, "gpt-5.4");
  assert.equal(registry.get("codex_01")?.model_id, "gpt-5.4");
});

test("listModels backfills the current model from live messages when status omits it", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_01",
    agent_type: "codex",
    mode: "bridge",
    socket_path: socketPathForThread("codex_01"),
    pid: 100,
    status: "idle",
    created_at: new Date().toISOString()
  });

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({
        status: "idle",
        agent_type: "codex"
      }),
      getMessages: async () => ([
        {
          id: 0,
          role: "agent",
          content: "  gpt-5.4 xhigh · ~/work/projects/clawso"
        }
      ])
    }),
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

  assert.equal(catalog.current_model_id, "gpt-5.4");
  assert.equal(registry.get("codex_01")?.model_id, "gpt-5.4");
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

test("spawn fails fast when child already exited before readiness polling (cursor)", async () => {
  // Readiness polling only runs for cursor (the one remaining non-streaming
  // bridge agent). Streaming-bridge codex/claude/gemini have no readiness
  // wait — they register as pure metadata.
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
    async () => await manager.spawn("cursor", "bridge"),
    /exited before readiness check succeeded \(exit_code=1, signal=null\)/
  );
  assert.equal(connectCalls, 0);
});

test("kill removes the thread socket path (cursor)", async () => {
  // Socket unlink on kill is part of the agentapi-pane teardown path.
  // Streaming-bridge codex/claude/gemini never have a socket file to unlink
  // (their `socket_path` stays null) — see the dedicated streaming-bridge
  // kill test added below.
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

  const threadId = await manager.spawn("cursor", "bridge");
  const socketPath = socketPathForThread(threadId);
  assert.equal(fs.existsSync(socketPath), true);

  await manager.kill(threadId);
  assert.equal(fs.existsSync(socketPath), false);
});

test("crash exit preserves instance and session bindings for monitor alerting (cursor)", async () => {
  // Child crash/exit handlers only run for agentapi-pane bridge agents.
  // Streaming-bridge codex/claude/gemini have no child process to crash;
  // their lifecycle is driven by registry register/unregister calls only.
  const registry = new InstanceRegistry();
  const children = new Map<string, FakeChildProcess>();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      const child = new FakeChildProcess(9501);
      children.set("cursor_01", child);
      return child as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("cursor", "bridge");
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

test("graceful exit (SIGTERM) unregisters instance and clears session bindings (cursor)", async () => {
  // SIGTERM child-exit handling is only meaningful for the agentapi-pane
  // path. Streaming-bridge agents have no child to receive SIGTERM; their
  // unregister/clear-bindings path is exercised by the dedicated
  // streaming-bridge kill test added below.
  const registry = new InstanceRegistry();
  const children = new Map<string, FakeChildProcess>();

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: ((command: string, args: string[]) => {
      void command;
      void args;
      const child = new FakeChildProcess(9502);
      children.set("cursor_01", child);
      return child as never;
    }) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("cursor", "bridge");
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

test("spawn sets spawned_by from caller parameter", async () => {
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => new FakeChildProcess(9901) as never) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const caller = { caller_id: "meridian-roles", caller_label: "Meridian Roles" };
  const threadId = await manager.spawn("codex", "bridge", undefined, undefined, undefined, undefined, null, undefined, undefined, caller);
  const instance = registry.get(threadId);

  assert.equal(instance?.spawned_by?.caller_id, "meridian-roles");
  assert.equal(instance?.spawned_by?.caller_label, "Meridian Roles");

  await manager.kill(threadId);
});

test("spawn without caller leaves spawned_by undefined", async () => {
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => new FakeChildProcess(9902) as never) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");
  const instance = registry.get(threadId);

  assert.equal(instance?.spawned_by, undefined);

  await manager.kill(threadId);
});

test("waitForChildExit does not short-circuit on child.killed before the process actually exits", async () => {
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {});

  // Node's `subprocess.killed` becomes true as soon as `kill(sig)` successfully
  // delivers a signal — it does NOT mean the process has exited. This child
  // mirrors that: kill() flips `killed` and the public exit fields stay null
  // until we explicitly emit exit. PID is set to an arbitrary unreachable
  // value so the escalation path's process.kill probes are no-ops.
  const stuckChild = new FakeChildProcess(2_147_483_640);
  stuckChild.kill = function (): boolean {
    this.killed = true;
    return true;
  };

  stuckChild.kill("SIGTERM");

  let resolved = false;
  const wait = (manager as unknown as {
    waitForChildExit: (child: unknown, threadId: string, timeoutMs?: number) => Promise<void>;
  })
    .waitForChildExit(stuckChild, "stuck_thread", 200)
    .then(() => {
      resolved = true;
    });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    resolved,
    false,
    "waitForChildExit returned before child exited — child.killed early-return regression"
  );

  stuckChild.exitCode = 0;
  stuckChild.signalCode = "SIGKILL";
  stuckChild.emit("exit", 0, "SIGKILL");

  await wait;
  assert.equal(resolved, true);
});

test("rehydrateFromState fast-prunes instances whose PID is no longer alive without probing", async () => {
  // Regression for the architectural storm root cause (§C-2 candidate a/b):
  // when state.json carries a stale pid whose process the OS has already
  // reaped, the rehydrate probe used to try to connect anyway, log a
  // confusing "probe failed" warning, and leave the orphan socket file on
  // disk. Now the PID check shortcuts the entire probe and unlinks the
  // socket — no probe budget burned, no orphan socket left behind.
  const registry = new InstanceRegistry();
  let probeAttempts = 0;
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    pidLivenessFn: () => false,
    clientFactory: () => ({
      connect: async () => {
        probeAttempts += 1;
      },
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const result = await manager.rehydrateFromState({
    version: 4,
    updated_at: new Date().toISOString(),
    instances: [
      {
        thread_id: "codex_10",
        agent_type: "codex",
        mode: "bridge",
        socket_path: socketPathForThread("codex_10"),
        working_dir: "/tmp",
        pid: 9001,
            status: "idle",
        created_at: new Date().toISOString(),
        auto_approve: false
      }
    ],
    session_bindings: {}
  });

  assert.deepEqual(result.restored_thread_ids, []);
  assert.deepEqual(result.pruned_thread_ids, ["codex_10"]);
  assert.equal(probeAttempts, 0, "probe must not run when PID is already dead");
  assert.equal(registry.list().length, 0);
});

test("rehydrateFromState retries probe on transient failure before pruning", async () => {
  // Regression for §C-2 candidate (b): the rehydrate probe used to fire
  // exactly once. agentapi can take a few seconds to boot after pm2
  // reload; a single-shot probe permanently pruned still-living workers
  // and produced "thread_id=X is not registered" storms downstream.
  // The retry budget makes the prune evidence-based.
  const registry = new InstanceRegistry();
  let connectAttempts = 0;
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    pidLivenessFn: () => true,
    rehydrateProbeRetries: 3,
    rehydrateProbeRetryDelayMs: 1,
    clientFactory: () => ({
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts < 3) {
          throw new Error("connect ECONNREFUSED (agentapi still booting)");
        }
      },
      disconnect: () => undefined,
      getStatus: async () => ({ status: "running" })
    })
  });

  const result = await manager.rehydrateFromState({
    version: 4,
    updated_at: new Date().toISOString(),
    instances: [
      {
        thread_id: "codex_11",
        agent_type: "codex",
        mode: "bridge",
        socket_path: socketPathForThread("codex_11"),
        working_dir: "/tmp",
        pid: 9100,
            status: "idle",
        created_at: new Date().toISOString(),
        auto_approve: false
      }
    ],
    session_bindings: {}
  });

  assert.deepEqual(result.restored_thread_ids, ["codex_11"]);
  assert.deepEqual(result.pruned_thread_ids, []);
  assert.equal(connectAttempts, 3, "probe must retry up to the configured budget");
  assert.equal(registry.get("codex_11")?.status, "running");
});

test("rehydrateFromState reaps the orphan when all probe retries fail but PID is alive", async () => {
  // Regression for the orphan-accumulation half of §C-2 candidate (b):
  // previously, a stuck agentapi (PID alive but /status hung) was simply
  // pruned from the registry — the host accumulated dead-but-running
  // agentapi processes that held sockets and produced confusing errors
  // when the same thread_id was reused. Now the rehydrate path actively
  // SIGTERMs the orphan and unlinks its socket.
  const registry = new InstanceRegistry();
  const killSignals: Array<{ pid: number; signal: number | NodeJS.Signals }> = [];
  const originalKill = process.kill.bind(process);
  let probeCalls = 0;
  const stuckPid = 9200;

  process.kill = ((pid: number, signal: number | NodeJS.Signals): true => {
    if (pid === stuckPid && signal !== 0) {
      killSignals.push({ pid, signal });
      return true;
    }
    // process.kill(pid, 0) is the liveness check inside waitForPidExit;
    // simulate "still alive" until SIGTERM has been delivered, then dead.
    if (signal === 0) {
      if (pid === stuckPid && killSignals.length > 0) {
        const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }
    return originalKill(pid, signal) as true;
  }) as typeof process.kill;

  try {
    const manager = new InstanceManager(registry, {
      ...socketModeOptions,
      pidLivenessFn: () => true,
      rehydrateProbeRetries: 2,
      rehydrateProbeRetryDelayMs: 1,
      clientFactory: () => ({
        connect: async () => {
          probeCalls += 1;
          throw new Error("connect timeout (agentapi unhealthy)");
        },
        disconnect: () => undefined,
        getStatus: async () => ({ status: "idle" })
      })
    });

    const result = await manager.rehydrateFromState({
      version: 4,
      updated_at: new Date().toISOString(),
      instances: [
        {
          thread_id: "codex_12",
          agent_type: "codex",
          mode: "bridge",
          socket_path: socketPathForThread("codex_12"),
          working_dir: "/tmp",
          pid: stuckPid,
                status: "idle",
          created_at: new Date().toISOString(),
          auto_approve: false
        }
      ],
      session_bindings: {}
    });

    assert.deepEqual(result.restored_thread_ids, []);
    assert.deepEqual(result.pruned_thread_ids, ["codex_12"]);
    assert.equal(probeCalls, 2, "probe must exhaust the configured retry budget");

    // The orphan reap runs as fire-and-forget after rehydrateFromState
    // returns. Give it a brief window to deliver SIGTERM.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      killSignals.some((entry) => entry.pid === stuckPid && entry.signal === "SIGTERM"),
      `expected SIGTERM to ${stuckPid}; saw ${JSON.stringify(killSignals)}`
    );
  } finally {
    process.kill = originalKill;
  }
});

test("spawn triggers onStateChange BEFORE the readiness wait to close the spawn-then-persist race", async () => {
  // Regression for §C-2 candidate (a): previously, `registry.register(instance)`
  // landed in memory but only reached state.json after route() returned and
  // ran persistStateSafely. A SIGKILL during the readiness wait left a live
  // detached agentapi child with no on-disk record. Now the InstanceManager
  // fires onStateChange immediately after register, so the disk view tracks
  // the in-memory view across the readiness boundary.
  const registry = new InstanceRegistry();
  const callbackCallsBeforeReady: number[] = [];
  let readyCalls = 0;

  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => new FakeChildProcess(7401) as never) as never,
    clientFactory: () => ({
      connect: async () => {
        readyCalls += 1;
        callbackCallsBeforeReady.push(readyCalls);
      },
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  let onStateChangeCalls = 0;
  let onStateChangeBeforeReady = false;
  manager.setOnStateChange(() => {
    onStateChangeCalls += 1;
    if (readyCalls === 0) {
      onStateChangeBeforeReady = true;
    }
  });

  const threadId = await manager.spawn("codex", "bridge");
  assert.ok(onStateChangeCalls >= 1, "onStateChange must fire at least once during spawn");
  assert.equal(
    onStateChangeBeforeReady,
    true,
    "onStateChange must fire BEFORE the readiness wait — the storm-fix promise"
  );

  await manager.kill(threadId);
});

test("kill triggers onStateChange after registry.unregister so deletions also persist immediately", async () => {
  const registry = new InstanceRegistry();
  const manager = new InstanceManager(registry, {
    ...socketModeOptions,
    socketPathFactory: socketPathForThread,
    spawnFn: (() => new FakeChildProcess(7501) as never) as never,
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      getStatus: async () => ({ status: "idle" })
    })
  });

  const threadId = await manager.spawn("codex", "bridge");

  let postKillCallback = 0;
  manager.setOnStateChange(() => {
    postKillCallback += 1;
  });

  await manager.kill(threadId);

  assert.ok(postKillCallback >= 1, "onStateChange must fire on kill so disk view tracks the removal");
  assert.equal(registry.get(threadId), undefined);
});
