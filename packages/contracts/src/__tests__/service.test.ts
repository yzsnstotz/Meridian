import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  RuntimeInstanceDescriptorSchema,
  RuntimeServiceRegistration,
  ServiceDeclarationSchema,
  canonicalServiceDeclarationBytes,
  computeDeclarationDigest,
  discoverServices,
  resolveService,
  type RuntimeInstanceDescriptor,
  type ServiceDeclaration
} from "../service";

const declaration: ServiceDeclaration = {
  $schema: "https://clawso.ai/schemas/service/v1.json",
  schemaVersion: "1",
  declarationId: "org.meridian/orchestrator",
  declarationVersion: "1.0.0",
  assetRef: {
    assetClass: "tool",
    assetId: "meridian",
    assetVersion: "1.0.0"
  },
  providerId: "org.meridian/orchestrator",
  serviceCapabilities: [{ id: "orchestration.run", version: "1.0.0" }],
  operations: [
    {
      id: "orchestration.run.create",
      contractVersion: "1.0.0",
      inputSchemaRef: "schemas/run-create.input.json",
      outputSchemaRef: "schemas/run-create.output.json",
      effect: "write",
      idempotency: "required",
      executionMode: "async",
      streaming: true,
      cancellable: true,
      requiredPermissions: ["agent.spawn"],
      workspaceMode: "write",
      transportRequirements: {
        allowedTransports: ["http", "a2a"],
        requiredFeatures: ["cancellation", "provider_acknowledgement"]
      }
    }
  ]
};

function descriptor(overrides: Partial<RuntimeInstanceDescriptor> = {}): RuntimeInstanceDescriptor {
  return {
    $schema: "https://clawso.ai/schemas/service-instance/v1.json",
    schemaVersion: "1",
    instanceId: "orchestrator-instance-1",
    providerId: declaration.providerId,
    declarationId: declaration.declarationId,
    declarationVersion: declaration.declarationVersion,
    declarationDigest: computeDeclarationDigest(declaration),
    assetRef: declaration.assetRef,
    ownership: "native-unmanaged",
    pid: 1234,
    lease: {
      issuedAt: "2026-07-25T00:00:00.000Z",
      expiresAt: "2026-07-25T00:02:00.000Z"
    },
    transports: [
      {
        kind: "http",
        endpoint: "http://127.0.0.1:49001",
        features: ["cancellation", "provider_acknowledgement"]
      }
    ],
    health: {
      state: "ready",
      checkedAt: "2026-07-25T00:00:05.000Z"
    },
    ...overrides
  };
}

test("matches the frozen Clawso declaration and descriptor shapes", () => {
  assert.equal(ServiceDeclarationSchema.parse(declaration).declarationId, declaration.declarationId);
  assert.equal(RuntimeInstanceDescriptorSchema.parse(descriptor()).instanceId, "orchestrator-instance-1");
  assert.throws(
    () => ServiceDeclarationSchema.parse({ ...declaration, endpoint: "http://127.0.0.1:49001" }),
    /unrecognized key/i
  );
});

test("canonical declaration bytes are recursively sorted, newline terminated, and stable", () => {
  const bytes = canonicalServiceDeclarationBytes(declaration);
  assert.equal(bytes.at(-1), 0x0a);
  assert.equal(computeDeclarationDigest(declaration), computeDeclarationDigest(JSON.parse(bytes.toString("utf8"))));
  assert.match(computeDeclarationDigest(declaration), /^sha256:[a-f0-9]{64}$/);
});

test("writes declarations and renewable runtime descriptors atomically with private modes", async () => {
  await withServiceDirectories(async ({ declarationDir, nativeDir }) => {
    const registration = new RuntimeServiceRegistration({
      declaration,
      declarationDir,
      descriptorDir: nativeDir,
      instanceId: "stable-instance",
      pid: 1234,
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-25T00:00:00.000Z"),
      transports: [{
        kind: "http",
        endpoint: "http://127.0.0.1:49001",
        features: ["cancellation", "provider_acknowledgement"]
      }]
    });

    const first = registration.publish("starting");
    assert.equal(first.instanceId, "stable-instance");
    assert.equal(first.lease.expiresAt, "2026-07-25T00:01:00.000Z");
    const renewed = registration.publish("ready", new Date("2026-07-25T00:00:30.000Z"));
    assert.equal(renewed.instanceId, first.instanceId);
    assert.equal(renewed.lease.expiresAt, "2026-07-25T00:01:30.000Z");
    assert.equal(fs.statSync(registration.descriptorPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(registration.declarationPath).mode & 0o777, 0o600);

    registration.unregister();
    assert.equal(fs.existsSync(registration.descriptorPath), false);
    assert.equal(fs.existsSync(registration.declarationPath), true);
  });
});

test("isolates corrupt siblings and quarantines stale leases, dead pids, and unhealthy instances", async () => {
  await withServiceDirectories(async ({ declarationDir, nativeDir }) => {
    writeJson(path.join(declarationDir, "orchestrator.json"), declaration);
    writeJson(path.join(nativeDir, "ready.json"), descriptor());
    writeJson(path.join(nativeDir, "expired.json"), descriptor({
      instanceId: "expired",
      lease: {
        issuedAt: "2026-07-24T23:00:00.000Z",
        expiresAt: "2026-07-24T23:01:00.000Z"
      }
    }));
    writeJson(path.join(nativeDir, "dead.json"), descriptor({ instanceId: "dead", pid: 404 }));
    writeJson(path.join(nativeDir, "unhealthy.json"), descriptor({
      instanceId: "unhealthy",
      health: { state: "unhealthy", checkedAt: "2026-07-25T00:00:05.000Z" }
    }));
    fs.writeFileSync(path.join(nativeDir, "corrupt.json"), "{not-json");

    const report = await discoverServices({
      declarationDirs: [declarationDir],
      descriptorDirs: [{ path: nativeDir, source: "native" }],
      now: new Date("2026-07-25T00:01:00.000Z"),
      isProcessAlive: (pid) => pid === 1234,
      probeHealth: async () => true
    });

    assert.deepEqual(report.services.map((entry) => entry.instanceId), ["orchestrator-instance-1"]);
    assert.deepEqual(
      report.quarantined.map((entry) => entry.reason).sort(),
      ["corrupt_descriptor", "dead_process", "expired_lease", "unhealthy"].sort()
    );
  });
});

test("quarantines incompatible declaration identity and conflicting duplicate instances", async () => {
  await withServiceDirectories(async ({ declarationDir, nativeDir, clawsoDir }) => {
    writeJson(path.join(declarationDir, "orchestrator.json"), declaration);
    writeJson(path.join(nativeDir, "drift.json"), descriptor({
      instanceId: "drift",
      declarationDigest: `sha256:${"a".repeat(64)}`
    }));
    writeJson(path.join(nativeDir, "duplicate-a.json"), descriptor({ instanceId: "duplicate" }));
    writeJson(path.join(clawsoDir, "duplicate-b.json"), descriptor({
      instanceId: "duplicate",
      transports: [{
        kind: "http",
        endpoint: "http://127.0.0.1:49002",
        features: ["cancellation", "provider_acknowledgement"]
      }]
    }));

    const report = await discoverServices({
      declarationDirs: [declarationDir],
      descriptorDirs: [
        { path: nativeDir, source: "native" },
        { path: clawsoDir, source: "clawso" }
      ],
      now: new Date("2026-07-25T00:01:00.000Z"),
      isProcessAlive: () => true,
      probeHealth: async () => true
    });

    assert.equal(report.services.length, 0);
    assert.deepEqual(
      report.quarantined.map((entry) => entry.reason).sort(),
      ["declaration_mismatch", "duplicate_instance", "duplicate_instance"].sort()
    );
  });
});

test("resolves explicit URL, environment, explicit instance, native, clawso, then probes", async () => {
  const services = [
    {
      ...descriptor({ instanceId: "native-instance" }),
      source: "native" as const,
      descriptorPath: "/native/native-instance.json",
      routingEndpoint: "http://127.0.0.1:49001",
      declaration
    },
    {
      ...descriptor({ instanceId: "clawso-instance" }),
      source: "clawso" as const,
      descriptorPath: "/clawso/clawso-instance.json",
      routingEndpoint: "http://127.0.0.1:49002",
      declaration
    }
  ];

  assert.equal((await resolveService({
    serviceId: declaration.providerId,
    explicitUrl: "http://127.0.0.1:49999",
    env: {},
    services
  })).source, "explicit-url");
  assert.equal((await resolveService({
    serviceId: declaration.providerId,
    env: { MERIDIAN_SERVICE_ORG_MERIDIAN_ORCHESTRATOR_URL: "http://127.0.0.1:49998" },
    services
  })).source, "environment");
  assert.equal((await resolveService({
    serviceId: declaration.providerId,
    selectedInstanceId: "clawso-instance",
    env: {},
    services
  })).instanceId, "clawso-instance");
  assert.equal((await resolveService({
    serviceId: declaration.providerId,
    env: {},
    services
  })).instanceId, "native-instance");
  assert.equal((await resolveService({
    serviceId: "orchestration.run",
    env: {},
    services
  })).instanceId, "native-instance");
  assert.equal((await resolveService({
    serviceId: "probe-only",
    env: {},
    services: [],
    compatibilityProbes: [async () => "http://127.0.0.1:47777"]
  })).source, "compatibility-probe");
});

async function withServiceDirectories(
  run: (directories: { declarationDir: string; nativeDir: string; clawsoDir: string }) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-service-contract-"));
  const declarationDir = path.join(root, "declarations");
  const nativeDir = path.join(root, "native");
  const clawsoDir = path.join(root, "clawso");
  fs.mkdirSync(declarationDir, { recursive: true });
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(clawsoDir, { recursive: true });
  try {
    await run({ declarationDir, nativeDir, clawsoDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
