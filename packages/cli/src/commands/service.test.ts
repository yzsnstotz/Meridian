import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  RuntimeServiceRegistration,
  type ServiceDeclaration
} from "@meridian/contracts";

import { runServiceCommand } from "./service";

const declaration: ServiceDeclaration = {
  $schema: "https://clawso.ai/schemas/service/v1.json",
  schemaVersion: "1",
  declarationId: "org.meridian/orchestrator",
  declarationVersion: "1.0.0",
  assetRef: { assetClass: "tool", assetId: "meridian", assetVersion: "1.0.0" },
  providerId: "org.meridian/orchestrator",
  serviceCapabilities: [{ id: "orchestration.run", version: "1.0.0" }],
  operations: [{
    id: "orchestration.run.status",
    contractVersion: "1.0.0",
    inputSchemaRef: "schemas/status.input.json",
    outputSchemaRef: "schemas/status.output.json",
    effect: "read",
    idempotency: "none",
    executionMode: "sync",
    streaming: false,
    cancellable: false,
    requiredPermissions: ["orchestration.read"],
    workspaceMode: "none",
    transportRequirements: { allowedTransports: ["http"], requiredFeatures: [] }
  }]
};

test("service list, describe, resolve, and doctor use native descriptors without Hub reachability", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-cli-service-"));
  const homeDir = path.join(root, "home");
  const tempDir = path.join(root, "tmp");
  const declarationDir = path.join(root, "declarations");
  const descriptorDir = path.join(root, "descriptors");
  try {
    const registration = new RuntimeServiceRegistration({
      declaration,
      declarationDir,
      descriptorDir,
      instanceId: "orchestrator-local",
      pid: 1234,
      transports: [{
        kind: "http",
        endpoint: "http://127.0.0.1:49001",
        features: []
      }]
    });
    registration.publish("ready");
    const options = {
      env: {
        MERIDIAN_SERVICE_DECLARATION_DIR: declarationDir,
        MERIDIAN_RUNTIME_DESCRIPTOR_DIR: descriptorDir
      },
      pathOptions: {
        platform: "linux" as const,
        homeDir,
        tempDir,
        uid: 1000
      },
      discovery: {
        isProcessAlive: () => true,
        probeHealth: async () => true
      }
    };

    const listed = await runServiceCommand(["list"], options);
    assert.equal((listed.services as unknown[]).length, 1);
    const described = await runServiceCommand(["describe", "orchestrator-local"], options);
    assert.equal((described.services as Array<{ instanceId: string }>)[0]?.instanceId, "orchestrator-local");
    const resolved = await runServiceCommand(["resolve", declaration.providerId], options);
    assert.deepEqual((resolved.resolved as { source: string; endpoint: string }), {
      source: "native",
      serviceId: declaration.providerId,
      endpoint: "http://127.0.0.1:49001",
      instanceId: "orchestrator-local",
      providerId: declaration.providerId,
      descriptor: (listed.services as unknown[])[0]
    });
    const doctor = await runServiceCommand(["doctor"], options);
    assert.equal(doctor.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("service resolve honors explicit URL before discovery", async () => {
  const result = await runServiceCommand(
    ["resolve", "org.meridian/runtime", "--url", "http://127.0.0.1:49999"],
    {
      env: {},
      pathOptions: {
        platform: "linux",
        homeDir: "/tmp/meridian-empty-home",
        tempDir: "/tmp",
        uid: 1000
      }
    }
  );
  assert.equal((result.resolved as { source: string }).source, "explicit-url");
});
