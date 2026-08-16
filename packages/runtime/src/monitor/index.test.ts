import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY ??= "test-bootstrap-seed";

async function withEnv(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>
): Promise<void> {
  const original = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    original.set(key, process.env[key]);
    const nextValue = values[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }
  try {
    await callback();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("startMonitorService sets meridian-monitor caller identity when bootstrap key is present", async () => {
  const { startMonitorService } = await import("./index");
  const { clearCallerIdentity, hasCallerIdentity } = await import("../interface/ipc-sender");

  clearCallerIdentity();
  await withEnv({ MERIDIAN_INTERNAL_BOOTSTRAP_KEY: "test-seed-monitor" }, async () => {
    await startMonitorService();
    assert.equal(hasCallerIdentity(), true);
  });
  clearCallerIdentity();
});

test("startMonitorService throws bootstrap_key_missing when MERIDIAN_INTERNAL_BOOTSTRAP_KEY is absent", async () => {
  const { startMonitorService } = await import("./index");

  await withEnv({ MERIDIAN_INTERNAL_BOOTSTRAP_KEY: undefined }, async () => {
    await assert.rejects(
      () => startMonitorService(),
      /bootstrap_key_missing/
    );
  });
});
