import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRequireCallerAuth, type CallerAuthenticatedRequest } from "./caller-auth-middleware";
import { loadCallerRegistry } from "./caller-registry";
import type { ProjectPolicy } from "./project-policy-schema";
import { createAutoProvisionerHandlers } from "./auto-provisioner";
import type { AppState } from "../types";

const tempDirectories = new Set<string>();

const validPolicy = {
  project_id: "mumu",
  thread_id_pattern: "chatter-mumu-user-{user_id}",
  memory_folder_pattern: "/tmp/mumu-users/{user_id}",
  manifest_path: "/tmp/mumu-manifest.json",
  allowed_modes: ["session", "stateless"],
  skill_allowlist: ["structured.upsert", "structured.get"],
  llm_agent_kind: "claude-code",
  credential_id: null,
  user_reply_channel_template: {
    channel: "socket",
    chat_id: "ads:mumu:{user_id}",
    socket_path: "/tmp/ads.sock"
  },
  seeds_init: { mode: "none" }
} satisfies ProjectPolicy;

afterEach(async () => {
  delete process.env.ADS_HMAC_KEY;
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("createAutoProvisionerHandlers", () => {
  it("returns 401 for a bad caller signature", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot);
    const registry = await loadCallerRegistry({ repoRoot });
    const handlers = createHarness({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry })
    });

    const response = await invokeJson(
      handlers.handle,
      "POST",
      "/api/projects/mumu/users/u_001/ensure-chatter",
      {},
      { "x-meridian-caller-signature": "sha256=deadbeef" }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "denied_caller_auth", reason: "invalid_signature" });
  });

  it("returns 404 when the project is not registered", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot);
    const registry = await loadCallerRegistry({ repoRoot });
    const handlers = createHarness({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry })
    });

    const response = await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {});

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: "project_not_registered" });
  });

  it("rejects caller-supplied policy fields before creating chatter", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot);
    await writePolicy(repoRoot, "mumu", validPolicy);
    const registry = await loadCallerRegistry({ repoRoot });
    const createRole = vi.fn();
    const handlers = createHarness({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry }),
      createRole
    });

    const response = await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {
      memory_folder: "/etc",
      skill_allowlist: ["*"]
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual({
      error: "denied_caller_policy_override",
      offending_keys: ["memory_folder", "skill_allowlist"]
    });
    expect(createRole).not.toHaveBeenCalled();
  });

  it("creates chatter from registry policy and returns existing on the second ensure", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot);
    await writePolicy(repoRoot, "mumu", validPolicy);
    const registry = await loadCallerRegistry({ repoRoot });
    const createRole = vi.fn().mockResolvedValue({ ok: true, thread_id: "chatter-mumu-user-u_001" });
    const handlers = createHarness({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry }),
      createRole
    });

    const first = await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {});
    const second = await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {});

    expect(first.statusCode).toBe(200);
    expect(first.body).toEqual({ thread_id: "chatter-mumu-user-u_001", status: "created" });
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({ thread_id: "chatter-mumu-user-u_001", status: "existing" });
    expect(createRole).toHaveBeenCalledTimes(1);
    expect(createRole).toHaveBeenCalledWith({
      role_type: "chatter",
      thread_id: "chatter-mumu-user-u_001",
      config: {
        chatter_id: "chatter-mumu-user-u_001",
        memory_folder: "/tmp/mumu-users/u_001",
        manifest_path: "/tmp/mumu-manifest.json",
        allowed_modes: ["session", "stateless"],
        skill_allowlist: ["structured.upsert", "structured.get"],
        llm_agent_kind: "claude-code",
        user_reply_channel: {
          channel: "socket",
          chat_id: "ads:mumu:u_001",
          socket_path: "/tmp/ads.sock"
        }
      }
    });
  });

  it("returns role_creation_failed when internal role creation returns a 5xx", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot);
    await writePolicy(repoRoot, "mumu", validPolicy);
    const registry = await loadCallerRegistry({ repoRoot });
    const error = Object.assign(new Error("boom"), { statusCode: 503 });
    const handlers = createHarness({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry }),
      createRole: vi.fn().mockRejectedValue(error)
    });

    const response = await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {});

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: "role_creation_failed", upstream_status: 503 });
  });

  it("archives chatter idempotently", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot);
    await writePolicy(repoRoot, "mumu", validPolicy);
    const registry = await loadCallerRegistry({ repoRoot });
    const deactivateRole = vi.fn().mockResolvedValue(undefined);
    const handlers = createHarness({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry }),
      createRole: vi.fn().mockResolvedValue({ ok: true, thread_id: "chatter-mumu-user-u_001" }),
      deactivateRole
    });

    await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {});
    const firstArchive = await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/archive-chatter", {});
    const secondArchive = await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/archive-chatter", {});

    expect(firstArchive.statusCode).toBe(200);
    expect(firstArchive.body).toEqual({ archived: true });
    expect(secondArchive.statusCode).toBe(200);
    expect(secondArchive.body).toEqual({ archived: false });
    expect(deactivateRole).toHaveBeenCalledTimes(1);
    expect(deactivateRole).toHaveBeenCalledWith("chatter-mumu-user-u_001");
  });

  it("gets chatter status without exposing policy fields", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot);
    await writePolicy(repoRoot, "mumu", validPolicy);
    const registry = await loadCallerRegistry({ repoRoot });
    const handlers = createHarness({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry }),
      createRole: vi.fn().mockResolvedValue({ ok: true, thread_id: "chatter-mumu-user-u_001" })
    });

    await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {});
    const response = await invokeJson(
      handlers.handle,
      "GET",
      "/api/projects/mumu/users/u_001/chatter",
      undefined,
      signedHeaders(Buffer.alloc(0))
    );
    const serialized = JSON.stringify(response.body);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ thread_id: "chatter-mumu-user-u_001", status: "active" });
    expect(serialized).not.toContain("skill_allowlist");
    expect(serialized).not.toContain("memory_folder_pattern");
    expect(serialized).not.toContain("manifest_path");
    expect(serialized).not.toContain("credential_id");
  });
});

function createHarness(options: {
  repoRoot: string;
  callerAuth: ReturnType<typeof createRequireCallerAuth>;
  createRole?: (body: unknown) => Promise<unknown>;
  deactivateRole?: (threadId: string) => Promise<void>;
}) {
  return createAutoProvisionerHandlers({
    repoRoot: options.repoRoot,
    callerAuth: options.callerAuth,
    createRole: options.createRole ?? vi.fn().mockResolvedValue({ ok: true }),
    deactivateRole: options.deactivateRole ?? vi.fn().mockResolvedValue(undefined),
    stateStore: new MemoryStateStore()
  });
}

class MemoryStateStore {
  private state: AppState | null = null;

  async load(): Promise<AppState | null> {
    return this.state ? JSON.parse(JSON.stringify(this.state)) : null;
  }

  async save(state: AppState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

async function invokeSigned(
  handler: ReturnType<typeof createAutoProvisionerHandlers>["handle"],
  method: string,
  url: string,
  body: unknown
): Promise<{ statusCode: number; body: unknown }> {
  const bodyBytes = Buffer.from(JSON.stringify(body));
  return invokeJson(handler, method, url, body, signedHeaders(bodyBytes));
}

async function invokeJson(
  handler: ReturnType<typeof createAutoProvisionerHandlers>["handle"],
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: unknown }> {
  const bodyBytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const request = Readable.from([bodyBytes]) as CallerAuthenticatedRequest;
  request.method = method;
  request.url = url;
  request.headers = headers;
  const response = makeResponse();

  const handled = await handler(request, response as unknown as ServerResponse);

  expect(handled).toBe(true);
  return {
    statusCode: response.statusCode ?? 200,
    body: JSON.parse(response.body)
  };
}

function signedHeaders(body: Buffer): Record<string, string> {
  return { "x-meridian-caller-signature": `sha256=${sign(body, "super-secret")}` };
}

function sign(body: Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function makeResponse(): {
  statusCode?: number;
  headersSent: boolean;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(chunk: string): void;
} {
  return {
    headersSent: false,
    headers: {},
    body: "",
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk: string): void {
      this.headersSent = true;
      this.body += chunk;
    }
  };
}

async function createRepoRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-auto-provisioner-"));
  tempDirectories.add(directory);
  return directory;
}

async function writeCaller(repoRoot: string): Promise<void> {
  const filePath = path.join(repoRoot, "config", "callers", "ads.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    }, null, 2)}\n`,
    "utf8"
  );
}

async function writePolicy(repoRoot: string, projectId: string, policy: unknown): Promise<void> {
  const filePath = path.join(repoRoot, "config", "projects", `${projectId}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}
