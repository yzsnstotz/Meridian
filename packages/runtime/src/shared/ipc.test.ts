import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getRuntimeTunable, sendIpcMessage, sendIpcRequest } from "./ipc";

interface TestIpcServer {
  socketPath: string;
  close: () => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function createIpcServer(
  onPayload: (raw: string, socket: net.Socket) => void
): Promise<TestIpcServer> {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ipc-test-"));
  const socketPath = path.join(tempDir, "hub.sock");
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {
      // Client may close immediately after sendIpcMessage flushes payload.
    });
    let raw = "";
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("end", () => {
      onPayload(raw, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test("sendIpcMessage resolves after write even when server response closes later", async () => {
  const server = await createIpcServer((raw, socket) => {
    assert.equal(JSON.parse(raw).intent, "list");
    setTimeout(() => {
      if (socket.writable) {
        socket.end(JSON.stringify({ ok: true }));
      }
    }, 400);
  });

  try {
    await Promise.race([
      sendIpcMessage(server.socketPath, { intent: "list", target: "all" }),
      wait(200).then(() => {
        assert.fail("sendIpcMessage did not resolve quickly");
      })
    ]);
  } finally {
    await server.close();
  }
});

test("sendIpcRequest returns parsed response payload", async () => {
  const server = await createIpcServer((raw, socket) => {
    const parsed = JSON.parse(raw) as { intent: string };
    socket.end(JSON.stringify({ status: "success", content: parsed.intent }));
  });

  try {
    const response = await sendIpcRequest<{ intent: string }, { status: string; content: string }>(
      server.socketPath,
      { intent: "list" }
    );
    assert.equal(response.status, "success");
    assert.equal(response.content, "list");
  } finally {
    await server.close();
  }
});

const RUNTIME_CONFIG_ENV = "MERIDIAN_RUNTIME_CONFIG";
const TUNABLE_ENV = "MERIDIAN_TEST_TUNABLE";

/**
 * Runs `fn` with MERIDIAN_RUNTIME_CONFIG pointed at a temp file containing
 * `config` (or at a path that does not exist when `config` is null), and with
 * the tunable's env var set to `envValue` (or unset when undefined).
 */
async function withRuntimeConfig(
  options: { config?: string | null; envValue?: string },
  fn: (configPath: string) => void | Promise<void>
): Promise<void> {
  const previousConfigEnv = process.env[RUNTIME_CONFIG_ENV];
  const previousTunableEnv = process.env[TUNABLE_ENV];
  const tempDir = mkdtempSync(path.join(tmpdir(), "runtime-tunable-"));
  const configPath = path.join(tempDir, "runtime.json");

  if (options.config != null) {
    writeFileSync(configPath, options.config, "utf8");
  }
  process.env[RUNTIME_CONFIG_ENV] = configPath;
  if (options.envValue === undefined) {
    delete process.env[TUNABLE_ENV];
  } else {
    process.env[TUNABLE_ENV] = options.envValue;
  }

  try {
    await fn(configPath);
  } finally {
    if (previousConfigEnv === undefined) {
      delete process.env[RUNTIME_CONFIG_ENV];
    } else {
      process.env[RUNTIME_CONFIG_ENV] = previousConfigEnv;
    }
    if (previousTunableEnv === undefined) {
      delete process.env[TUNABLE_ENV];
    } else {
      process.env[TUNABLE_ENV] = previousTunableEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("getRuntimeTunable prefers the env var over the config file and the default", async () => {
  await withRuntimeConfig(
    { config: JSON.stringify({ knob: 222 }), envValue: "111" },
    () => {
      assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 30), 111);
    }
  );
});

test("getRuntimeTunable falls back to the config file when the env var is unset", async () => {
  await withRuntimeConfig({ config: JSON.stringify({ knob: 300 }) }, () => {
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 30), 300);
  });
});

test("getRuntimeTunable accepts a numeric string in the config file", async () => {
  await withRuntimeConfig({ config: JSON.stringify({ knob: "300" }) }, () => {
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 30), 300);
  });
});

test("getRuntimeTunable reads each key independently from one config file", async () => {
  await withRuntimeConfig(
    { config: JSON.stringify({ ipcRunRequestTimeoutMs: 14_400_000, hubMaxUnchangedSnapshotPolls: 300 }) },
    () => {
      assert.equal(getRuntimeTunable(TUNABLE_ENV, "hubMaxUnchangedSnapshotPolls", 30), 300);
      assert.equal(getRuntimeTunable(TUNABLE_ENV, "ipcRunRequestTimeoutMs", 1), 14_400_000);
      // A key that is absent from the file must not pick up a sibling's value.
      assert.equal(getRuntimeTunable(TUNABLE_ENV, "absentKey", 42), 42);
    }
  );
});

test("getRuntimeTunable falls back to the default when the config file is missing", async () => {
  await withRuntimeConfig({ config: null }, () => {
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 30), 30);
  });
});

test("getRuntimeTunable falls back to the default when the config file is malformed", async () => {
  await withRuntimeConfig({ config: "{ this is not json" }, () => {
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 30), 30);
  });
});

test("getRuntimeTunable falls back to the default when the config file is not an object", async () => {
  await withRuntimeConfig({ config: JSON.stringify(["not", "an", "object"]) }, () => {
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 30), 30);
  });
});

test("getRuntimeTunable rejects non-positive and non-numeric config values", async () => {
  for (const rejected of [0, -1, -0.5, "abc", "", null, true, {}, []]) {
    await withRuntimeConfig({ config: JSON.stringify({ knob: rejected }) }, () => {
      assert.equal(
        getRuntimeTunable(TUNABLE_ENV, "knob", 30),
        30,
        `expected ${JSON.stringify(rejected)} to be rejected`
      );
    });
  }
});

test("getRuntimeTunable ignores a non-positive env var and falls through to the file", async () => {
  for (const rejected of ["0", "-5", "abc", ""]) {
    await withRuntimeConfig({ config: JSON.stringify({ knob: 300 }), envValue: rejected }, () => {
      assert.equal(
        getRuntimeTunable(TUNABLE_ENV, "knob", 30),
        300,
        `expected env value ${JSON.stringify(rejected)} to be ignored`
      );
    });
  }
});

test("getRuntimeTunable ignores a non-positive env var and falls through to the default", async () => {
  await withRuntimeConfig({ config: null, envValue: "0" }, () => {
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 30), 30);
  });
});

test("getRuntimeTunable re-reads the config file on every call (no restart, no cache)", async () => {
  await withRuntimeConfig({ config: JSON.stringify({ knob: 30 }) }, (configPath) => {
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 1), 30);
    writeFileSync(configPath, JSON.stringify({ knob: 300 }), "utf8");
    assert.equal(getRuntimeTunable(TUNABLE_ENV, "knob", 1), 300);
  });
});
