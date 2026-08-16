import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceRegistry } from "./service-registry";

test("ServiceRegistry registers, resolves, lists, and unregisters services", () => {
  const registry = new ServiceRegistry();
  registry.register({
    service: "coordinator",
    socket_path: "/tmp/coordinator.sock",
    intents: ["delegate", "plan"]
  });

  assert.equal(registry.resolve("delegate")?.socket_path, "/tmp/coordinator.sock");
  assert.equal(registry.resolve("plan")?.service, "coordinator");
  assert.equal(registry.resolve("review"), null);
  assert.deepEqual(registry.list(), [
    {
      service: "coordinator",
      socket_path: "/tmp/coordinator.sock",
      intents: ["delegate", "plan"],
      metadata: undefined
    }
  ]);

  assert.equal(registry.unregister("coordinator"), true);
  assert.equal(registry.resolve("delegate"), null);
  assert.deepEqual(registry.list(), []);
});
