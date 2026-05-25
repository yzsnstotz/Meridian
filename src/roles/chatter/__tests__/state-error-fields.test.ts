import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoleContext } from "../../base-role";
import { ChatterStateStore } from "../chatter-state-store";
import { ChatterRole } from "../../definitions/chatter";
import type { AppState, ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../../types";
import { createRequireCallerAuth, type CallerAuthenticatedRequest } from "../../../web/caller-auth-middleware";
import { loadCallerRegistry } from "../../../web/caller-registry";
import { createAutoProvisionerHandlers } from "../../../web/auto-provisioner";
import type { ProjectPolicy } from "../../../web/project-policy-schema";

const tempDirectories = new Set<string>();
const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:test",
  socket_path: "/tmp/ads.sock"
};

afterEach(async () => {
  delete process.env.ADS_HMAC_KEY;
  await Promise.all(
    Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true }))
  );
  tempDirectories.clear();
});

describe("ChatterStateStore error fields", () => {
  it("parses existing chatter state records without error fields", async () => {
    const root = await createTempDir("chatter-state-optional-");
    const store = new ChatterStateStore(root);
    await fs.mkdir(path.dirname(store.stateFile), { recursive: true });
    await fs.writeFile(
      store.stateFile,
      `${JSON.stringify({ version: 1, agent_session_id: null, in_flight_traces: [] })}\n`,
      "utf8"
    );

    expect(store.load()).toEqual({
      version: 1,
      agent_session_id: null,
      agent_session_status: "unbound",
      in_flight_traces: []
    });
  });

  it("records provision failures and clears the field on the next successful provision", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createTempDir("meridian-provision-repo-");
    const memoryRoot = await createTempDir("meridian-provision-memory-");
    await writeCaller(repoRoot);
    await writePolicy(repoRoot, "mumu", makePolicy(memoryRoot));
    const registry = await loadCallerRegistry({ repoRoot });
    const createRole = vi
      .fn()
      .mockRejectedValueOnce(new Error("activation failed at /Users/yzliu/private-token/file.ts"))
      .mockResolvedValueOnce({ ok: true, thread_id: "chatter-mumu-user-u_001" });
    const handlers = createAutoProvisionerHandlers({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry }),
      createRole,
      deactivateRole: vi.fn().mockResolvedValue(undefined),
      stateStore: new MemoryStateStore()
    });

    const failed = await invokeSigned(
      handlers.handle,
      "POST",
      "/api/projects/mumu/users/u_001/ensure-chatter",
      {}
    );
    const store = new ChatterStateStore(path.join(memoryRoot, "u_001"));
    const failedState = store.load();

    expect(failed.statusCode).toBe(500);
    expect(failedState.last_provision_error).toMatchObject({
      code: "role_creation_failed",
      message: "activation failed at [path]"
    });
    expect(failedState.last_provision_error?.ts).toEqual(expect.any(String));
    expect(failedState.last_provision_error?.message).not.toContain("/Users/yzliu");

    const created = await invokeSigned(
      handlers.handle,
      "POST",
      "/api/projects/mumu/users/u_001/ensure-chatter",
      {}
    );
    const createdState = store.load();

    expect(created.statusCode).toBe(200);
    expect(created.body).toEqual({ thread_id: "chatter-mumu-user-u_001", status: "created" });
    expect(createdState.last_provision_error).toBeUndefined();
  });

  it("records turn failures and clears the field on the next successful turn dispatch", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-turn-error-")));
    tempDirectories.add(root);
    let failRunDispatch = false;
    const sent: HubMessage[] = [];
    const ctx: RoleContext = {
      sendToHub: async (msg) => {
        const hubMessage = msg as HubMessage;
        if (failRunDispatch && hubMessage.intent === "run" && hubMessage.target !== "global") {
          throw new Error("agent dispatch failed at /Users/yzliu/private-token/run.ts");
        }
        sent.push(hubMessage);
      },
      listInstances: async () => [],
      log: { debug() {}, info() {}, warn() {}, error() {} }
    };
    const role = new ChatterRole("chatter-tenant-a", makeChatterConfig(root));
    await role.onActivate(ctx);
    await role.onInboundResult(makeTurnResult("first", { payload: { chatter: { mode: "session" } } }));
    const spawn = sent.find((message) => message.intent === "spawn")!;
    await driveSpawnResponse(role, spawn, "claude_07");
    sent.length = 0;

    failRunDispatch = true;
    await role.onInboundResult(makeTurnResult("failed", { payload: { chatter: { mode: "session" } } }));
    const failedState = new ChatterStateStore(root).load();

    expect(failedState.last_turn_error).toMatchObject({
      trace_id: expect.any(String),
      code: "agent_dispatch_failed",
      message: "agent dispatch failed at [path]"
    });
    expect(failedState.last_turn_error?.ts).toEqual(expect.any(String));
    expect(failedState.last_turn_error?.message).not.toContain("/Users/yzliu");

    const recoverySpawn = sent.find((message) => message.intent === "spawn")!;
    expect(recoverySpawn).toBeDefined();
    failRunDispatch = false;
    await driveSpawnResponse(role, recoverySpawn, "claude_08");
    const clearedState = new ChatterStateStore(root).load();

    expect(sent.find((message) => message.intent === "run" && message.target === "claude_08")).toBeDefined();
    expect(clearedState.last_turn_error).toBeUndefined();
  });

  it("includes error fields in existing chatter status responses", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createTempDir("meridian-provision-repo-");
    const memoryRoot = await createTempDir("meridian-provision-memory-");
    await writeCaller(repoRoot);
    await writePolicy(repoRoot, "mumu", makePolicy(memoryRoot));
    const registry = await loadCallerRegistry({ repoRoot });
    const handlers = createAutoProvisionerHandlers({
      repoRoot,
      callerAuth: createRequireCallerAuth({ registry }),
      createRole: vi.fn().mockResolvedValue({ ok: true, thread_id: "chatter-mumu-user-u_001" }),
      deactivateRole: vi.fn().mockResolvedValue(undefined),
      stateStore: new MemoryStateStore()
    });
    await invokeSigned(handlers.handle, "POST", "/api/projects/mumu/users/u_001/ensure-chatter", {});
    const store = new ChatterStateStore(path.join(memoryRoot, "u_001"));
    store.save({
      ...store.load(),
      last_turn_error: {
        ts: "2026-05-21T00:00:00.000Z",
        trace_id: "trace-1",
        code: "agent_dispatch_failed",
        message: "agent dispatch failed"
      }
    });

    const response = await invokeJson(
      handlers.handle,
      "GET",
      "/api/projects/mumu/users/u_001/chatter",
      undefined,
      signedHeaders(Buffer.alloc(0))
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      thread_id: "chatter-mumu-user-u_001",
      status: "active",
      last_turn_error: {
        ts: "2026-05-21T00:00:00.000Z",
        trace_id: "trace-1",
        code: "agent_dispatch_failed",
        message: "agent dispatch failed"
      }
    });
  });
});

function makeChatterConfig(memoryFolder: string): ChatterRoleConfig {
  return {
    chatter_id: "tenant-a",
    memory_folder: memoryFolder,
    template: "flat-log",
    allowed_modes: ["stateless", "session"],
    skill_allowlist: [],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
  };
}

function makeTurnResult(content: string, overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: crypto.randomUUID(),
    thread_id: "chatter-tenant-a",
    source: "ads",
    status: "success",
    content,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

async function driveSpawnResponse(
  role: ChatterRole,
  spawnMsg: HubMessage,
  newAgentThreadId: string
): Promise<void> {
  await role.onInboundResult({
    trace_id: spawnMsg.trace_id,
    thread_id: newAgentThreadId,
    source: spawnMsg.target,
    status: "success",
    content: `spawned ${newAgentThreadId}`,
    attachments: [],
    timestamp: new Date().toISOString()
  });
}

function makePolicy(memoryRoot: string): ProjectPolicy {
  return {
    project_id: "mumu",
    thread_id_pattern: "chatter-mumu-user-{user_id}",
    memory_folder_pattern: `${memoryRoot}/{user_id}`,
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
  };
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

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), prefix));
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
