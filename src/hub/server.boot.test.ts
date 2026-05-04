import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUILTIN_CALLERS, deriveBuiltinCallerKey } from "../shared/caller-bootstrap";
import { CallerRegistry } from "./caller-registry";
import {
  BOOTSTRAP_KEY_ENV_VAR,
  BootstrapKeyEnvUnwritableError,
  loadOrGenerateBootstrapKey
} from "./server";
import { buildPersistedHubState, loadPersistedHubState, savePersistedHubState } from "./state-store";

function withTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-boot-"));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  };
}

test("loadOrGenerateBootstrapKey returns the existing key when env var is already set", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const envFilePath = path.join(dir, ".env");
    const env: NodeJS.ProcessEnv = { [BOOTSTRAP_KEY_ENV_VAR]: "ab".repeat(32) };
    const result = loadOrGenerateBootstrapKey({ envFilePath, env });
    assert.equal(result.generated, false);
    assert.equal(result.key, "ab".repeat(32));
    assert.equal(fs.existsSync(envFilePath), false, ".env must not be touched when key is already set");
  } finally {
    cleanup();
  }
});

test("loadOrGenerateBootstrapKey generates a 64-char hex key and appends to writable .env", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const envFilePath = path.join(dir, ".env");
    fs.writeFileSync(envFilePath, "EXISTING=foo\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const result = loadOrGenerateBootstrapKey({
      envFilePath,
      env,
      randomBytes: (size) => Buffer.alloc(size, 0x42)
    });
    assert.equal(result.generated, true);
    assert.equal(result.key, "42".repeat(32));
    assert.equal(env[BOOTSTRAP_KEY_ENV_VAR], "42".repeat(32));

    const contents = fs.readFileSync(envFilePath, "utf8");
    assert.match(contents, /EXISTING=foo/);
    assert.match(contents, new RegExp(`${BOOTSTRAP_KEY_ENV_VAR}=(?:42){32}`));
  } finally {
    cleanup();
  }
});

test("loadOrGenerateBootstrapKey: PM Blocker #1 — fail-fast when .env is unwritable", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const envFilePath = path.join(dir, "missing-dir", ".env");
    const env: NodeJS.ProcessEnv = {};
    let captured: BootstrapKeyEnvUnwritableError | null = null;
    try {
      loadOrGenerateBootstrapKey({
        envFilePath,
        env,
        // Simulate EACCES by throwing inside the appendFileSync injection point.
        appendFileSync: () => {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
      });
    } catch (error) {
      if (error instanceof BootstrapKeyEnvUnwritableError) {
        captured = error;
      } else {
        throw error;
      }
    }
    assert.ok(captured, "should throw BootstrapKeyEnvUnwritableError");
    assert.equal(captured.envFilePath, envFilePath);
    assert.match(captured.message, new RegExp(BOOTSTRAP_KEY_ENV_VAR));
    assert.match(captured.message, /not writable/);
    // env must NOT be set when generation failed — never silently regenerate.
    assert.equal(env[BOOTSTRAP_KEY_ENV_VAR], undefined);
  } finally {
    cleanup();
  }
});

test("loadOrGenerateBootstrapKey does NOT log the cleartext key — only that one was generated", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const envFilePath = path.join(dir, ".env");
    fs.writeFileSync(envFilePath, "", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const logged: Array<{ message: string; bindings: Record<string, unknown> }> = [];
    const fakeLogger = {
      warn: (bindings: Record<string, unknown>, message: string) => {
        logged.push({ message, bindings });
      },
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      fatal: () => undefined
    };
    const result = loadOrGenerateBootstrapKey({
      envFilePath,
      env,
      logger: fakeLogger as unknown as NonNullable<Parameters<typeof loadOrGenerateBootstrapKey>[0]>["logger"],
      randomBytes: (size) => Buffer.alloc(size, 0x99)
    });
    assert.equal(result.generated, true);
    for (const entry of logged) {
      assert.equal(entry.message.includes(result.key), false, `log message must not contain cleartext key (${entry.message})`);
      for (const value of Object.values(entry.bindings)) {
        if (typeof value === "string") {
          assert.equal(value.includes(result.key), false, "log bindings must not contain cleartext key");
        }
      }
    }
  } finally {
    cleanup();
  }
});

test("ensureBuiltin: built-in callers exist after boot with caller_kind builtin and correct hash", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const statePath = path.join(dir, "state.json");
    savePersistedHubState(statePath, buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, []));

    const env: NodeJS.ProcessEnv = {};
    loadOrGenerateBootstrapKey({
      envFilePath: path.join(dir, ".env"),
      env,
      randomBytes: (size) => Buffer.alloc(size, 0x77)
    });
    const seed = env[BOOTSTRAP_KEY_ENV_VAR]!;
    process.env[BOOTSTRAP_KEY_ENV_VAR] = seed;
    try {
      const persisted = loadPersistedHubState(statePath, new Date().toISOString());
      const registry = new CallerRegistry({
        initialRecords: persisted.callers ?? [],
        persist: (records) => {
          savePersistedHubState(
            statePath,
            buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, records)
          );
        }
      });
      for (const builtin of BUILTIN_CALLERS) {
        registry.ensureBuiltin({
          caller_id: builtin.caller_id,
          caller_label: builtin.caller_label,
          deriveKey: () => deriveBuiltinCallerKey(builtin.caller_id)
        });
      }
      for (const builtin of BUILTIN_CALLERS) {
        const record = registry.get(builtin.caller_id);
        assert.ok(record, `built-in ${builtin.caller_id} must exist`);
        assert.equal(record.caller_kind, "builtin");
        assert.equal(record.caller_label, builtin.caller_label);
        const expectedHash = crypto
          .createHash("sha256")
          .update(deriveBuiltinCallerKey(builtin.caller_id) + builtin.caller_id)
          .digest("hex");
        assert.equal(record.key_hash, expectedHash);
        assert.equal(record.revoked_at, null);
      }
    } finally {
      delete process.env[BOOTSTRAP_KEY_ENV_VAR];
    }
  } finally {
    cleanup();
  }
});

test("ensureBuiltin is idempotent across reboots when bootstrap key is unchanged", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const statePath = path.join(dir, "state.json");
    const seed = "stable-seed";
    process.env[BOOTSTRAP_KEY_ENV_VAR] = seed;
    try {
      const persistAndReload = (initialRecords: ReturnType<CallerRegistry["list"]>): ReturnType<CallerRegistry["list"]> => {
        const registry = new CallerRegistry({
          initialRecords,
          persist: (records) => {
            savePersistedHubState(
              statePath,
              buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, records)
            );
          }
        });
        for (const builtin of BUILTIN_CALLERS) {
          registry.ensureBuiltin({
            caller_id: builtin.caller_id,
            caller_label: builtin.caller_label,
            deriveKey: () => deriveBuiltinCallerKey(builtin.caller_id)
          });
        }
        return registry.list();
      };

      savePersistedHubState(statePath, buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, []));
      let persisted = loadPersistedHubState(statePath, new Date().toISOString());
      const firstBoot = persistAndReload(persisted.callers ?? []);

      persisted = loadPersistedHubState(statePath, new Date().toISOString());
      const secondBoot = persistAndReload(persisted.callers ?? []);

      assert.equal(secondBoot.length, firstBoot.length);
      for (const recordAfter of secondBoot) {
        const before = firstBoot.find((entry) => entry.caller_id === recordAfter.caller_id);
        assert.ok(before, "id must persist");
        assert.equal(recordAfter.key_hash, before.key_hash, "key_hash unchanged when bootstrap key is stable");
      }
    } finally {
      delete process.env[BOOTSTRAP_KEY_ENV_VAR];
    }
  } finally {
    cleanup();
  }
});

test("ensureBuiltin recomputes key_hash on every boot — rotated bootstrap key invalidates built-ins", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const statePath = path.join(dir, "state.json");
    savePersistedHubState(statePath, buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, []));

    process.env[BOOTSTRAP_KEY_ENV_VAR] = "old-seed";
    try {
      const persisted = loadPersistedHubState(statePath, new Date().toISOString());
      const registry = new CallerRegistry({
        initialRecords: persisted.callers ?? [],
        persist: (records) => {
          savePersistedHubState(
            statePath,
            buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, records)
          );
        }
      });
      for (const builtin of BUILTIN_CALLERS) {
        registry.ensureBuiltin({
          caller_id: builtin.caller_id,
          caller_label: builtin.caller_label,
          deriveKey: () => deriveBuiltinCallerKey(builtin.caller_id)
        });
      }
    } finally {
      delete process.env[BOOTSTRAP_KEY_ENV_VAR];
    }

    const beforeRotation = (loadPersistedHubState(statePath, new Date().toISOString()).callers ?? []).slice();

    process.env[BOOTSTRAP_KEY_ENV_VAR] = "new-seed";
    try {
      const persisted = loadPersistedHubState(statePath, new Date().toISOString());
      const registry = new CallerRegistry({
        initialRecords: persisted.callers ?? [],
        persist: (records) => {
          savePersistedHubState(
            statePath,
            buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, records)
          );
        }
      });
      for (const builtin of BUILTIN_CALLERS) {
        registry.ensureBuiltin({
          caller_id: builtin.caller_id,
          caller_label: builtin.caller_label,
          deriveKey: () => deriveBuiltinCallerKey(builtin.caller_id)
        });
      }
    } finally {
      delete process.env[BOOTSTRAP_KEY_ENV_VAR];
    }

    const afterRotation = loadPersistedHubState(statePath, new Date().toISOString()).callers ?? [];
    for (const after of afterRotation) {
      const before = beforeRotation.find((entry) => entry.caller_id === after.caller_id);
      assert.ok(before, `id ${after.caller_id} must persist`);
      assert.notEqual(after.key_hash, before.key_hash, `key_hash for ${after.caller_id} must change after bootstrap-key rotation`);
    }
  } finally {
    cleanup();
  }
});
