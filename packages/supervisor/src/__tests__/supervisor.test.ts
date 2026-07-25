import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ensureSharedBootstrapKey,
  ensureWebGuiToken,
  loadSupervisorEnvironment
} from "../environment";
import { createDefaultProcessSpecs, type ManagedProcessSpec } from "../process-spec";
import {
  MeridianSupervisor,
  type ChildProcessHandle,
  type ServiceRegistrationHandle,
  type SupervisorAdapter,
  type SupervisorSnapshot,
  type SupervisorStateStore
} from "../supervisor";

class MemoryStateStore implements SupervisorStateStore {
  snapshot: SupervisorSnapshot | null = null;

  load(): SupervisorSnapshot | null {
    return this.snapshot;
  }

  save(snapshot: SupervisorSnapshot): void {
    this.snapshot = structuredClone(snapshot);
  }
}

class FakeChild implements ChildProcessHandle {
  readonly exitListeners: Array<(exitCode: number | null, signal: NodeJS.Signals | null) => void> = [];
  terminated = false;

  constructor(readonly pid: number) {}

  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

class FakeRegistration implements ServiceRegistrationHandle {
  published: string[] = [];
  unregistered = false;

  publish(health: "ready" | "degraded" | "unhealthy"): void {
    this.published.push(health);
  }

  unregister(): void {
    this.unregistered = true;
  }
}

function buildSpec(id: "runtime" | "orchestrator", restartLimit = 1): ManagedProcessSpec {
  return {
    id,
    providerId: `org.meridian/${id}`,
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: {},
    readinessUrl: `http://127.0.0.1/${id}`,
    declarationPath: `/declarations/${id}.json`,
    restartLimit,
    readinessTimeoutMs: 10,
    readinessIntervalMs: 1
  };
}

test("default process graph contains Runtime and Orchestrator but never Gateway", () => {
  const specs = createDefaultProcessSpecs({
    workspaceRoot: "/opt/meridian",
    nodeExecutable: "/usr/bin/node",
    env: {
      WEB_GUI_PORT: "4100",
      GUI_PORT: "4200"
    }
  });

  assert.deepEqual(specs.map((spec) => spec.id), ["runtime", "orchestrator"]);
  assert.equal(specs.some((spec) => spec.id === ("gateway" as never)), false);
  assert.equal(specs[0]?.readinessUrl, "http://127.0.0.1:4100/api/health");
  assert.equal(specs[1]?.readinessUrl, "http://127.0.0.1:4200/api/health");
});

test("supervisor config preserves explicit env and creates required secrets once", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-supervisor-env-"));
  const env: NodeJS.ProcessEnv = { WEB_GUI_PORT: "5100" };
  try {
    fs.writeFileSync(
      path.join(configDir, ".env"),
      "WEB_GUI_PORT=4100\nWEB_GUI_TOKEN=local-token\n"
    );
    loadSupervisorEnvironment(configDir, env);
    const first = ensureSharedBootstrapKey(configDir, env);
    const second = ensureSharedBootstrapKey(configDir, env);
    const firstWebToken = ensureWebGuiToken(configDir, env);
    const secondWebToken = ensureWebGuiToken(configDir, env);

    assert.equal(env.WEB_GUI_PORT, "5100");
    assert.equal(firstWebToken, "local-token");
    assert.equal(secondWebToken, "local-token");
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(
      fs.readFileSync(path.join(configDir, ".env"), "utf8")
        .match(/MERIDIAN_INTERNAL_BOOTSTRAP_KEY=/g)?.length,
      1
    );
    assert.equal(
      fs.readFileSync(path.join(configDir, ".env"), "utf8")
        .match(/WEB_GUI_TOKEN=/g)?.length,
      1
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("supervisor creates and persists a private Web token for a clean config", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-supervisor-env-"));
  const env: NodeJS.ProcessEnv = {};
  try {
    const token = ensureWebGuiToken(configDir, env);

    assert.equal(env.WEB_GUI_TOKEN, token);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.match(
      fs.readFileSync(path.join(configDir, ".env"), "utf8"),
      new RegExp(`WEB_GUI_TOKEN=${token}`)
    );
    assert.equal(fs.statSync(path.join(configDir, ".env")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("registration happens only after readiness and is removed on stop", async () => {
  const events: string[] = [];
  const child = new FakeChild(101);
  const registration = new FakeRegistration();
  const adapter: SupervisorAdapter = {
    spawn: async () => {
      events.push("spawn");
      return child;
    },
    waitUntilReady: async () => {
      events.push("ready");
      return true;
    },
    register: (_spec, pid, instanceId) => {
      events.push(`register:${pid}:${instanceId}`);
      return registration;
    }
  };
  const store = new MemoryStateStore();
  const supervisor = new MeridianSupervisor({
    specs: [buildSpec("runtime")],
    adapter,
    stateStore: store,
    randomId: () => "runtime-instance-1",
    now: () => new Date("2026-07-25T00:00:00.000Z")
  });

  const started = await supervisor.start();

  assert.deepEqual(events.slice(0, 2), ["spawn", "ready"]);
  assert.match(events[2] ?? "", /^register:101:runtime-instance-1$/);
  assert.deepEqual(registration.published, ["ready"]);
  assert.equal(started.children.runtime?.status, "ready");
  assert.equal(started.children.runtime?.providerId, "org.meridian/runtime");

  await supervisor.stop();
  assert.equal(registration.unregistered, true);
  assert.equal(child.terminated, true);
  assert.equal(store.snapshot?.children.runtime?.status, "stopped");
});

test("readiness failures use a new instance and stop at the bounded restart limit", async () => {
  const children: FakeChild[] = [];
  const registrations: Array<{ instanceId: string; registration: FakeRegistration }> = [];
  const readiness = [false, true];
  const ids = ["attempt-one", "attempt-two"];
  const adapter: SupervisorAdapter = {
    spawn: async () => {
      const child = new FakeChild(200 + children.length);
      children.push(child);
      return child;
    },
    waitUntilReady: async () => readiness.shift() ?? false,
    register: (_spec, _pid, instanceId) => {
      const registration = new FakeRegistration();
      registrations.push({ instanceId, registration });
      return registration;
    }
  };
  const supervisor = new MeridianSupervisor({
    specs: [buildSpec("orchestrator", 1)],
    adapter,
    stateStore: new MemoryStateStore(),
    randomId: () => ids.shift() ?? "unexpected"
  });

  const snapshot = await supervisor.start();

  assert.equal(children.length, 2);
  assert.equal(children[0]?.terminated, true);
  assert.deepEqual(registrations.map((item) => item.instanceId), ["attempt-two"]);
  assert.equal(snapshot.children.orchestrator?.instanceId, "attempt-two");
  assert.equal(snapshot.children.orchestrator?.restartCount, 1);
  assert.equal(snapshot.children.orchestrator?.providerId, "org.meridian/orchestrator");
});

test("exhausted readiness retries fail without publishing a descriptor", async () => {
  let spawnCount = 0;
  let registrationCount = 0;
  const adapter: SupervisorAdapter = {
    spawn: async () => new FakeChild(300 + spawnCount++),
    waitUntilReady: async () => false,
    register: () => {
      registrationCount += 1;
      return new FakeRegistration();
    }
  };
  const supervisor = new MeridianSupervisor({
    specs: [buildSpec("runtime", 2)],
    adapter,
    stateStore: new MemoryStateStore(),
    randomId: () => `attempt-${spawnCount}`
  });

  const snapshot = await supervisor.start();

  assert.equal(spawnCount, 3);
  assert.equal(registrationCount, 0);
  assert.equal(snapshot.children.runtime?.status, "failed");
  assert.equal(snapshot.children.runtime?.restartCount, 2);
});
