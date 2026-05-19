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
