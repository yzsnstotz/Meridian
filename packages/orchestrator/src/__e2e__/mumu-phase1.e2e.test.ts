import * as crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RoleRunner } from "../roles/role-runner";
import { RoleRegistry } from "../roles/role-registry";
import { ChatterRole } from "../roles/definitions/chatter";
import { createRoleHandlers } from "../server/role-handlers";
import {
  ChatterRoleConfigSchema,
  type AppState,
  type HubMessage,
  type HubResult
} from "../types";
import {
  resetChatterObservabilityForTests,
  snapshotChatterReadOnlyQueryCounters
} from "../roles/chatter/observability";
import { createAutoProvisionerHandlers } from "../web/auto-provisioner";
import { createRequireCallerAuth } from "../web/caller-auth-middleware";
import { loadCallerRegistry } from "../web/caller-registry";
import type { ProjectPolicy } from "../web/project-policy-schema";

const WORKTREE_ROOT = path.resolve(__dirname, "..", "..");
const ADS_WORKTREE = "/workspace/projects/ADS/.worktrees/mumu-phase1";
const MERIDIAN_ROOT = "/workspace/Meridian";
const requireExternal = createRequire(__filename);
const REAL_MUMU_CONFIG_ROOT = path.join(WORKTREE_ROOT, "config", "projects", "mumu");
const REAL_MUMU_POLICY_PATH = path.join(WORKTREE_ROOT, "config", "projects", "mumu.json");
const TEST_HMAC_SECRET = "v-01-a-local-hmac-key";
const TEST_CALLER_ID = "ads-prod";
const PROJECT_ID = "mumu";
const TEMPLATE_ID = "chuanyue-nixi";

type AdsModules = {
  closeDatabaseForTests: () => void;
  initializeDatabase: () => unknown;
  createUser: (username: string, password: string, role: string, displayName?: string) => Promise<{ id: string; role: string }>;
  replaceGrantsForUser: (userId: string, grants: string[], expiresAt: string | null) => void;
  createPostLoginSession: (
    user: { id: string; role: string },
    dependencies?: {
      ensureChatter?: (input: { user_id: string }) => Promise<{ thread_id: string; status: "created" | "existing" }>;
      now?: () => number;
    }
  ) => Promise<{ mumu_thread_id?: string }>;
  MumuProvisionerClient: new (config: {
    baseUrl: string;
    hmacKey: string;
    callerId: string;
    retryDelaysMs: readonly number[];
    perRequestTimeoutMs: number;
    totalTimeoutMs: number;
  }) => {
    ensureChatter(input: { user_id: string }): Promise<{ thread_id: string; status: "created" | "existing" }>;
    archiveChatter(input: { user_id: string }): Promise<{ archived: boolean }>;
    getChatter(input: { user_id: string }): Promise<{ thread_id: string; status: string } | null>;
  };
  MumuProvisioningFailedError: new (...args: unknown[]) => Error;
  ProvisionerAuthError: new (...args: unknown[]) => Error;
  ProvisionerProjectNotRegisteredError: new (...args: unknown[]) => Error;
  MumuChatterRouter: new (
    transport: { send(message: HubMessage): Promise<void> },
    options?: Record<string, unknown>
  ) => {
    routeCreateFromTemplate(input: {
      user_id: string;
      content: string;
      template_id: string;
      mumu_thread_id?: string;
      chatter_session_id?: string;
    }, options?: { operation_hint?: string; connection?: { send(event: unknown): void | Promise<void> } }): Promise<HubMessage>;
    sendTurn(input: {
      user_id: string;
      mumu_thread_id?: string;
      content: string;
      mode: "session" | "stateless";
      chatter_session_id?: string;
      control?: "confirm_observation" | "reject_observation";
      observation_id?: string;
      read_only_query?: { skill: string; args: Record<string, unknown> };
    }, options?: { connection?: { send(event: unknown): void | Promise<void> } }): Promise<HubMessage>;
    handleHubResult(rawResult: unknown): Promise<boolean>;
    registerFrontendConnection(
      chatterSessionId: string,
      connection: { send(event: unknown): void | Promise<void> },
      options?: { user_id?: string; mumu_thread_id?: string }
    ): void;
    unregisterFrontendConnection(chatterSessionId: string): void;
  };
  createMumuReadOnlyQueryClient: (options: {
    router: InstanceType<AdsModules["MumuChatterRouter"]>;
    now?: () => number;
  }) => {
    readOnlyQuery(input: {
      user_id: string;
      skill: string;
      args: Record<string, unknown>;
      mumu_thread_id?: string;
      timeout_ms?: number;
    }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  };
  getCounterValue: (name: string, labels?: Record<string, string>) => number;
  resetMetricsForTests: () => void;
  MUMU_LLM_TURN_TOTAL_METRIC: string;
};

type HubModules = {
  startIntegrationHub: () => Promise<{
    hubSocketPath: string;
    cleanup: () => Promise<void>;
  }>;
  sendHubIpc: (socketPath: string, message: HubMessage) => Promise<HubResult>;
};

interface AgentToolCallTrace {
  thread_id: string;
  name: "structured.upsert" | "chatter.suggest_observation";
  origin: "create_from_template" | "style_observe";
  key?: string;
}

class MemoryStateStore {
  private state: AppState | null = null;

  async load(): Promise<AppState | null> {
    return this.state ? JSON.parse(JSON.stringify(this.state)) : null;
  }

  async save(state: AppState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }

  snapshot(): AppState | null {
    return this.state ? JSON.parse(JSON.stringify(this.state)) : null;
  }
}

class ManualScheduler {
  readonly scheduled: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];

  setTimeout(callback: () => void, ms: number): number {
    this.scheduled.push({ callback, ms, cleared: false });
    return this.scheduled.length - 1;
  }

  clearTimeout(timer: number): void {
    this.scheduled[timer]!.cleared = true;
  }
}

interface HarnessContext {
  root: string;
  repoRoot: string;
  memoryRoot: string;
  dataDir: string;
  now: Date;
  stateStore: MemoryStateStore;
  runner: RoleRunner;
  sentToHub: HubMessage[];
  adsEvents: unknown[];
  agentToolCalls: AgentToolCallTrace[];
  hub: Awaited<ReturnType<HubModules["startIntegrationHub"]>>;
  ads: AdsModules;
  router: InstanceType<AdsModules["MumuChatterRouter"]>;
  provisionerBaseUrl: string;
  validClient: InstanceType<AdsModules["MumuProvisionerClient"]>;
  badClient: InstanceType<AdsModules["MumuProvisionerClient"]>;
  provisionerServer: Server;
}

let context: HarnessContext | null = null;
let originalEnv: Record<string, string | undefined>;

describe("V-01-A mumu Phase 1 e2e critical paths", () => {
  beforeEach(async () => {
    originalEnv = snapshotEnv([
      "ADS_HMAC_KEY",
      "DATA_DIR",
      "JWT_SECRET",
      "MUMU_PROVISIONER_URL",
      "MUMU_PROVISIONER_HMAC_KEY",
      "MUMU_PROVISIONER_CALLER_ID"
    ]);
    resetChatterObservabilityForTests();
    context = await createHarness();
  }, 45_000);

  afterEach(async () => {
    if (context) {
      await closeServer(context.provisionerServer);
      await context.hub.cleanup();
      context.ads.closeDatabaseForTests();
      await fs.rm(context.root, { recursive: true, force: true });
      context = null;
    }
    restoreEnv(originalEnv);
    resetChatterObservabilityForTests();
  });

  it("covers cold start, background observation confirmation, read-only bypass, bad-signature sad path, and cleanup", async () => {
    const ctx = requireHarness();
    const username = `v01a-${crypto.randomUUID()}`;
    const sadUsername = `v01a-sad-${crypto.randomUUID()}`;
    const createdUsers: string[] = [];

    try {
      const login = await simulateMumuLogin(ctx, username, ctx.validClient);
      const userId = login.user.id;
      const threadId = `chatter-mumu-user-${userId}`;
      createdUsers.push(userId);
      expect(login.session.mumu_thread_id).toBe(threadId);
      const chatter = requireChatter(ctx, threadId);
      await expect(ctx.validClient.getChatter({ user_id: userId })).resolves.toMatchObject({
        thread_id: threadId,
        status: "active"
      });
      const seed = await upsertCopiedTemplateSeed(ctx, chatter, userId, TEMPLATE_ID);

      await ctx.router.routeCreateFromTemplate(
        {
          user_id: userId,
          mumu_thread_id: threadId,
          content: "想要个穿越逆袭",
          template_id: TEMPLATE_ID,
          chatter_session_id: "story-create-1"
        },
        {
          operation_hint: "outline",
          connection: { send: (event) => { ctx.adsEvents.push(event); } }
        }
      );

      await waitFor(() => ctx.adsEvents.some((event) => isChatterReply(event)), "ADS did not receive story-create reply");
      const createRun = ctx.sentToHub.find((message) => (
        message.intent === "run"
        && message.payload.content.includes("System prompt for this turn:")
        && message.payload.content.includes(`"title": "${seed.title}"`)
      ));
      expect(createRun?.payload.content).toContain("想要个穿越逆袭");
      expect(createRun?.payload.content).toContain("## Pre-loaded context");

      await expect(chatter.handleAgentToolCall("structured.list", {
        type: "story_short_drama"
      })).resolves.toMatchObject({ keys: ["story-1"] });
      expect(ctx.agentToolCalls).toEqual(expect.arrayContaining([
        {
          thread_id: threadId,
          name: "structured.upsert",
          origin: "create_from_template",
          key: "story-1"
        }
      ]));

      ctx.router.registerFrontendConnection(
        "style-profile-tab",
        { send: (event) => { ctx.adsEvents.push(event); } },
        { user_id: userId, mumu_thread_id: threadId }
      );

      for (let index = 2; index <= 5; index += 1) {
        await ctx.router.routeCreateFromTemplate({
          user_id: userId,
          mumu_thread_id: threadId,
          content: `继续生成第 ${index} 个短剧大纲`,
          template_id: TEMPLATE_ID,
          chatter_session_id: `story-create-${index}`
        });
      }
      await expect(chatter.handleAgentToolCall("structured.list", {
        type: "story_short_drama"
      })).resolves.toMatchObject({ keys: ["story-1", "story-2", "story-3", "story-4", "story-5"] });

      await waitFor(
        () => ctx.sentToHub.some((message) => message.payload.chatter?.origin === "trigger"),
        "background trigger did not dispatch a self-initiated turn"
      );

      await waitFor(
        () => ctx.adsEvents.some((event) => isCandidateObservationEvent(event)),
        "ADS did not receive candidate_observation"
      );
      expect(ctx.agentToolCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          thread_id: threadId,
          name: "chatter.suggest_observation",
          origin: "style_observe"
        })
      ]));
      const observationId = requireCandidateObservation(ctx.adsEvents).payload.observation_id;

      await ctx.router.sendTurn({
        user_id: userId,
        mumu_thread_id: threadId,
        content: "",
        mode: "stateless",
        chatter_session_id: "style-confirm-1",
        control: "confirm_observation",
        observation_id: observationId
      }, {
        connection: { send: (event) => { ctx.adsEvents.push(event); } }
      });

      await waitFor(
        () => ctx.adsEvents.some((event) => isChatterReply(event) && JSON.stringify(event).includes("observation_confirmed")),
        "ADS did not receive observation confirmation reply"
      );
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "style_short_drama",
        key: userId
      })).resolves.toMatchObject({
        record: {
          agent_observed: {
            recurring_motifs: ["穿越逆袭", "身份反转"],
            confirmed_at: expect.any(String)
          }
        }
      });

      const readOnlyClient = ctx.ads.createMumuReadOnlyQueryClient({
        router: ctx.router,
        now: (() => {
          let value = 1_000;
          return () => {
            const current = value;
            value += 42;
            return current;
          };
        })()
      });
      const llmTurnsBefore = ctx.ads.getCounterValue(ctx.ads.MUMU_LLM_TURN_TOTAL_METRIC);
      const readOnlyStarted = performance.now();
      const styleRead = await readOnlyClient.readOnlyQuery({
        user_id: userId,
        mumu_thread_id: threadId,
        skill: "structured.get",
        args: { type: "style_short_drama", key: userId },
        timeout_ms: 1_000
      });
      const readOnlyElapsedMs = performance.now() - readOnlyStarted;

      expect(styleRead).toMatchObject({ ok: true });
      expect(readOnlyElapsedMs).toBeLessThan(100);
      expect(snapshotChatterReadOnlyQueryCounters()).toEqual({ "structured.get|ok": 1 });
      expect(ctx.ads.getCounterValue(ctx.ads.MUMU_LLM_TURN_TOTAL_METRIC)).toBe(llmTurnsBefore);

      const sadUser = await ctx.ads.createUser(sadUsername, "password", "tester");
      ctx.ads.replaceGrantsForUser(sadUser.id, ["ads"], null);
      const sadLogin = ctx.ads.createPostLoginSession(sadUser, {
        ensureChatter: (input) => ctx.badClient.ensureChatter(input)
      });
      await expect(sadLogin).rejects.toMatchObject({
        statusCode: 502,
        responseBody: {
          ok: false,
          code: "mumu_provisioning_failed"
        },
        cause: expect.any(ctx.ads.ProvisionerAuthError)
      });
      await expect(ctx.validClient.getChatter({ user_id: sadUser.id }))
        .rejects.toBeInstanceOf(ctx.ads.ProvisionerProjectNotRegisteredError);
      expect(ctx.runner.getRole(`chatter-mumu-user-${sadUser.id}`)).toBeNull();
      expect(JSON.stringify(ctx.stateStore.snapshot())).not.toContain(sadUser.id);
    } finally {
      const archiveResults = await Promise.all(
        createdUsers.map((createdUserId) => ctx.validClient.archiveChatter({ user_id: createdUserId }))
      );
      for (const archiveResult of archiveResults) {
        expect(archiveResult).toEqual({ archived: true });
      }
    }

    for (const createdUserId of createdUsers) {
      expect(ctx.runner.getRole(`chatter-mumu-user-${createdUserId}`)).toBeNull();
      expect(JSON.stringify(ctx.stateStore.snapshot())).not.toContain(createdUserId);
    }
  }, 90_000);
});

async function createHarness(): Promise<HarnessContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mumu-v01a-"));
  const repoRoot = path.join(root, "meridian-roles-repo");
  const memoryRoot = path.join(root, "memory");
  const dataDir = path.join(root, "ads-data");
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(memoryRoot, { recursive: true });
  await writeProjectFixture(repoRoot, memoryRoot);
  await writeCaller(repoRoot);

  process.env.ADS_HMAC_KEY = TEST_HMAC_SECRET;
  process.env.DATA_DIR = dataDir;
  process.env.JWT_SECRET = "v-01-a-jwt-secret";
  process.env.MUMU_PROVISIONER_HMAC_KEY = TEST_HMAC_SECRET;
  process.env.MUMU_PROVISIONER_CALLER_ID = TEST_CALLER_ID;

  const ads = await loadAdsModules();
  const hubModules = await loadHubModules();
  ads.closeDatabaseForTests();
  ads.resetMetricsForTests();
  ads.initializeDatabase();

  const hub = await hubModules.startIntegrationHub();
  const stateStore = new MemoryStateStore();
  let runner: RoleRunner;
  let router: InstanceType<AdsModules["MumuChatterRouter"]>;
  const sentToHub: HubMessage[] = [];
  const adsEvents: unknown[] = [];
  const agentToolCalls: AgentToolCallTrace[] = [];
  const storyCountsByThread = new Map<string, number>();

  runner = new RoleRunner({
    sendToHub: async (message) => {
      const hubMessage = message as HubMessage;
      sentToHub.push(hubMessage);
      if (hubMessage.target === "global") {
        await router.handleHubResult(messageToAdsHubResult(hubMessage));
        return;
      }

      const result = await hubModules.sendHubIpc(hub.hubSocketPath, {
        ...hubMessage,
        suppress_reply: true
      });
      await applyDeterministicMumuAgentToolEffects({
        runner,
        storyCountsByThread,
        agentToolCalls
      }, hubMessage);
      await runner.dispatch(result);
    },
    log: silentLog()
  });

  const registry = new RoleRegistry();
  registry.register("chatter", (threadId, config) =>
    new ChatterRole(threadId, ChatterRoleConfigSchema.parse(config), {
      now: () => requireHarness().now
    })
  );
  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    log: silentLog()
  });
  const callerRegistry = await loadCallerRegistry({ repoRoot });
  const handlers = createAutoProvisionerHandlers({
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
  const provisionerServer = createServer((request, response) => {
    void handlers.handle(request, response).then((handled) => {
      if (!handled && !response.headersSent) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not_found" }));
      }
    }).catch((error: unknown) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  const provisionerPort = await listenOnLocalhost(provisionerServer);
  const provisionerBaseUrl = `http://127.0.0.1:${provisionerPort}/api/projects/mumu`;
  process.env.MUMU_PROVISIONER_URL = provisionerBaseUrl;

  router = new ads.MumuChatterRouter({
    send: async (message: HubMessage) => {
      await runner.dispatch(messageToInboundResult(message));
    }
  }, {
    scheduler: new ManualScheduler()
  });

  const validClient = new ads.MumuProvisionerClient({
    baseUrl: provisionerBaseUrl,
    hmacKey: TEST_HMAC_SECRET,
    callerId: TEST_CALLER_ID,
    retryDelaysMs: [],
    perRequestTimeoutMs: 1_000,
    totalTimeoutMs: 1_000
  });
  const badClient = new ads.MumuProvisionerClient({
    baseUrl: provisionerBaseUrl,
    hmacKey: "wrong-v-01-a-hmac-key",
    callerId: TEST_CALLER_ID,
    retryDelaysMs: [],
    perRequestTimeoutMs: 1_000,
    totalTimeoutMs: 1_000
  });

  return {
    root,
    repoRoot,
    memoryRoot,
    dataDir,
    now: new Date("2026-05-21T00:00:00.000Z"),
    stateStore,
    runner,
    sentToHub,
    adsEvents,
    agentToolCalls,
    hub,
    ads,
    router,
    provisionerBaseUrl,
    validClient,
    badClient,
    provisionerServer
  };
}

async function writeProjectFixture(repoRoot: string, memoryRoot: string): Promise<void> {
  const configRoot = path.join(repoRoot, "config", "projects");
  const fixtureRoot = path.join(configRoot, "mumu");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.cp(REAL_MUMU_CONFIG_ROOT, fixtureRoot, { recursive: true });

  const manifestPath = path.join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    background_triggers?: Array<{ throttle?: { min_interval?: string } }>;
  };
  if (manifest.background_triggers?.[0]?.throttle) {
    manifest.background_triggers[0].throttle.min_interval = "1s";
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const policy = JSON.parse(await fs.readFile(REAL_MUMU_POLICY_PATH, "utf8")) as ProjectPolicy;
  await fs.writeFile(
    path.join(configRoot, "mumu.json"),
    `${JSON.stringify({
      ...policy,
      memory_folder_pattern: `${memoryRoot}/{user_id}`,
      manifest_path: manifestPath,
      seeds_source_path: path.join(fixtureRoot, "seeds"),
      // The real HubServer integration helper uses a deterministic agentapi process for cursor.
      llm_agent_kind: "cursor"
    }, null, 2)}\n`,
    "utf8"
  );
}

async function writeCaller(repoRoot: string): Promise<void> {
  const callerPath = path.join(repoRoot, "config", "callers", "ads.json");
  await fs.mkdir(path.dirname(callerPath), { recursive: true });
  await fs.writeFile(
    callerPath,
    `${JSON.stringify({
      caller_id: TEST_CALLER_ID,
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: [PROJECT_ID]
    }, null, 2)}\n`,
    "utf8"
  );
}

async function simulateMumuLogin(
  ctx: HarnessContext,
  username: string,
  client: InstanceType<AdsModules["MumuProvisionerClient"]>
): Promise<{ user: { id: string; role: string }; session: { mumu_thread_id?: string } }> {
  const user = await ctx.ads.createUser(username, "password", "tester");
  ctx.ads.replaceGrantsForUser(user.id, ["ads"], null);
  const session = await ctx.ads.createPostLoginSession(user, {
    ensureChatter: (input) => client.ensureChatter(input),
    now: (() => {
      let value = 10_000;
      return () => {
        const current = value;
        value += 25;
        return current;
      };
    })()
  });
  return { user, session };
}

async function upsertCopiedTemplateSeed(
  ctx: HarnessContext,
  chatter: ChatterRole,
  userId: string,
  templateId: string
): Promise<{ id: string; title: string }> {
  const seedPath = path.join(ctx.memoryRoot, userId, "templates", "short_drama", `${templateId}.json`);
  expect(existsSync(seedPath)).toBe(true);
  const seed = JSON.parse(await fs.readFile(seedPath, "utf8")) as { id: string; title: string };
  await expect(chatter.handleAgentToolCall("structured.upsert", {
    type: "template_short_drama",
    key: seed.id,
    record: seed
  })).resolves.toMatchObject({
    record: {
      id: seed.id,
      title: seed.title
    }
  });
  return seed;
}

async function applyDeterministicMumuAgentToolEffects(
  options: {
    runner: RoleRunner;
    storyCountsByThread: Map<string, number>;
    agentToolCalls: AgentToolCallTrace[];
  },
  message: HubMessage
): Promise<void> {
  if (message.intent !== "run" || message.target === "global") {
    return;
  }

  const chatter = options.runner.getRole(message.thread_id);
  if (!(chatter instanceof ChatterRole)) {
    return;
  }

  if (
    message.payload.chatter?.origin === "trigger"
    && message.payload.chatter.system_prompt_id === "style_observe"
  ) {
    const userId = userIdFromMumuThreadId(message.thread_id);
    if (!userId) {
      return;
    }

    options.agentToolCalls.push({
      thread_id: message.thread_id,
      name: "chatter.suggest_observation",
      origin: "style_observe"
    });
    await expect(chatter.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "User keeps choosing reversal-heavy revenge setups.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: userId,
        patch: {
          agent_observed: {
            recurring_motifs: ["穿越逆袭", "身份反转"]
          }
        }
      }
    })).resolves.toMatchObject({ ok: true });
    return;
  }

  if (!isCreateFromTemplateAgentRun(message)) {
    return;
  }

  const nextStoryNumber = (options.storyCountsByThread.get(message.thread_id) ?? 0) + 1;
  options.storyCountsByThread.set(message.thread_id, nextStoryNumber);
  const storyId = `story-${nextStoryNumber}`;
  options.agentToolCalls.push({
    thread_id: message.thread_id,
    name: "structured.upsert",
    origin: "create_from_template",
    key: storyId
  });
  await expect(chatter.handleAgentToolCall("structured.upsert", {
    type: "story_short_drama",
    key: storyId,
    record: buildStoryRecord(storyId, TEMPLATE_ID)
  })).resolves.toMatchObject({ record: { id: storyId, template_id: TEMPLATE_ID } });
}

function isCreateFromTemplateAgentRun(message: HubMessage): boolean {
  return (
    message.payload.content.includes("System prompt for this turn:")
    && message.payload.content.includes("create_from_template")
    && message.payload.content.includes("structured.upsert('story_short_drama'")
  );
}

function buildStoryRecord(storyId: string, templateId: string): Record<string, unknown> {
  return {
    id: storyId,
    template_id: templateId,
    outline: {
      arc: `${storyId} reversal arc`,
      episodes: [
        {
          no: 1,
          hook: "身份错位开场",
          cliff: "主角发现隐藏身份"
        }
      ]
    },
    fragments: []
  };
}

function userIdFromMumuThreadId(threadId: string): string | null {
  const prefix = "chatter-mumu-user-";
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : null;
}

function requireChatter(ctx: HarnessContext, threadId: string): ChatterRole {
  const role = ctx.runner.getRole(threadId);
  expect(role).toBeInstanceOf(ChatterRole);
  return role as ChatterRole;
}

function messageToInboundResult(message: HubMessage): HubResult {
  return {
    trace_id: message.trace_id,
    thread_id: message.thread_id,
    source: "ads",
    status: "success",
    content: message.payload.content,
    attachments: [],
    timestamp: new Date().toISOString(),
    payload: { chatter: message.payload.chatter }
  };
}

function messageToAdsHubResult(message: HubMessage): HubResult {
  return {
    trace_id: message.trace_id,
    thread_id: message.thread_id,
    source: message.thread_id,
    status: "success",
    run_state: "completed",
    content: message.payload.content,
    attachments: [],
    timestamp: new Date().toISOString(),
    payload: { chatter: message.payload.chatter }
  };
}

async function loadAdsModules(): Promise<AdsModules> {
  const [
    db,
    userService,
    grants,
    postLogin,
    provisioner,
    chatterRouter,
    readOnly,
    metrics
  ] = await Promise.all([
    importFromAds("src/db/index.ts"),
    importFromAds("src/services/user-service.ts"),
    importFromAds("src/services/gateway-access-service.ts"),
    importFromAds("src/auth/post-login-hook.ts"),
    importFromAds("src/services/mumu-provisioner-client.ts"),
    importFromAds("src/gateway/mumu-chatter-router.ts"),
    importFromAds("src/gateway/mumu-read-only-query.ts"),
    importFromAds("src/services/metrics.ts")
  ]);

  return {
    closeDatabaseForTests: db.closeDatabaseForTests,
    initializeDatabase: db.initializeDatabase,
    createUser: userService.createUser,
    replaceGrantsForUser: grants.replaceGrantsForUser,
    createPostLoginSession: postLogin.createPostLoginSession,
    MumuProvisioningFailedError: postLogin.MumuProvisioningFailedError,
    MumuProvisionerClient: provisioner.MumuProvisionerClient,
    ProvisionerAuthError: provisioner.ProvisionerAuthError,
    ProvisionerProjectNotRegisteredError: provisioner.ProvisionerProjectNotRegisteredError,
    MumuChatterRouter: chatterRouter.MumuChatterRouter,
    createMumuReadOnlyQueryClient: readOnly.createMumuReadOnlyQueryClient,
    MUMU_LLM_TURN_TOTAL_METRIC: readOnly.MUMU_LLM_TURN_TOTAL_METRIC,
    getCounterValue: metrics.getCounterValue,
    resetMetricsForTests: metrics.resetMetricsForTests
  };
}

async function loadHubModules(): Promise<HubModules> {
  const { HubServer } = requireExternal(path.join(MERIDIAN_ROOT, "dist", "hub", "server.js"));
  const { HubRouter } = requireExternal(path.join(MERIDIAN_ROOT, "dist", "hub", "router.js"));
  const { InstanceManager } = requireExternal(path.join(MERIDIAN_ROOT, "dist", "hub", "instance-manager.js"));
  const { InstanceRegistry } = requireExternal(path.join(MERIDIAN_ROOT, "dist", "hub", "registry.js"));
  const { PaneBroadcaster } = requireExternal(path.join(MERIDIAN_ROOT, "dist", "hub", "pane-broadcaster.js"));
  const { ResultSender } = requireExternal(path.join(MERIDIAN_ROOT, "dist", "hub", "result-sender.js"));
  const { SocketChannelAdapter } = requireExternal(path.join(MERIDIAN_ROOT, "dist", "hub", "socket-adapter.js"));
  const stubAgentapiPath = path.join(MERIDIAN_ROOT, "tests", "fixtures", "stub-agentapi.mjs");
  let activeRouter: { route(message: HubMessage): Promise<HubResult> } | null = null;

  class NoOpChannelAdapter {
    constructor(readonly channel: "telegram" | "web") {}
    canHandle(replyChannel: { channel: string }): boolean {
      return replyChannel.channel === this.channel;
    }
    async send(): Promise<void> {}
  }

  async function startIntegrationHub(): Promise<Awaited<ReturnType<HubModules["startIntegrationHub"]>>> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v01a-hub-"));
    const hubSocketPath = path.join(tempDir, "hub.sock");
    const statePath = path.join(tempDir, "state.json");
    const logDir = path.join(tempDir, "log");
    await fs.mkdir(logDir, { recursive: true });

    const socketPathFactory = (threadId: string) => path.join(tempDir, `agentapi-${threadId}.sock`);
    const registry = new InstanceRegistry();
    const spawnFn = (_command: string, args: string[], options: object) =>
      nodeSpawn(process.execPath, [stubAgentapiPath, ...args], options);
    const instanceManager = new InstanceManager(registry, {
      agentapiBinPath: stubAgentapiPath,
      logDir,
      socketPathFactory,
      spawnFn,
      agentapiSocketSupport: true,
      agentapiAttachSocketSupport: false
    });
    const router = new HubRouter(registry, { instanceManager, statePath });
    activeRouter = router;
    const hubServer = new HubServer({
      socketPath: hubSocketPath,
      router,
      resultSender: new ResultSender([
        new SocketChannelAdapter(),
        new NoOpChannelAdapter("telegram"),
        new NoOpChannelAdapter("web")
      ]),
      paneBroadcaster: new PaneBroadcaster({ logDir }),
      staticServiceEndpoints: []
    });

    await hubServer.start();
    return {
      hubSocketPath,
      cleanup: async () => {
        await hubServer.stop();
        activeRouter = null;
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    };
  }

  return {
    startIntegrationHub,
    sendHubIpc: (_socketPath, message) => {
      if (!activeRouter) {
        throw new Error("integration hub router is not active");
      }
      return activeRouter.route(message);
    }
  };
}

async function importFromAds(relativePath: string): Promise<Record<string, any>> {
  return import(pathToFileURL(path.join(ADS_WORKTREE, relativePath)).href);
}

function requireHarness(): HarnessContext {
  if (!context) {
    throw new Error("harness is not initialized");
  }
  return context;
}

function listenOnLocalhost(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label);
}

function isChatterReply(event: unknown): boolean {
  return isRecord(event) && event.type === "mumu_chatter_reply";
}

function isCandidateObservationEvent(
  event: unknown
): event is { type: "mumu.candidate_observation"; payload: { observation_id: string } } {
  return (
    isRecord(event)
    && event.type === "mumu.candidate_observation"
    && isRecord(event.payload)
    && typeof event.payload.observation_id === "string"
  );
}

function requireCandidateObservation(
  events: unknown[]
): { type: "mumu.candidate_observation"; payload: { observation_id: string } } {
  const event = events.find(isCandidateObservationEvent);
  expect(event).toBeDefined();
  return event!;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function silentLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}
