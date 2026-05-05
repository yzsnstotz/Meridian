import assert from "node:assert/strict";
import test from "node:test";

import { parseReadyPayload, runHealthcheck } from "./ioex-tunnel-healthcheck.mjs";

function response(status, body = "") {
  return {
    status,
    async text() {
      return body;
    }
  };
}

function fakeDeps(responsesByUrl) {
  const commands = [];
  return {
    commands,
    now() {
      return 1_776_031_200_000;
    },
    async fetch(url) {
      const next = responsesByUrl.get(url);
      if (next instanceof Error) {
        throw next;
      }
      if (!next) {
        throw new Error(`unexpected fetch ${url}`);
      }
      return next;
    },
    runCommand(command, args) {
      commands.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    },
    readState() {
      return null;
    },
    writeState() {},
    log() {}
  };
}

function baseConfig(overrides = {}) {
  return {
    externalUrl: "https://ioex.io",
    originUrl: "http://127.0.0.1:3100",
    metricsUrls: ["http://127.0.0.1:20241"],
    minReadyConnections: 1,
    timeoutMs: 1000,
    restartService: "system/com.cloudflare.cloudflared",
    restartOnTunnelFailure: true,
    dryRun: false,
    notifyCooldownMs: 300_000,
    notifyDesktop: false,
    syslog: false,
    ...overrides
  };
}

test("parseReadyPayload accepts a ready cloudflared connector", () => {
  const parsed = parseReadyPayload('{"status":200,"readyConnections":4,"connectorId":"abc"}');

  assert.equal(parsed.status, 200);
  assert.equal(parsed.readyConnections, 4);
  assert.equal(parsed.connectorId, "abc");
});

test("runHealthcheck passes when tunnel, origin, and public URL are healthy", async () => {
  const deps = fakeDeps(
    new Map([
      ["http://127.0.0.1:20241/ready", response(200, '{"status":200,"readyConnections":4}')],
      ["http://127.0.0.1:3100", response(200)],
      ["https://ioex.io", response(200)]
    ])
  );

  const result = await runHealthcheck(baseConfig(), deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(deps.commands, []);
});

test("runHealthcheck does not fail when a stale state file is unwritable", async () => {
  const deps = fakeDeps(
    new Map([
      ["http://127.0.0.1:20241/ready", response(200, '{"status":200,"readyConnections":4}')],
      ["http://127.0.0.1:3100", response(200)],
      ["https://ioex.io", response(200)]
    ])
  );
  deps.readState = () => ({ lastFailureKey: "previous failure" });
  deps.writeState = () => {
    const error = new Error("EACCES: permission denied, open '/var/tmp/ioex-tunnel-healthcheck-state.json'");
    error.code = "EACCES";
    throw error;
  };

  const result = await runHealthcheck(baseConfig({ stateFile: "/var/tmp/ioex-tunnel-healthcheck-state.json" }), deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("runHealthcheck restarts cloudflared when the connector has no ready connections", async () => {
  const deps = fakeDeps(
    new Map([
      ["http://127.0.0.1:20241/ready", response(200, '{"status":503,"readyConnections":0}')],
      ["http://127.0.0.1:3100", response(200)],
      ["https://ioex.io", response(530)]
    ])
  );

  const result = await runHealthcheck(baseConfig(), deps);

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /readyConnections=0/);
  assert.deepEqual(deps.commands, [
    {
      command: "/bin/launchctl",
      args: ["kickstart", "-k", "system/com.cloudflare.cloudflared"]
    }
  ]);
});

test("runHealthcheck fails without restart when only the origin is unhealthy", async () => {
  const deps = fakeDeps(
    new Map([
      ["http://127.0.0.1:20241/ready", response(200, '{"status":200,"readyConnections":4}')],
      ["http://127.0.0.1:3100", response(502)],
      ["https://ioex.io", response(530)]
    ])
  );

  const result = await runHealthcheck(baseConfig(), deps);

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /origin http:\/\/127\.0\.0\.1:3100 returned HTTP 502/);
  assert.deepEqual(deps.commands, []);
});
