import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { CallerRecord } from "./caller-registry";
import { InstanceRegistry } from "./registry";
import { HubRouter } from "./router";
import { buildPersistedHubState, savePersistedHubState, type PersistedHubState } from "./state-store";

function callerRecord(callerId: string): CallerRecord {
  return {
    caller_id: callerId,
    caller_label: callerId,
    caller_kind: "external",
    caller_authority: "write",
    key_hash: `hash-${callerId}`,
    created_at: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    last_seen_at: null,
    revoked_at: null
  };
}

interface OrderProbe {
  /** callers on disk at the moment rehydrateFromState fired its state flush */
  callersOnDiskDuringRehydrate: number | null;
  /** callers in the live registry at the moment rehydrateFromState ran */
  callersInRegistryDuringRehydrate: number | null;
}

/**
 * Stands in for InstanceManager so the test can observe hub state at the exact
 * point rehydrateFromState fires its notifyStateChange() flush — the window the
 * ordering bug lived in. Only the three members initialize() touches are
 * implemented; the real class is injected via `as never` in the same style as
 * the other router tests.
 */
function makeProbingInstanceManager(
  statePath: string,
  probe: OrderProbe,
  readRegistrySize: () => number | null
): unknown {
  let onStateChange: (() => void) | null = null;
  return {
    setOnStateChange(callback: (() => void) | null): void {
      onStateChange = callback;
    },
    snapshotState(): { instances: []; session_bindings: Record<string, never> } {
      return { instances: [], session_bindings: {} };
    },
    async rehydrateFromState(): Promise<{ restored_thread_ids: string[]; pruned_thread_ids: string[] }> {
      // Mirror the real rehydrateFromState, which ends with notifyStateChange()
      // to flush the post-prune snapshot before the hub starts serving.
      probe.callersInRegistryDuringRehydrate = readRegistrySize();
      onStateChange?.();
      const flushed = JSON.parse(fs.readFileSync(statePath, "utf8")) as PersistedHubState;
      probe.callersOnDiskDuringRehydrate = (flushed.callers ?? []).length;
      return { restored_thread_ids: [], pruned_thread_ids: [] };
    }
  };
}

test("initialize() builds the caller registry before rehydrate flushes state", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-init-order-"));
  const statePath = path.join(tmpDir, "state.json");
  const persistedCallers = [callerRecord("meridian-web"), callerRecord("ads-dispatcher")];
  savePersistedHubState(
    statePath,
    buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, persistedCallers)
  );

  const probe: OrderProbe = {
    callersOnDiskDuringRehydrate: null,
    callersInRegistryDuringRehydrate: null
  };

  try {
    const registry = new InstanceRegistry();
    let router: HubRouter | null = null;
    const instanceManager = makeProbingInstanceManager(
      statePath,
      probe,
      () => router?.getCallerRegistry()?.list().length ?? null
    );
    router = new HubRouter(registry, { statePath, instanceManager: instanceManager as never });

    await router.initialize();

    // The registry must already exist when rehydrate runs. Otherwise any
    // request arriving during the rehydrate await hits requireCallerRegistry(),
    // which bootstraps an EMPTY registry and rejects every known caller.
    assert.equal(
      probe.callersInRegistryDuringRehydrate,
      persistedCallers.length,
      "caller registry was not populated before rehydrateFromState ran"
    );

    // rehydrateFromState ends with notifyStateChange() -> persistStateSafely(),
    // which serializes `this.callerRegistry?.list() ?? []`. With the registry
    // still null that optional chain writes `callers: []` over the persisted
    // records, and a crash before the end of initialize() loses them for good.
    assert.equal(
      probe.callersOnDiskDuringRehydrate,
      persistedCallers.length,
      "rehydrate flush wiped persisted callers from state.json"
    );

    // And the records must survive to the end of initialize().
    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8")) as PersistedHubState;
    assert.deepEqual(
      (finalState.callers ?? []).map((record) => record.caller_id).sort(),
      persistedCallers.map((record) => record.caller_id).sort()
    );
    assert.deepEqual(
      router.getCallerRegistry()?.list().map((record) => record.caller_id).sort(),
      persistedCallers.map((record) => record.caller_id).sort()
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
