import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RoleRunner } from "../roles/role-runner";
import { RoleRegistry } from "../roles/role-registry";
import { ChatterRole } from "../roles/definitions/chatter";
import { createRoleHandlers } from "../server/role-handlers";
import {
  ChatterRoleConfigSchema,
  type AppState,
  type HubMessage,
  type HubResult,
  type ReplyChannel
} from "../types";
import { createAutoProvisionerHandlers } from "./auto-provisioner";
import { createRequireCallerAuth, type CallerAuthenticatedRequest } from "./caller-auth-middleware";
import { loadCallerRegistry } from "./caller-registry";
import type { ProjectPolicy } from "./project-policy-schema";

const PROJECT_ID = "__test-bgate-mumu";
const USER_ID = "u_bgate";
const THREAD_ID = "chatter-bgate-user-u_bgate";
const HMAC_SECRET = "super-secret";
const tempDirectories = new Set<string>();

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:bgate:u_bgate",
  socket_path: "/tmp/ads-bgate.sock"
};

afterEach(async () => {
  delete process.env.ADS_HMAC_KEY;
  await Promise.all(
    Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true }))
  );
  tempDirectories.clear();
});

describe("BATCH-2-GATE synthetic fixture auto-provisioning", () => {
  it("provisions fixture chatter, copies seeds, handles a turn, and serves read_only_query", async () => {
    process.env.ADS_HMAC_KEY = HMAC_SECRET;
    const repoRoot = await createTempDir("meridian-bgate-repo-");
    const memoryRoot = await createTempDir("meridian-bgate-memory-");
    const fixtureRoot = await createTempDir("meridian-bgate-fixture-");
    const seedsRoot = path.join(fixtureRoot, "seeds");
    const manifestPath = await writeFixtureManifest(fixtureRoot, seedsRoot);
    const policyPath = await writePolicy(repoRoot, PROJECT_ID, makePolicy(memoryRoot, manifestPath, seedsRoot));
    await writeCaller(repoRoot, PROJECT_ID);

    const sent: HubMessage[] = [];
    const stateStore = new MemoryStateStore();
    const runner = new RoleRunner({
      sendToHub: async (message) => {
        sent.push(message as HubMessage);
      },
      log: silentLog()
    });
    const registry = new RoleRegistry();
    registry.register("chatter", (threadId, config) => (
      new ChatterRole(threadId, ChatterRoleConfigSchema.parse(config))
    ));
    const roleHandlers = createRoleHandlers({
      runner,
      registry,
      stateStore,
      log: silentLog()
    });
    const callerRegistry = await loadCallerRegistry({ repoRoot });
    const provisioner = createAutoProvisionerHandlers({
      repoRoot,
      stateStore,
      createRole: roleHandlers.createRole,
      deactivateRole: async (threadId) => {
        await runner.deactivate(threadId);
      },
      resolveActiveRole: (threadId) => {
        const role = runner.getRole(threadId);
        return role ? { roleType: role.roleType, config: role.config } : null;
      },
      callerAuth: createRequireCallerAuth({ registry: callerRegistry })
    });

    const created = await invokeSigned(
      provisioner.handle,
      "POST",
      `/api/projects/${PROJECT_ID}/users/${USER_ID}/ensure-chatter`,
      {}
    );

    expect(created.statusCode).toBe(200);
    expect(created.body).toEqual({ thread_id: THREAD_ID, status: "created" });
    expect(existsSync(path.join(memoryRoot, USER_ID, "seed-data", "intro.txt"))).toBe(true);
    expect(existsSync(path.join(memoryRoot, USER_ID, ".seeds_initialized"))).toBe(true);

    const role = runner.getRole(THREAD_ID);
    expect(role).toBeInstanceOf(ChatterRole);
    const chatter = role as ChatterRole;

    await expect(chatter.handleAgentToolCall("structured.upsert", {
      type: "template_short_drama",
      key: "template-001",
      record: {
        id: "template-001",
        title: "Opening Hook",
        beats: ["cold open", "choice point"]
      }
    })).resolves.toMatchObject({
      record: {
        id: "template-001",
        title: "Opening Hook"
      }
    });

    await expect(chatter.handleAgentToolCall("structured.query", {
      type: "template_short_drama",
      where: { field: "title", op: "eq", value: "Opening Hook" }
    })).resolves.toMatchObject({
      records: [
        {
          id: "template-001",
          title: "Opening Hook"
        }
      ]
    });

    await runner.dispatch(makeInboundTurn("draft the first scene", {
      mode: "session",
      chatter_session_id: "ads-session-bgate",
      system_prompt_id: "create_from_template",
      context_refs: [{ type: "template_short_drama", key: "template-001" }]
    }));
    const spawn = sent.find((message) => message.intent === "spawn")!;
    expect(spawn).toBeDefined();

    await runner.dispatch(makeSpawnResponse(spawn, "codex-bgate-agent"));
    const run = sent.find((message) => message.intent === "run" && message.target === "codex-bgate-agent")!;
    expect(run).toBeDefined();
    expect(run.payload.content).toContain("SYSTEM: BATCH-2-GATE create from template");
    expect(run.payload.content).toContain("## Pre-loaded context");
    expect(run.payload.content).toContain('"title": "Opening Hook"');
    expect(run.payload.content).toContain("draft the first scene");

    await runner.dispatch({
      trace_id: run.trace_id,
      thread_id: "codex-bgate-agent",
      source: "codex-bgate-agent",
      status: "success",
      run_state: "completed",
      content: "synthetic fixture reply",
      attachments: [],
      timestamp: new Date().toISOString()
    });
    expect(sent.some((message) => (
      message.target === "global" && message.payload.content === "synthetic fixture reply"
    ))).toBe(true);

    sent.length = 0;
    const readOnlyStarted = performance.now();
    await runner.dispatch(makeInboundTurn("", {
      read_only_query: {
        skill: "structured.get",
        args: { type: "template_short_drama", key: "template-001" }
      }
    }));
    const readOnlyElapsedMs = performance.now() - readOnlyStarted;

    expect(readOnlyElapsedMs).toBeLessThan(100);
    expect(sent.find((message) => message.intent === "spawn")).toBeUndefined();
    expect(sent.find((message) => message.target !== "global")).toBeUndefined();
    const readOnlyReply = sent.find((message) => message.target === "global")!;
    expect(readOnlyReply.payload.chatter?.read_only_query_result).toEqual({
      ok: true,
      result: {
        record: {
          id: "template-001",
          title: "Opening Hook",
          beats: ["cold open", "choice point"]
        }
      }
    });

    const archived = await invokeSigned(
      provisioner.handle,
      "POST",
      `/api/projects/${PROJECT_ID}/users/${USER_ID}/archive-chatter`,
      {}
    );
    expect(archived.statusCode).toBe(200);
    expect(archived.body).toEqual({ archived: true });
    expect(runner.getRole(THREAD_ID)).toBeNull();

    await fs.rm(policyPath);
    expect(existsSync(policyPath)).toBe(false);
  });

  it("rejects caller-supplied policy overrides before fixture chatter creation", async () => {
    process.env.ADS_HMAC_KEY = HMAC_SECRET;
    const repoRoot = await createTempDir("meridian-bgate-repo-");
    const memoryRoot = await createTempDir("meridian-bgate-memory-");
    const fixtureRoot = await createTempDir("meridian-bgate-fixture-");
    const seedsRoot = path.join(fixtureRoot, "seeds");
    const manifestPath = await writeFixtureManifest(fixtureRoot, seedsRoot);
    await writePolicy(repoRoot, PROJECT_ID, makePolicy(memoryRoot, manifestPath, seedsRoot));
    await writeCaller(repoRoot, PROJECT_ID);
    const callerRegistry = await loadCallerRegistry({ repoRoot });
    const createRole = vi.fn();
    const provisioner = createAutoProvisionerHandlers({
      repoRoot,
      stateStore: new MemoryStateStore(),
      createRole,
      deactivateRole: vi.fn(),
      callerAuth: createRequireCallerAuth({ registry: callerRegistry })
    });

    const response = await invokeSigned(
      provisioner.handle,
      "POST",
      `/api/projects/${PROJECT_ID}/users/${USER_ID}/ensure-chatter`,
      { memory_folder: "/etc" }
    );

    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual({
      error: "denied_caller_policy_override",
      offending_keys: ["memory_folder"]
    });
    expect(createRole).not.toHaveBeenCalled();
  });
});

async function writeFixtureManifest(fixtureRoot: string, seedsRoot: string): Promise<string> {
  const promptsDir = path.join(fixtureRoot, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });
  await fs.mkdir(path.join(seedsRoot, "seed-data"), { recursive: true });
  await fs.writeFile(path.join(promptsDir, "create_from_template.md"), "SYSTEM: BATCH-2-GATE create from template", "utf8");
  await fs.writeFile(path.join(seedsRoot, "seed-data", "intro.txt"), "fixture seed", "utf8");

  const manifestPath = path.join(fixtureRoot, "manifest.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: { conversation_log: "turns/<turn_id>.md" },
      record_schemas: {
        template_short_drama: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            beats: { type: "array", items: { type: "string" } }
          },
          required: ["id", "title", "beats"],
          additionalProperties: false,
          "x-indexed-fields": ["title"]
        }
      },
      system_prompts: {
        create_from_template: { prompt_path: "prompts/create_from_template.md" }
      },
      read_only_allowlist: ["structured.get"],
      seeds_init: { mode: "copy_on_provision", source_path: seedsRoot }
    }, null, 2)}\n`,
    "utf8"
  );
  return manifestPath;
}

function makePolicy(memoryRoot: string, manifestPath: string, seedsRoot: string): ProjectPolicy {
  return {
    project_id: PROJECT_ID,
    thread_id_pattern: "chatter-bgate-user-{user_id}",
    memory_folder_pattern: `${memoryRoot}/{user_id}`,
    manifest_path: manifestPath,
    seeds_source_path: seedsRoot,
    allowed_modes: ["session", "stateless"],
    skill_allowlist: ["structured.upsert", "structured.get", "structured.query"],
    llm_agent_kind: "claude-code",
    credential_id: null,
    user_reply_channel_template: ADS_REPLY_CHANNEL,
    seeds_init: { mode: "copy_on_provision", source_path: seedsRoot }
  };
}

async function writePolicy(repoRoot: string, projectId: string, policy: ProjectPolicy): Promise<string> {
  const filePath = path.join(repoRoot, "config", "projects", `${projectId}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return filePath;
}

async function writeCaller(repoRoot: string, projectId: string): Promise<void> {
  const filePath = path.join(repoRoot, "config", "callers", "ads.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: [projectId]
    }, null, 2)}\n`,
    "utf8"
  );
}

function makeInboundTurn(
  content: string,
  chatter: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>
): HubResult {
  return {
    trace_id: crypto.randomUUID(),
    thread_id: THREAD_ID,
    source: "ads",
    status: "success",
    content,
    attachments: [],
    payload: { chatter },
    timestamp: new Date().toISOString()
  };
}

function makeSpawnResponse(spawn: HubMessage, agentThreadId: string): HubResult {
  return {
    trace_id: spawn.trace_id,
    thread_id: agentThreadId,
    source: String(spawn.target),
    status: "success",
    content: `spawned ${agentThreadId}`,
    attachments: [],
    timestamp: new Date().toISOString()
  };
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
  return { "x-meridian-caller-signature": `sha256=${sign(body, HMAC_SECRET)}` };
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

class MemoryStateStore {
  private state: AppState | null = null;

  async load(): Promise<AppState | null> {
    return this.state ? JSON.parse(JSON.stringify(this.state)) : null;
  }

  async save(state: AppState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.add(directory);
  return directory;
}

function silentLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}
