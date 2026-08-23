import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubRouter } from "./router";
import { InstanceRegistry } from "./registry";
import { CredentialStore } from "./credential-store";

test("HubRouter accepts and stores a CredentialStore from options", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "router-d1-"));
  const store = new CredentialStore({ initialRecords: [], credentialsRoot: tmpdir });
  const router = new HubRouter(new InstanceRegistry(), { credentialStore: store });
  // exposes a getter or accessible field for the wired store
  assert.equal(router.getCredentialStore?.(), store);
});

test("HubRouter works without CredentialStore (backwards compat)", () => {
  const router = new HubRouter(new InstanceRegistry(), {});
  assert.equal(router.getCredentialStore?.(), undefined);
});

test("HubRouter.persistOnShutdown flushes state.json (storm-fix: window C)", async () => {
  // Regression for the architectural storm root cause (§C-2 candidate c):
  // HubServer.stop() used to close the listening socket without flushing
  // in-memory state. Any registry mutation since the last route()-end
  // persistStateSafely was lost when pm2 sent SIGTERM. The next hub
  // generation then rehydrated a stale state.json and surfaced
  // `thread_id=X is not registered` errors on the first call.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "router-shutdown-"));
  try {
    const statePath = path.join(tmpdir, "hub-state.json");
    const router = new HubRouter(new InstanceRegistry(), { statePath });

    assert.equal(
      fs.existsSync(statePath),
      false,
      "state.json must not exist before any flush"
    );

    router.persistOnShutdown();

    assert.equal(
      fs.existsSync(statePath),
      true,
      "persistOnShutdown must produce state.json on disk"
    );
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as { version: number };
    assert.equal(parsed.version, 4);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});
