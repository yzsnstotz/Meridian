import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Uncertain effective Codex permissions response");
  return value as Record<string, unknown>;
}

/** Validate the public config/read result, never an agent's self-reported policy. */
export function assertDisposableStorageConfig(value: unknown, scratch: string): void {
  const config = record(value);
  const name = path.basename(path.dirname(scratch));
  if (config.sandbox_mode !== null || config.sandbox_workspace_write != null || config.profile !== null) {
    throw new Error("Disposable storage refuses legacy or uncertain sandbox selection; user configuration was not changed");
  }
  if (config.default_permissions !== name || config.approval_policy !== "never") {
    throw new Error("Disposable storage effective permissions selection does not match the request");
  }
  const profile = record(record(config.permissions)[name]);
  const filesystem = Object.entries(record(profile.filesystem)).filter(([, value]) => value != null);
  if (profile.extends !== ":read-only" || Object.values(record(profile.workspace_roots ?? {})).some(Boolean)
    || filesystem.length !== 1 || filesystem[0]?.[0] !== scratch || filesystem[0]?.[1] !== "write") {
    throw new Error("Disposable storage requires the exact isolated scratch grant and read-only source profile");
  }
  if (record(profile.network).enabled !== false) throw new Error("Disposable storage requires command network disabled");
}

/** A bounded, read-only public app-server handshake. Never starts a thread or edits config. */
export async function verifyDisposableStorageConfig(
  command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, scratch: string,
  spawnFn: typeof spawn = spawn, timeoutMs = 5_000, onChildSpawn?: (child: ChildProcess) => void
): Promise<void> {
  const overrides: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" && args[i + 1] !== undefined) overrides.push("-c", args[++i]!);
  }
  const child = spawnFn(command, ["app-server", ...overrides], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"]
  } as SpawnOptions);
  onChildSpawn?.(child);
  await new Promise<void>((resolve, reject) => {
    let buffer = "", responseReceived = false, settled = false;
    let failure: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const stop = (error?: Error) => {
      failure ??= error;
      child.stdin?.end();
      child.kill();
    };
    const timer = setTimeout(() => {
      stop(new Error("Effective Codex permission preflight timed out; validator was not started"));
      finish(failure);
    }, timeoutMs);
    child.once("error", () => { finish(new Error("Effective Codex permission preflight could not start")); });
    child.once("close", () => finish(failure ?? (responseReceived ? undefined : new Error("Effective Codex permission preflight ended without a response"))));
    child.stdin?.on("error", () => stop(new Error("Effective Codex permission preflight input failed")));
    child.stderr?.resume(); // Do not log configuration, credentials or unrelated startup details.
    const send = (message: object) => child.stdin!.write(JSON.stringify(message) + "\n");
    if (!child.stdin || !child.stdout) { stop(new Error("Effective Codex permission preflight has no captured transport")); return; }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || responseReceived || failure) return;
      buffer += chunk;
      if (buffer.length > 2_000_000) { stop(new Error("Effective Codex permission preflight response is oversized")); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = record(JSON.parse(line));
          if (message.id === 1) {
            if (message.error) throw new Error("Effective Codex permission preflight initialization failed");
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "config/read", params: { includeLayers: false, cwd } });
          } else if (message.id === 2) {
            if (message.error) throw new Error("Effective Codex permission preflight config read failed");
            assertDisposableStorageConfig(record(message.result).config, scratch);
            responseReceived = true; stop(); return;
          }
        } catch (error) { stop(error instanceof Error ? error : new Error("Invalid effective Codex permission response")); return; }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "meridian_permissions_preflight", version: "1.0.0" } } });
  });
}
