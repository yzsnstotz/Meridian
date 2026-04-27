import * as fs from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRoutineJobHubServer,
  executeRestartScript,
  parseHubRegistry,
  probeEntry,
  validateRestartScript,
  type RoutineJobHubServer
} from "./server";

const servers = new Set<RoutineJobHubServer>();
const childServers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(Array.from(servers, (server) => server.close()));
  servers.clear();

  await Promise.all(Array.from(childServers, (server) => closeServer(server)));
  childServers.clear();
});

describe("parseHubRegistry", () => {
  it("returns an empty registry with an error for bad JSON", () => {
    const result = parseHubRegistry("{bad-json", "/tmp/hub.json");

    expect(result.entries).toEqual([]);
    expect(result.error).toContain("Invalid hub registry JSON");
  });

  it("parses valid registry entries with optional descriptions", () => {
    const result = parseHubRegistry(JSON.stringify([
      {
        id: "github-opc-scan",
        name: "GitHub OPC Scan",
        description: "Repository automation scan",
        url: "http://127.0.0.1:18765",
        health_path: "/healthz"
      }
    ]), "/tmp/hub.json");

    expect(result.error).toBeUndefined();
    expect(result.entries).toEqual([
      {
        id: "github-opc-scan",
        name: "GitHub OPC Scan",
        description: "Repository automation scan",
        url: "http://127.0.0.1:18765",
        health_path: "/healthz"
      }
    ]);
  });
});

describe("routine job hub server", () => {
  it("renders a missing registry notice without crashing", async () => {
    const missingRegistry = path.join(tmpdir(), `missing-hub-${Date.now()}.json`);
    const server = createRoutineJobHubServer({
      port: 0,
      registryPath: missingRegistry
    });
    servers.add(server);
    await server.listen();

    const baseUrl = server.url();
    const page = await fetchText(`${baseUrl}/`);
    const health = await fetchJson<{ status: string; entries: number }>(`${baseUrl}/api/health`);

    expect(page.status).toBe(200);
    expect(page.body).toContain("Routine Job Hub");
    expect(page.body).toContain("registry missing");
    expect(health).toEqual({ status: "ok", entries: 0 });
  });

  it("renders registered cards and returns probed entry status", async () => {
    const healthyChild = await startChildServer(200);
    const failingChild = await startChildServer(503);
    const root = await fs.mkdtemp(path.join(tmpdir(), "routine-job-hub-"));
    const registryPath = path.join(root, "hub.json");
    await fs.writeFile(registryPath, JSON.stringify([
      {
        id: "github-opc-scan",
        name: "GitHub OPC Scan",
        description: "Repository automation scan",
        url: healthyChild.baseUrl,
        health_path: "/healthz"
      },
      {
        id: "clawhub-skills-observatory",
        name: "ClawHub Skills Observatory",
        url: failingChild.baseUrl,
        health_path: "/"
      }
    ]), "utf8");

    const server = createRoutineJobHubServer({
      port: 0,
      registryPath,
      probeTimeoutMs: 500
    });
    servers.add(server);
    await server.listen();

    const baseUrl = server.url();
    const page = await fetchText(`${baseUrl}/`);
    const entries = await fetchJson<Array<{ id: string; status: string; status_code?: number }>>(`${baseUrl}/api/entries`);

    expect(page.status).toBe(200);
    expect(page.body).toContain("GitHub OPC Scan");
    expect(page.body).toContain("ClawHub Skills Observatory");
    expect(page.body).toContain("status-up");
    expect(page.body).toContain("status-down");
    expect(entries).toEqual([
      expect.objectContaining({ id: "github-opc-scan", status: "up", status_code: 200 }),
      expect.objectContaining({ id: "clawhub-skills-observatory", status: "down", status_code: 503 })
    ]);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("renders rebuild & restart button only when restart_script is configured", async () => {
    const child = await startChildServer(200);
    const root = await fs.mkdtemp(path.join(tmpdir(), "routine-job-hub-restart-ui-"));
    const allowedRoot = await fs.mkdtemp(path.join(tmpdir(), "tools-allowed-"));
    const scriptPath = path.join(allowedRoot, "rebuild-and-restart.sh");
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });
    const registryPath = path.join(root, "hub.json");
    await fs.writeFile(registryPath, JSON.stringify([
      {
        id: "with-script",
        name: "With Script",
        description: "Has a rebuild script",
        url: child.baseUrl,
        health_path: "/healthz",
        restart_script: scriptPath
      },
      {
        id: "without-script",
        name: "Without Script",
        description: "No rebuild configured",
        url: child.baseUrl,
        health_path: "/healthz"
      }
    ]), "utf8");

    const server = createRoutineJobHubServer({
      port: 0,
      registryPath,
      probeTimeoutMs: 500,
      restartScriptRoots: [allowedRoot]
    });
    servers.add(server);
    await server.listen();

    const page = await fetchText(`${server.url()}/`);
    expect(page.body).toContain('data-restart-id="with-script"');
    expect(page.body).not.toContain('data-restart-id="without-script"');
    expect(page.body).toContain("Rebuild &amp; restart");

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(allowedRoot, { recursive: true, force: true });
  });

  it("runs an allowlisted restart script and returns its output", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(tmpdir(), "tools-allowed-"));
    const scriptPath = path.join(allowedRoot, "rebuild-and-restart.sh");
    await fs.writeFile(
      scriptPath,
      "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'STATUS: pulled\\nSTATUS: built\\nSTATUS: DONE\\n'\nexit 0\n",
      { mode: 0o755 }
    );
    const root = await fs.mkdtemp(path.join(tmpdir(), "routine-job-hub-restart-run-"));
    const registryPath = path.join(root, "hub.json");
    await fs.writeFile(registryPath, JSON.stringify([
      {
        id: "github-opc-scan",
        name: "GitHub OPC Scan",
        url: "http://127.0.0.1:18765",
        health_path: "/healthz",
        restart_script: scriptPath
      }
    ]), "utf8");

    const server = createRoutineJobHubServer({
      port: 0,
      registryPath,
      probeTimeoutMs: 500,
      restartScriptRoots: [allowedRoot]
    });
    servers.add(server);
    await server.listen();

    const result = await fetch(
      `${server.url()}/api/entries/github-opc-scan/restart`,
      { method: "POST" }
    );
    expect(result.status).toBe(200);
    const body = await result.json() as {
      id: string;
      status: string;
      exit_code: number | null;
      stdout: string;
      stderr: string;
    };
    expect(body.id).toBe("github-opc-scan");
    expect(body.status).toBe("ok");
    expect(body.exit_code).toBe(0);
    expect(body.stdout).toContain("STATUS: pulled");
    expect(body.stdout).toContain("STATUS: DONE");

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(allowedRoot, { recursive: true, force: true });
  });

  it("rejects restart requests for unknown ids and unconfigured scripts", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "routine-job-hub-restart-reject-"));
    const registryPath = path.join(root, "hub.json");
    await fs.writeFile(registryPath, JSON.stringify([
      {
        id: "no-script",
        name: "No Script",
        url: "http://127.0.0.1:18765",
        health_path: "/healthz"
      }
    ]), "utf8");

    const server = createRoutineJobHubServer({
      port: 0,
      registryPath,
      probeTimeoutMs: 500
    });
    servers.add(server);
    await server.listen();

    const unknown = await fetch(
      `${server.url()}/api/entries/missing/restart`,
      { method: "POST" }
    );
    expect(unknown.status).toBe(400);
    const unknownBody = await unknown.json() as { status: string; error: string };
    expect(unknownBody.status).toBe("rejected");
    expect(unknownBody.error).toContain("Unknown entry id");

    const noScript = await fetch(
      `${server.url()}/api/entries/no-script/restart`,
      { method: "POST" }
    );
    expect(noScript.status).toBe(400);
    const noScriptBody = await noScript.json() as { status: string; error: string };
    expect(noScriptBody.status).toBe("rejected");
    expect(noScriptBody.error).toContain("no restart_script configured");

    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects restart scripts outside the allowed roots", async () => {
    const insideRoot = await fs.mkdtemp(path.join(tmpdir(), "tools-allowed-"));
    const outside = await fs.mkdtemp(path.join(tmpdir(), "tools-outside-"));
    const malicious = path.join(outside, "evil.sh");
    await fs.writeFile(malicious, "#!/usr/bin/env bash\necho pwned\n", { mode: 0o755 });

    const validation = validateRestartScript(malicious, [insideRoot]);
    expect("error" in validation && validation.error).toMatch(/outside the allowed roots/);

    const ok = validateRestartScript(path.join(insideRoot, "x.sh"), [insideRoot]);
    expect("error" in ok && ok.error).toBeFalsy();

    const relative = validateRestartScript("./relative.sh", [insideRoot]);
    expect("error" in relative && relative.error).toMatch(/absolute path/);

    await fs.rm(insideRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("kills restart scripts that exceed the timeout", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(tmpdir(), "tools-allowed-timeout-"));
    const scriptPath = path.join(allowedRoot, "slow.sh");
    await fs.writeFile(
      scriptPath,
      "#!/usr/bin/env bash\nsleep 30\n",
      { mode: 0o755 }
    );

    const result = await executeRestartScript("slow", scriptPath, 200);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out/);

    await fs.rm(allowedRoot, { recursive: true, force: true });
  });

  it("times out slow HEAD probes and reports the entry as down", async () => {
    const hangingChild = await startHangingChildServer();
    const startedAt = Date.now();

    const result = await probeEntry({
      id: "slow-dashboard",
      name: "Slow Dashboard",
      url: hangingChild.baseUrl,
      health_path: "/healthz"
    }, 25);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result).toEqual(expect.objectContaining({
      id: "slow-dashboard",
      status: "down",
      health_url: `${hangingChild.baseUrl}/healthz`
    }));
  });
});

async function startChildServer(statusCode: number): Promise<{ baseUrl: string }> {
  const server = http.createServer((_request, response) => {
    response.statusCode = statusCode;
    response.end();
  });
  childServers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Child server did not bind to a TCP port");
  }

  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startHangingChildServer(): Promise<{ baseUrl: string }> {
  const server = http.createServer(() => {
    // Intentionally leave the response open to exercise the probe timeout path.
  });
  childServers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Hanging child server did not bind to a TCP port");
  }

  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.text()
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return await response.json() as T;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
