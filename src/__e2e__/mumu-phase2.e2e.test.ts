import * as crypto from "node:crypto";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RoleRunner } from "../roles/role-runner";
import { RoleRegistry } from "../roles/role-registry";
import { ChatterRole } from "../roles/definitions/chatter";
import { MumuMemoryGitSyncQueue } from "../roles/chatter/mumu-memory-git-sync";
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
const ADS_WORKTREE = process.env.MUMU_E2E_ADS_WORKTREE
  ? path.resolve(process.env.MUMU_E2E_ADS_WORKTREE)
  : path.join(os.homedir(), "work", "projects", "ADS", ".worktrees", "mumu-phase2");
const MERIDIAN_ROOT = path.resolve(WORKTREE_ROOT, "..", "..", "..");
const requireExternal = createRequire(__filename);
const REAL_MUMU_CONFIG_ROOT = path.join(WORKTREE_ROOT, "config", "projects", "mumu");
const REAL_MUMU_POLICY_PATH = path.join(WORKTREE_ROOT, "config", "projects", "mumu.json");
const TEST_HMAC_SECRET = "v-02-a-local-hmac-key";
const TEST_CALLER_ID = "ads-prod";
const PROJECT_ID = "mumu";
const TEMPLATE_ID = "chuanyue-nixi";
const USER_TEMPLATE_ID = "v02a-user-template";
const EXTRACTED_TEMPLATE_ID = "v02a-extracted-template";

type ExtractStage =
  | "uploaded"
  | "asking_genre"
  | "asking_main_hook"
  | "asking_cliff_pattern"
  | "asking_transition_types"
  | "awaiting_final_confirm"
  | "committed";

type AdsModules = {
  closeDatabaseForTests: () => void;
  initializeDatabase: () => unknown;
  createUser: (username: string, password: string, role: string, displayName?: string) => Promise<{ id: string; role: string }>;
  replaceGrantsForUser: (userId: string, grants: string[], expiresAt: string | null) => void;
  createPostLoginSession: (
    user: { id: string; role: string },
    dependencies?: {
      ensureChatter?: (input: { user_id: string }) => Promise<{ thread_id: string; status: "created" | "existing" }>;
      ensureArchive?: (input: { user_id: string }) => Promise<unknown>;
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
    memoryArchiveEnqueue(input: {
      user_id: string;
      event_kind: "structured_write" | "structured_delete" | "turn_write" | "direct_write" | "restore_write";
      repo_root?: string;
      record_type?: string;
      key?: string;
      archive?: MumuRemoteArchiveDescriptor;
    }): Promise<{ queued: true }>;
    createMemorySavepoint(input: {
      user_id: string;
      label?: string;
      archive?: MumuRemoteArchiveDescriptor;
    }): Promise<{ ok: true; queued: boolean; savepoint: { id: string; commit_sha: string; short_commit: string } }>;
    readMemorySavepoint(input: {
      user_id: string;
      savepoint_id: string;
    }): Promise<{
      ok: true;
      snapshot: {
        savepoint: { id: string; commit_sha: string };
        records: Array<{ type: string; key: string; record: unknown }>;
        style_records: Array<{ type: string; key: string; user_authored: unknown }>;
      };
    }>;
    restoreMemorySavepoint(input: {
      user_id: string;
      savepoint_id: string;
      scope?: { kind: "root" } | { kind: "record_type"; record_type: string } | { kind: "record"; record_type: string; key: string };
      archive?: MumuRemoteArchiveDescriptor;
    }): Promise<{ ok: true; queued: boolean; restore: { restore_commit_sha: string; previous_head_sha: string | null } }>;
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
      genre?: string;
      mumu_thread_id?: string;
      chatter_session_id?: string;
    }, options?: { operation_hint?: string; connection?: { send(event: unknown): void | Promise<void> } }): Promise<HubMessage>;
    routeOptimizeFromTemplate(input: {
      user_id: string;
      content: string;
      story_id: string;
      template_id: string;
      genre?: string;
      mumu_thread_id?: string;
      chatter_session_id?: string;
    }, options?: { operation_hint?: string; connection?: { send(event: unknown): void | Promise<void> } }): Promise<HubMessage>;
    routeExtractFromDraft(input: {
      user_id: string;
      draft_content?: string | null;
      extract_state?: { stage: ExtractStage; question?: string; options?: string[]; draft_template?: Record<string, unknown> };
      attachment_ref?: string;
      attachments?: Array<{ path: string; filename?: string; mime_type?: string }>;
      extract_session_id?: string;
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
    registerFrontendConnection(
      chatterSessionId: string,
      connection: { send(event: unknown): void | Promise<void> },
      options?: { user_id?: string; mumu_thread_id?: string }
    ): void;
    handleHubResult(rawResult: unknown): Promise<boolean>;
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
  createMumuExtractStateCache: (options: { ttlMs?: number; now?: () => number }) => MumuExtractStateCache;
  storeMumuUploadExtract(input: {
    user_id: string;
    file: { originalname: string; mimetype?: string; size: number; buffer: Buffer };
  }): Promise<{ attachment_ref: string; filename: string; mime_type: string; path: string; size: number }>;
  getMumuUploadExtractRecord(input: {
    user_id: string;
    attachment_ref: string;
  }): Promise<{ attachment_ref: string; path: string; filename: string }>;
  deleteMumuUploadExtract(input: { user_id: string; attachment_ref: string }): Promise<void>;
  resolveMumuUploadExtractAttachment(input: {
    user_id: string;
    attachment_ref: string;
  }): Promise<{ path: string; filename?: string; mime_type?: string }>;
  ensureMumuArchiveForUser(
    input: { user_id: string },
    dependencies?: { owner?: string; githubClient?: { ensurePrivateRepo(input: { owner: string; repoName: string }): Promise<MumuArchiveProvisionResult> } }
  ): Promise<MumuArchiveProvisionResult>;
  getMumuArchiveRemoteDescriptorForUser(userId: string): MumuRemoteArchiveDescriptor | null;
  recordMumuArchivePushStatus(input: {
    userId: string;
    status: string;
    lastPushedCommit?: string | null;
    lastErrorClass?: string | null;
    remoteBlockedReason?: string | null;
  }): void;
  getCounterValue: (name: string, labels?: Record<string, string>) => number;
  resetMetricsForTests: () => void;
  MUMU_LLM_TURN_TOTAL_METRIC: string;
};

type MumuArchiveProvisionResult = {
  status: "created_private" | "existing_private" | "blocked_public_repo" | "auth_failed" | "rate_limited" | "upstream_failed";
  owner: string;
  repoName: string;
  repoFullName: string;
  private: boolean | null;
  pushEnabled: boolean;
};

type MumuRemoteArchiveDescriptor = {
  push_enabled: boolean;
  state: "ready" | "blocked" | "disabled";
  owner: string;
  repo_name: string;
  repo_full_name: string;
  private: boolean | null;
  status_callback_url?: string;
};

type MumuExtractStateCache = {
  get(userId: string, extractSessionId: string): { state: { stage: ExtractStage }; expires_at_ms: number } | null;
  set(input: { user_id: string; extract_session_id: string; state: { stage: ExtractStage } }): unknown;
  clear(userId: string, extractSessionId: string): void;
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
  origin: "create_from_template" | "style_observe" | "optimize_from_template" | "extract_template_from_draft";
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
  seedsRoot: string;
  dataDir: string;
  now: Date;
  nowMs: number;
  stateStore: MemoryStateStore;
  runner: RoleRunner;
  adsToRolesMessages: HubMessage[];
  sentToHub: HubMessage[];
  adsEvents: unknown[];
  agentToolCalls: AgentToolCallTrace[];
  pushCalls: Array<{ repoFullName: string; commitSha: string; refspecs: string[] }>;
  statusUpdates: unknown[];
  archiveProvisionCalls: Array<{ owner: string; repoName: string }>;
  memoryGitSyncQueue: MumuMemoryGitSyncQueue;
  hub: Awaited<ReturnType<HubModules["startIntegrationHub"]>>;
  ads: AdsModules;
  router: InstanceType<AdsModules["MumuChatterRouter"]>;
  extractStateCache: MumuExtractStateCache;
  provisionerBaseUrl: string;
  validClient: InstanceType<AdsModules["MumuProvisionerClient"]>;
  badClient: InstanceType<AdsModules["MumuProvisionerClient"]>;
  provisionerServer: Server;
}

let context: HarnessContext | null = null;
let originalEnv: Record<string, string | undefined>;

describe("V-02-A mumu Phase 2 e2e critical paths", () => {
  beforeEach(async () => {
    originalEnv = snapshotEnv([
      "ADS_HMAC_KEY",
      "DATA_DIR",
      "JWT_SECRET",
      "MUMU_PROVISIONER_URL",
      "MUMU_PROVISIONER_HMAC_KEY",
      "MUMU_PROVISIONER_CALLER_ID",
      "MUMU_ARCHIVE_GITHUB_OWNER",
      "MUMU_SERVICE_GITHUB_TOKEN",
      "MUMU_MEMORY_FOLDER_ROOT"
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

  it("covers multi-root sandbox, optimize, extract resume, archive push, savepoint restore, and Phase 1 regressions", async () => {
    const ctx = requireHarness();
    const username = `v02a-${crypto.randomUUID()}`;
    const sadUsername = `v02a-sad-${crypto.randomUUID()}`;
    const createdUsers: string[] = [];

    try {
      const login = await simulateMumuLogin(ctx, username, ctx.validClient);
      const userId = login.user.id;
      const threadId = `chatter-mumu-user-${userId}`;
      createdUsers.push(userId);
      expect(login.session.mumu_thread_id).toBe(threadId);
      expect(ctx.archiveProvisionCalls).toHaveLength(1);
      const chatter = requireChatter(ctx, threadId);
      const userRoot = path.join(ctx.memoryRoot, userId);

      await expect(ctx.validClient.getChatter({ user_id: userId })).resolves.toMatchObject({
        thread_id: threadId,
        status: "active"
      });
      expect(existsSync(path.join(userRoot, ".seeds_initialized"))).toBe(false);
      expect(existsSync(path.join(userRoot, "templates"))).toBe(false);

      await expect(chatter.handleAgentToolCall("structured.list", {
        type: "template_short_drama"
      })).resolves.toMatchObject({ keys: expect.arrayContaining([TEMPLATE_ID]) });

      const seed = readStructuredSeed(ctx, "template_short_drama", TEMPLATE_ID);
      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "template_short_drama",
        key: TEMPLATE_ID,
        record: { ...seed, title: "Should not overwrite RO seed" }
      })).resolves.toMatchObject({ error: "denied_ro_root" });
      expect(readStructuredSeed(ctx, "template_short_drama", TEMPLATE_ID)).toMatchObject({ title: seed.title });

      const userTemplate = buildShortDramaTemplate(USER_TEMPLATE_ID, "User-owned template");
      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "template_short_drama",
        key: USER_TEMPLATE_ID,
        record: userTemplate
      })).resolves.toMatchObject({ record: userTemplate });
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "template_short_drama",
        key: USER_TEMPLATE_ID
      })).resolves.toMatchObject({ record: userTemplate });
      await expect(chatter.handleAgentToolCall("structured.list", {
        type: "template_short_drama"
      })).resolves.toMatchObject({ keys: expect.arrayContaining([TEMPLATE_ID, USER_TEMPLATE_ID]) });

      await ctx.router.routeCreateFromTemplate(
        {
          user_id: userId,
          mumu_thread_id: threadId,
          content: "Create a compact short-drama outline.",
          template_id: TEMPLATE_ID,
          chatter_session_id: "story-create-v02a-1"
        },
        { operation_hint: "outline", connection: { send: (event) => { ctx.adsEvents.push(event); } } }
      );
      await waitFor(() => ctx.adsEvents.some((event) => isChatterReply(event, "story-create-v02a-1")), "story create reply missing");
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "story_short_drama",
        key: "story-1"
      })).resolves.toMatchObject({ record: { id: "story-1", template_id: TEMPLATE_ID } });
      expect(ctx.agentToolCalls).toEqual(expect.arrayContaining([
        { thread_id: threadId, name: "structured.upsert", origin: "create_from_template", key: "story-1" }
      ]));

      ctx.adsEvents.length = 0;
      await ctx.router.routeOptimizeFromTemplate(
        {
          user_id: userId,
          mumu_thread_id: threadId,
          content: "Make the opening conflict sharper.",
          story_id: "story-1",
          template_id: TEMPLATE_ID,
          chatter_session_id: "story-optimize-v02a-1"
        },
        { operation_hint: "outline", connection: { send: (event) => { ctx.adsEvents.push(event); } } }
      );
      await waitFor(() => ctx.adsEvents.some((event) => isCandidateObservationEvent(event)), "optimize candidate missing");
      const optimizeObservation = requireCandidateObservation(ctx.adsEvents).payload.observation_id;
      await ctx.router.sendTurn({
        user_id: userId,
        mumu_thread_id: threadId,
        content: "",
        mode: "stateless",
        chatter_session_id: "story-optimize-confirm-v02a-1",
        control: "confirm_observation",
        observation_id: optimizeObservation
      }, { connection: { send: (event) => { ctx.adsEvents.push(event); } } });
      await waitFor(
        () => ctx.adsEvents.some((event) => isChatterReply(event, "story-optimize-confirm-v02a-1") && JSON.stringify(event).includes("observation_confirmed")),
        "optimize confirmation reply missing"
      );
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "story_short_drama",
        key: "story-1"
      })).resolves.toMatchObject({ record: { outline: { arc: "optimized v02a arc" } } });

      const storedUpload = await ctx.ads.storeMumuUploadExtract({
        user_id: userId,
        file: {
          originalname: "short-drama-draft.md",
          mimetype: "text/markdown",
          size: Buffer.byteLength("# Draft\nA reversal-heavy outline.\n"),
          buffer: Buffer.from("# Draft\nA reversal-heavy outline.\n", "utf8")
        }
      });
      await expect(ctx.ads.getMumuUploadExtractRecord({
        user_id: userId,
        attachment_ref: storedUpload.attachment_ref
      })).resolves.toMatchObject({ filename: "short-drama-draft.md" });

      const extractSessionId = "extract-v02a-1";
      const firstExtractReply = await sendExtractTurn(ctx, {
        userId,
        threadId,
        extractSessionId,
        state: { stage: "uploaded" },
        content: null,
        attachmentRef: storedUpload.attachment_ref
      });
      expect(extractStage(firstExtractReply)).toBe("asking_genre");
      const extractAgentRun = ctx.sentToHub.find((message) =>
        message.intent === "run"
        && message.payload.chatter?.system_prompt_id === "extract_template_from_draft"
        && message.payload.chatter?.attachment_ref === storedUpload.attachment_ref
      );
      expect((extractAgentRun?.payload.attachments ?? []).map((item) => item.filename)).toEqual(["short-drama-draft.md"]);

      const genreReply = await sendExtractTurn(ctx, {
        userId,
        threadId,
        extractSessionId,
        state: extractState(firstExtractReply),
        content: "short_drama"
      });
      expect(extractStage(genreReply)).toBe("asking_main_hook");
      const hookReply = await sendExtractTurn(ctx, {
        userId,
        threadId,
        extractSessionId,
        state: extractState(genreReply),
        content: "A wronged lead returns with proof."
      });
      expect(extractStage(hookReply)).toBe("asking_cliff_pattern");

      ctx.nowMs += 5 * 60 * 1000;
      expect(ctx.extractStateCache.get(userId, extractSessionId)?.state.stage).toBe("asking_cliff_pattern");
      await ctx.router.routeExtractFromDraft(
        {
          user_id: userId,
          mumu_thread_id: threadId,
          extract_session_id: extractSessionId,
          chatter_session_id: extractSessionId,
          draft_content: "resume after disconnect"
        },
        { connection: { send: (event) => { ctx.adsEvents.push(event); } } }
      );
      expect(ctx.adsToRolesMessages.at(-1)?.payload.chatter?.extract_state?.stage).toBe("asking_cliff_pattern");

      const transitionReply = await sendExtractTurn(ctx, {
        userId,
        threadId,
        extractSessionId,
        state: { stage: "asking_cliff_pattern" },
        content: "Every episode ends with a reversal."
      });
      expect(extractStage(transitionReply)).toBe("asking_transition_types");
      const finalConfirmReply = await sendExtractTurn(ctx, {
        userId,
        threadId,
        extractSessionId,
        state: extractState(transitionReply),
        content: "Use flashbacks and evidence reveals."
      });
      expect(extractStage(finalConfirmReply)).toBe("awaiting_final_confirm");

      const extractFinalConfirmEvents: unknown[] = [];
      const finalConfirmCandidateReply = await sendExtractTurn(ctx, {
        userId,
        threadId,
        extractSessionId,
        state: extractState(finalConfirmReply),
        content: "Confirm",
        captureEvents: extractFinalConfirmEvents
      });
      expect(extractStage(finalConfirmCandidateReply)).toBe("awaiting_final_confirm");
      const extractObservation = requireCandidateObservation(extractFinalConfirmEvents).payload.observation_id;
      expect(ctx.agentToolCalls).toEqual(expect.arrayContaining([
        { thread_id: threadId, name: "chatter.suggest_observation", origin: "extract_template_from_draft", key: EXTRACTED_TEMPLATE_ID }
      ]));
      expect(ctx.agentToolCalls).not.toEqual(expect.arrayContaining([
        { thread_id: threadId, name: "structured.upsert", origin: "extract_template_from_draft", key: EXTRACTED_TEMPLATE_ID }
      ]));
      await expect(chatter.handleAgentToolCall("structured.list", {
        type: "template_short_drama"
      })).resolves.toMatchObject({ keys: expect.not.arrayContaining([EXTRACTED_TEMPLATE_ID]) });

      await ctx.router.sendTurn({
        user_id: userId,
        mumu_thread_id: threadId,
        content: "",
        mode: "stateless",
        chatter_session_id: "extract-confirm-v02a-1",
        control: "confirm_observation",
        observation_id: extractObservation
      }, { connection: { send: (event) => { ctx.adsEvents.push(event); } } });
      await waitFor(
        () => ctx.adsEvents.some((event) => isChatterReply(event, "extract-confirm-v02a-1") && JSON.stringify(event).includes("observation_confirmed")),
        "extract confirmation reply missing"
      );
      await expect(chatter.handleAgentToolCall("structured.list", {
        type: "template_short_drama"
      })).resolves.toMatchObject({ keys: expect.arrayContaining([EXTRACTED_TEMPLATE_ID]) });

      const committedReply = await sendExtractTurn(ctx, {
        userId,
        threadId,
        extractSessionId,
        state: { stage: "committed" },
        content: null
      });
      expect(extractStage(committedReply)).toBe("committed");
      await expect(chatter.handleAgentToolCall("structured.list", {
        type: "template_short_drama"
      })).resolves.toMatchObject({ keys: expect.arrayContaining([EXTRACTED_TEMPLATE_ID]) });
      await ctx.ads.deleteMumuUploadExtract({ user_id: userId, attachment_ref: storedUpload.attachment_ref });
      await expect(ctx.ads.getMumuUploadExtractRecord({
        user_id: userId,
        attachment_ref: storedUpload.attachment_ref
      })).rejects.toThrow();

      ctx.router.registerFrontendConnection(
        "style-profile-tab-v02a",
        { send: (event) => { ctx.adsEvents.push(event); } },
        { user_id: userId, mumu_thread_id: threadId }
      );
      for (let index = 2; index <= 5; index += 1) {
        await ctx.router.routeCreateFromTemplate({
          user_id: userId,
          mumu_thread_id: threadId,
          content: `Create regression story ${index}.`,
          template_id: TEMPLATE_ID,
          chatter_session_id: `story-create-v02a-${index}`
        });
      }
      await waitFor(
        () => ctx.sentToHub.some((message) => message.payload.chatter?.origin === "trigger"),
        "background trigger did not dispatch"
      );
      await waitFor(
        () => ctx.adsEvents.some((event) => isCandidateObservationEvent(event)),
        "style candidate missing"
      );
      const styleObservation = [...ctx.adsEvents].reverse().find(isCandidateObservationEvent)?.payload.observation_id;
      expect(styleObservation).toBeDefined();
      await ctx.router.sendTurn({
        user_id: userId,
        mumu_thread_id: threadId,
        content: "",
        mode: "stateless",
        chatter_session_id: "style-confirm-v02a-1",
        control: "confirm_observation",
        observation_id: styleObservation
      }, { connection: { send: (event) => { ctx.adsEvents.push(event); } } });
      await waitFor(
        () => ctx.adsEvents.some((event) => isChatterReply(event, "style-confirm-v02a-1") && JSON.stringify(event).includes("observation_confirmed")),
        "style confirmation reply missing"
      );
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "style_short_drama",
        key: userId
      })).resolves.toMatchObject({
        record: { agent_observed: { recurring_motifs: ["reversal", "identity reveal"] } }
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
      const storyRead = await readOnlyClient.readOnlyQuery({
        user_id: userId,
        mumu_thread_id: threadId,
        skill: "structured.get",
        args: { type: "story_short_drama", key: "story-1" },
        timeout_ms: 1_000
      });
      expect(storyRead).toMatchObject({ ok: true });
      expect(performance.now() - readOnlyStarted).toBeLessThan(100);
      expect(snapshotChatterReadOnlyQueryCounters()["structured.get|ok"]).toBeGreaterThanOrEqual(1);
      expect(ctx.ads.getCounterValue(ctx.ads.MUMU_LLM_TURN_TOTAL_METRIC)).toBe(llmTurnsBefore);

      const sadUser = await ctx.ads.createUser(sadUsername, "password", "mumu");
      ctx.ads.replaceGrantsForUser(sadUser.id, ["mumu", "ads"], null);
      await expect(ctx.ads.createPostLoginSession(sadUser, {
        ensureChatter: (input) => ctx.badClient.ensureChatter(input),
        ensureArchive: (input) => ensurePrivateArchive(ctx, input),
        now: (() => {
          let value = 100_000;
          return () => {
            const current = value;
            value += 25;
            return current;
          };
        })()
      })).rejects.toMatchObject({
        statusCode: 502,
        responseBody: { ok: false, code: "mumu_provisioning_failed" },
        cause: expect.any(ctx.ads.ProvisionerAuthError)
      });
      await expect(ctx.validClient.getChatter({ user_id: sadUser.id }))
        .rejects.toBeInstanceOf(ctx.ads.ProvisionerProjectNotRegisteredError);
      expect(ctx.runner.getRole(`chatter-mumu-user-${sadUser.id}`)).toBeNull();
      expect(JSON.stringify(ctx.stateStore.snapshot())).not.toContain(sadUser.id);

      const archive = ctx.ads.getMumuArchiveRemoteDescriptorForUser(userId);
      expect(archive).toMatchObject({
        push_enabled: true,
        state: "ready",
        owner: "yzsnstotz",
        private: true
      });
      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "story_short_drama",
        key: "story-archive-local",
        record: buildStoryRecord("story-archive-local", TEMPLATE_ID, "Local archive story")
      })).resolves.toMatchObject({ record: { id: "story-archive-local" } });
      const localCommit = await ctx.memoryGitSyncQueue.flush(userRoot);
      expect(localCommit?.commitSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(Number(git(userRoot, "rev-list", "--count", "HEAD"))).toBeGreaterThanOrEqual(1);

      await ctx.validClient.memoryArchiveEnqueue({
        user_id: userId,
        event_kind: "direct_write",
        repo_root: userRoot,
        record_type: "story_short_drama",
        key: "story-archive-local",
        archive: archive!
      });
      const pushed = await ctx.memoryGitSyncQueue.flush(userRoot);
      expect(pushed?.remote).toMatchObject({ status: "pushed", repoFullName: archive!.repo_full_name });
      expect(ctx.pushCalls.at(-1)).toMatchObject({ repoFullName: archive!.repo_full_name });

      const commitsBeforePublicBlock = Number(git(userRoot, "rev-list", "--count", "HEAD"));
      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "story_short_drama",
        key: "story-public-block",
        record: buildStoryRecord("story-public-block", TEMPLATE_ID, "Public block story")
      })).resolves.toMatchObject({ record: { id: "story-public-block" } });
      await ctx.memoryGitSyncQueue.flush(userRoot);
      expect(Number(git(userRoot, "rev-list", "--count", "HEAD"))).toBeGreaterThan(commitsBeforePublicBlock);
      await ctx.validClient.memoryArchiveEnqueue({
        user_id: userId,
        event_kind: "direct_write",
        repo_root: userRoot,
        record_type: "story_short_drama",
        key: "story-public-block",
        archive: { ...archive!, private: false }
      });
      const publicBlocked = await ctx.memoryGitSyncQueue.flush(userRoot);
      expect(publicBlocked?.remote).toMatchObject({ status: "blocked", blockedReason: "public_repo" });

      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "style_short_drama",
        key: userId,
        record: buildStyleRecord(["savepoint style"], "old")
      })).resolves.toMatchObject({ record: { user_authored: { likes: ["savepoint style"] } } });
      await ctx.memoryGitSyncQueue.flush(userRoot);
      const savepoint = await ctx.validClient.createMemorySavepoint({
        user_id: userId,
        label: "before v02a edits",
        archive: archive!
      });
      expect(savepoint.savepoint.id).toMatch(/^sp-/u);

      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "story_short_drama",
        key: "story-1",
        record: buildStoryRecord("story-1", TEMPLATE_ID, "Current story after savepoint")
      })).resolves.toMatchObject({ record: { outline: { arc: "Current story after savepoint" } } });
      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "template_short_drama",
        key: USER_TEMPLATE_ID,
        record: buildShortDramaTemplate(USER_TEMPLATE_ID, "Current template after savepoint")
      })).resolves.toMatchObject({ record: { title: "Current template after savepoint" } });
      await expect(chatter.handleAgentToolCall("structured.upsert", {
        type: "style_short_drama",
        key: userId,
        record: buildStyleRecord(["current style"], "new")
      })).resolves.toMatchObject({ record: { user_authored: { likes: ["current style"] } } });
      await ctx.memoryGitSyncQueue.flush(userRoot);

      const snapshot = await ctx.validClient.readMemorySavepoint({
        user_id: userId,
        savepoint_id: savepoint.savepoint.id
      });
      expect(snapshot.snapshot.records.some((record) => record.type === "story_short_drama" && record.key === "story-1")).toBe(true);
      expect(snapshot.snapshot.style_records).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "style_short_drama", key: userId })
      ]));
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "style_short_drama",
        key: userId
      })).resolves.toMatchObject({ record: { user_authored: { likes: ["current style"] } } });

      const restoreStyle = await ctx.validClient.restoreMemorySavepoint({
        user_id: userId,
        savepoint_id: savepoint.savepoint.id,
        scope: { kind: "record", record_type: "style_short_drama", key: userId },
        archive: archive!
      });
      expect(restoreStyle.restore.restore_commit_sha).toMatch(/^[a-f0-9]{40}$/u);
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "style_short_drama",
        key: userId
      })).resolves.toMatchObject({ record: { user_authored: { likes: ["savepoint style"] } } });

      const restoreStory = await ctx.validClient.restoreMemorySavepoint({
        user_id: userId,
        savepoint_id: savepoint.savepoint.id,
        scope: { kind: "record", record_type: "story_short_drama", key: "story-1" },
        archive: archive!
      });
      expect(restoreStory.restore.restore_commit_sha).toMatch(/^[a-f0-9]{40}$/u);
      await expect(chatter.handleAgentToolCall("structured.get", {
        type: "story_short_drama",
        key: "story-1"
      })).resolves.toMatchObject({ record: { outline: { arc: "optimized v02a arc" } } });
      expect(git(userRoot, "cat-file", "-t", savepoint.savepoint.commit_sha)).toBe("commit");
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
  }, 150_000);
});

async function createHarness(): Promise<HarnessContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mumu-v02a-"));
  const repoRoot = path.join(root, "meridian-roles-repo");
  const memoryRoot = path.join(root, "memory");
  const dataDir = path.join(root, "ads-data");
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(memoryRoot, { recursive: true });
  const seedsRoot = await writeProjectFixture(repoRoot, memoryRoot);
  await writeCaller(repoRoot);

  process.env.ADS_HMAC_KEY = TEST_HMAC_SECRET;
  process.env.DATA_DIR = dataDir;
  process.env.JWT_SECRET = "v-02-a-jwt-secret";
  process.env.MUMU_PROVISIONER_HMAC_KEY = TEST_HMAC_SECRET;
  process.env.MUMU_PROVISIONER_CALLER_ID = TEST_CALLER_ID;
  process.env.MUMU_ARCHIVE_GITHUB_OWNER = "yzsnstotz";
  process.env.MUMU_SERVICE_GITHUB_TOKEN = "service-token-should-never-be-in-argv";
  process.env.MUMU_MEMORY_FOLDER_ROOT = memoryRoot;

  const ads = await loadAdsModules();
  const hubModules = await loadHubModules();
  ads.closeDatabaseForTests();
  ads.resetMetricsForTests();
  ads.initializeDatabase();

  const hub = await hubModules.startIntegrationHub();
  const stateStore = new MemoryStateStore();
  const sentToHub: HubMessage[] = [];
  const adsToRolesMessages: HubMessage[] = [];
  const adsEvents: unknown[] = [];
  const agentToolCalls: AgentToolCallTrace[] = [];
  const storyCountsByThread = new Map<string, number>();
  const pushCalls: Array<{ repoFullName: string; commitSha: string; refspecs: string[] }> = [];
  const statusUpdates: unknown[] = [];
  const archiveProvisionCalls: Array<{ owner: string; repoName: string }> = [];
  let nowMs = Date.parse("2026-05-24T00:00:00.000Z");
  const extractStateCache = ads.createMumuExtractStateCache({ now: () => nowMs });

  const memoryGitSyncQueue = new MumuMemoryGitSyncQueue({
    debounceMs: 0,
    maxFileBytes: 1024 * 1024,
    serviceGithubToken: "service-token-should-never-be-in-argv",
    fetchImpl: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.github.com/repos/")) {
        const repoFullName = decodeURIComponent(url.replace("https://api.github.com/repos/", ""));
        const repoName = repoFullName.split("/").at(-1) ?? "mumu-archive-unknown";
        return new Response(JSON.stringify({ name: repoName, full_name: repoFullName, private: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/api/mumu/internal/archive-status/")) {
        statusUpdates.push(typeof init?.body === "string" ? JSON.parse(init.body) as unknown : {});
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "unexpected_fetch" }), { status: 500 });
    },
    gitPush: async (request) => {
      pushCalls.push({
        repoFullName: request.repoFullName,
        commitSha: request.commitSha,
        refspecs: request.refspecs
      });
      return { ok: true };
    },
    statusReporter: async (status) => {
      statusUpdates.push(status);
      ads.recordMumuArchivePushStatus(status);
    }
  });

  let runner: RoleRunner;
  let router: InstanceType<AdsModules["MumuChatterRouter"]>;

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
      const deterministic = await applyDeterministicMumuAgentToolEffects({
        runner,
        storyCountsByThread,
        agentToolCalls
      }, hubMessage);
      await runner.dispatch({
        ...result,
        content: deterministic.content ?? result.content,
        payload: deterministic.chatter ? { chatter: deterministic.chatter } : result.payload
      });
    },
    log: silentLog()
  });

  const registry = new RoleRegistry();
  registry.register("chatter", (threadId, config) =>
    new ChatterRole(threadId, ChatterRoleConfigSchema.parse(config), {
      now: () => requireHarness().now,
      memoryGitSyncQueue
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
    callerAuth: createRequireCallerAuth({ registry: callerRegistry }),
    memoryGitSyncQueue
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
      adsToRolesMessages.push(message);
      await runner.dispatch(messageToInboundResult(message));
    }
  }, {
    scheduler: new ManualScheduler(),
    extractStateCache
  });

  const validClient = new ads.MumuProvisionerClient({
    baseUrl: provisionerBaseUrl,
    hmacKey: TEST_HMAC_SECRET,
    callerId: TEST_CALLER_ID,
    retryDelaysMs: [],
    perRequestTimeoutMs: 10_000,
    totalTimeoutMs: 10_000
  });
  const badClient = new ads.MumuProvisionerClient({
    baseUrl: provisionerBaseUrl,
    hmacKey: "wrong-v-02-a-hmac-key",
    callerId: TEST_CALLER_ID,
    retryDelaysMs: [],
    perRequestTimeoutMs: 1_000,
    totalTimeoutMs: 1_000
  });

  const ctx: HarnessContext = {
    root,
    repoRoot,
    memoryRoot,
    seedsRoot,
    dataDir,
    now: new Date("2026-05-24T00:00:00.000Z"),
    get nowMs() {
      return nowMs;
    },
    set nowMs(value: number) {
      nowMs = value;
    },
    stateStore,
    runner,
    adsToRolesMessages,
    sentToHub,
    adsEvents,
    agentToolCalls,
    pushCalls,
    statusUpdates,
    archiveProvisionCalls,
    memoryGitSyncQueue,
    hub,
    ads,
    router,
    extractStateCache,
    provisionerBaseUrl,
    validClient,
    badClient,
    provisionerServer
  };

  async function ensureArchive(input: { user_id: string }): Promise<MumuArchiveProvisionResult> {
    return ensurePrivateArchive(ctx, input);
  }

  void ensureArchive;
  return ctx;
}

async function ensurePrivateArchive(
  ctx: HarnessContext,
  input: { user_id: string }
): Promise<MumuArchiveProvisionResult> {
  return ctx.ads.ensureMumuArchiveForUser(input, {
    owner: "yzsnstotz",
    githubClient: {
      ensurePrivateRepo: async ({ owner, repoName }) => {
        ctx.archiveProvisionCalls.push({ owner, repoName });
        return {
          status: "created_private",
          owner,
          repoName,
          repoFullName: `${owner}/${repoName}`,
          private: true,
          pushEnabled: true
        };
      }
    }
  });
}

async function writeProjectFixture(repoRoot: string, memoryRoot: string): Promise<string> {
  const configRoot = path.join(repoRoot, "config", "projects");
  const fixtureRoot = path.join(configRoot, "mumu");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.cp(REAL_MUMU_CONFIG_ROOT, fixtureRoot, { recursive: true });
  const seedsRoot = path.join(fixtureRoot, "seeds");
  await materializeStructuredSeeds(seedsRoot);

  const manifestPath = path.join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    sandbox_roots?: Array<{ root: string; mode: "rw" | "ro" }>;
    background_triggers?: Array<{ throttle?: { min_interval?: string } }>;
  };
  manifest.sandbox_roots = [
    { root: "{memory_folder}", mode: "rw" },
    { root: seedsRoot, mode: "ro" }
  ];
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
      seeds_source_path: seedsRoot,
      seeds_init: { mode: "none" },
      llm_agent_kind: "cursor"
    }, null, 2)}\n`,
    "utf8"
  );
  return seedsRoot;
}

async function materializeStructuredSeeds(seedsRoot: string): Promise<void> {
  const genreTypes: Record<string, string> = {
    short_drama: "template_short_drama",
    lianxian: "template_lianxian",
    douyin: "template_douyin",
    variety: "template_variety"
  };
  for (const [genre, recordType] of Object.entries(genreTypes)) {
    const sourceDir = path.join(seedsRoot, "templates", genre);
    const targetDir = path.join(seedsRoot, "structured", recordType);
    await fs.mkdir(targetDir, { recursive: true });
    for (const entry of await fs.readdir(sourceDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const raw = await fs.readFile(path.join(sourceDir, entry), "utf8");
      const record = JSON.parse(raw) as { id?: string };
      const key = record.id ?? entry.slice(0, -".json".length);
      await fs.writeFile(path.join(targetDir, `${key}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    }
  }
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
  const user = await ctx.ads.createUser(username, "password", "mumu");
  ctx.ads.replaceGrantsForUser(user.id, ["mumu", "ads"], null);
  const session = await ctx.ads.createPostLoginSession(user, {
    ensureChatter: (input) => client.ensureChatter(input),
    ensureArchive: (input) => ensurePrivateArchive(ctx, input),
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

async function sendExtractTurn(
  ctx: HarnessContext,
  input: {
    userId: string;
    threadId: string;
    extractSessionId: string;
    state: { stage: ExtractStage; question?: string; options?: string[]; draft_template?: Record<string, unknown> };
    content: string | null;
    attachmentRef?: string;
    captureEvents?: unknown[];
  }
): Promise<Record<string, any>> {
  const events: unknown[] = [];
  const attachments = input.attachmentRef
    ? [await ctx.ads.resolveMumuUploadExtractAttachment({ user_id: input.userId, attachment_ref: input.attachmentRef })]
    : undefined;
  await ctx.router.routeExtractFromDraft(
    {
      user_id: input.userId,
      mumu_thread_id: input.threadId,
      extract_session_id: input.extractSessionId,
      chatter_session_id: input.extractSessionId,
      draft_content: input.content,
      extract_state: input.state,
      ...(input.attachmentRef ? { attachment_ref: input.attachmentRef } : {}),
      ...(attachments ? { attachments } : {})
    },
    {
      operation_hint: "outline",
      connection: {
        send: (event) => {
          events.push(event);
          input.captureEvents?.push(event);
        }
      }
    }
  );
  await waitFor(() => events.some((event) => isChatterReply(event, input.extractSessionId)), `extract reply missing for ${input.state.stage}`);
  return events.find((event) => isChatterReply(event, input.extractSessionId)) as Record<string, any>;
}

async function applyDeterministicMumuAgentToolEffects(
  options: {
    runner: RoleRunner;
    storyCountsByThread: Map<string, number>;
    agentToolCalls: AgentToolCallTrace[];
  },
  message: HubMessage
): Promise<{ content?: string; chatter?: NonNullable<HubResult["payload"]>["chatter"] }> {
  if (message.intent !== "run" || message.target === "global") {
    return {};
  }

  const chatter = options.runner.getRole(message.thread_id);
  if (!(chatter instanceof ChatterRole)) {
    return {};
  }

  const envelope = message.payload.chatter;
  if (envelope?.origin === "trigger" && envelope.system_prompt_id === "style_observe") {
    const userId = userIdFromMumuThreadId(message.thread_id);
    if (!userId) {
      return {};
    }
    options.agentToolCalls.push({
      thread_id: message.thread_id,
      name: "chatter.suggest_observation",
      origin: "style_observe"
    });
    await expect(chatter.handleAgentToolCall("chatter.suggest_observation", {
      type: "style_short_drama",
      description: "User keeps choosing reversal-heavy identity reveals.",
      proposed_patch: {
        record_type: "style_short_drama",
        key: userId,
        patch: {
          agent_observed: {
            recurring_motifs: ["reversal", "identity reveal"]
          }
        }
      }
    })).resolves.toMatchObject({ ok: true });
    return { content: "style observation proposed" };
  }

  if (envelope?.system_prompt_id === "optimize_from_template") {
    const storyRef = envelope.context_refs?.find((ref) => ref.type === "story_short_drama");
    if (!storyRef) {
      return {};
    }
    options.agentToolCalls.push({
      thread_id: message.thread_id,
      name: "chatter.suggest_observation",
      origin: "optimize_from_template",
      key: storyRef.key
    });
    await expect(chatter.handleAgentToolCall("chatter.suggest_observation", {
      type: "story_patch",
      description: "Sharpen the opening conflict and keep the user's story under explicit confirmation.",
      proposed_patch: {
        record_type: "story_short_drama",
        key: storyRef.key,
        patch: {
          outline: {
            arc: "optimized v02a arc",
            episodes: [
              {
                no: 1,
                hook: "The lead exposes the betrayal in the first scene.",
                cliff: "The betrayer produces a forged witness."
              }
            ]
          }
        }
      }
    })).resolves.toMatchObject({ ok: true });
    return { content: "optimize suggestion proposed" };
  }

  if (envelope?.system_prompt_id === "extract_template_from_draft") {
    const currentStage = envelope.extract_state?.stage ?? "uploaded";
    if (currentStage === "awaiting_final_confirm") {
      const extractedTemplate = buildShortDramaTemplate(EXTRACTED_TEMPLATE_ID, "Extracted template");
      options.agentToolCalls.push({
        thread_id: message.thread_id,
        name: "chatter.suggest_observation",
        origin: "extract_template_from_draft",
        key: EXTRACTED_TEMPLATE_ID
      });
      await expect(chatter.handleAgentToolCall("chatter.suggest_observation", {
        type: "extracted_template",
        description: "我把你的剧本抽成了 template_short_drama，请确认",
        proposed_patch: {
          record_type: "template_short_drama",
          key: EXTRACTED_TEMPLATE_ID,
          patch: extractedTemplate
        }
      })).resolves.toMatchObject({ ok: true, observation_id: expect.any(String) });
      return {
        content: "extract candidate proposed",
        chatter: {
          extract_state: {
            stage: "awaiting_final_confirm",
            question: "Confirm extracted template?",
            draft_template: extractedTemplate
          },
          ...(envelope.chatter_session_id ? { chatter_session_id: envelope.chatter_session_id } : {}),
          ...(envelope.attachment_ref ? { attachment_ref: envelope.attachment_ref } : {})
        }
      };
    }

    const next = nextExtractState(currentStage);
    return {
      content: `extract stage ${next.stage}`,
      chatter: {
        extract_state: next,
        ...(envelope.chatter_session_id ? { chatter_session_id: envelope.chatter_session_id } : {}),
        ...(envelope.attachment_ref ? { attachment_ref: envelope.attachment_ref } : {})
      }
    };
  }

  if (!isCreateFromTemplateAgentRun(message)) {
    return {};
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
    record: buildStoryRecord(storyId, TEMPLATE_ID, `${storyId} reversal arc`)
  })).resolves.toMatchObject({ record: { id: storyId, template_id: TEMPLATE_ID } });
  return { content: `created ${storyId}` };
}

function nextExtractState(stage: ExtractStage): {
  stage: ExtractStage;
  question?: string;
  options?: string[];
  draft_template?: Record<string, unknown>;
} {
  switch (stage) {
    case "uploaded":
      return { stage: "asking_genre", question: "Which genre?", options: ["short_drama"] };
    case "asking_genre":
      return { stage: "asking_main_hook", question: "What is the main hook?" };
    case "asking_main_hook":
      return { stage: "asking_cliff_pattern", question: "How should cliffhangers work?" };
    case "asking_cliff_pattern":
      return { stage: "asking_transition_types", question: "What transitions should be used?" };
    case "asking_transition_types":
      return {
        stage: "awaiting_final_confirm",
        question: "Confirm extracted template?",
        draft_template: buildShortDramaTemplate(EXTRACTED_TEMPLATE_ID, "Extracted template")
      };
    case "awaiting_final_confirm":
    case "committed":
      return {
        stage: "committed",
        draft_template: buildShortDramaTemplate(EXTRACTED_TEMPLATE_ID, "Extracted template")
      };
  }
}

function isCreateFromTemplateAgentRun(message: HubMessage): boolean {
  return (
    message.payload.chatter?.system_prompt_id === "create_from_template"
    || (
      message.payload.content.includes("System prompt for this turn:")
      && message.payload.content.includes("create_from_template")
      && message.payload.content.includes("structured.upsert('story_short_drama'")
    )
  );
}

function buildShortDramaTemplate(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    overall_arc: `${title} overall arc`,
    episode_count: 12,
    per_episode_beats: [
      {
        episode_no: 1,
        hook: "A fast reversal opens the story.",
        cliff: "A hidden identity is revealed."
      }
    ],
    cliff_pattern: "every_episode",
    hook_types: ["reversal", "identity"],
    tone: "fast and emotional",
    notes: "V-02-A deterministic fixture"
  };
}

function buildStoryRecord(storyId: string, templateId: string, arc: string): Record<string, unknown> {
  return {
    id: storyId,
    template_id: templateId,
    outline: {
      arc,
      episodes: [
        {
          no: 1,
          hook: "Identity conflict starts immediately.",
          cliff: "The proof disappears."
        }
      ]
    },
    fragments: []
  };
}

function buildStyleRecord(likes: string[], marker: string): Record<string, unknown> {
  return {
    user_authored: {
      likes,
      dislikes: [`${marker} dislike`],
      tone_keywords: [`${marker} tone`],
      notes: `${marker} notes`
    },
    agent_observed: {
      recurring_motifs: [`${marker} motif`],
      avoided_patterns: [`${marker} avoid`]
    }
  };
}

function readStructuredSeed(ctx: HarnessContext, type: string, key: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ctx.seedsRoot, "structured", type, `${key}.json`), "utf8")) as Record<string, unknown>;
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
    attachments: message.payload.attachments ?? [],
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
    uploadExtract,
    archiveService,
    metrics
  ] = await Promise.all([
    importFromAds("src/db/index.ts"),
    importFromAds("src/services/user-service.ts"),
    importFromAds("src/services/gateway-access-service.ts"),
    importFromAds("src/auth/post-login-hook.ts"),
    importFromAds("src/services/mumu-provisioner-client.ts"),
    importFromAds("src/gateway/mumu-chatter-router.ts"),
    importFromAds("src/gateway/mumu-read-only-query.ts"),
    importFromAds("src/gateway/mumu-upload-extract.ts"),
    importFromAds("src/services/mumu-archive-service.ts"),
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
    createMumuExtractStateCache: chatterRouter.createMumuExtractStateCache,
    createMumuReadOnlyQueryClient: readOnly.createMumuReadOnlyQueryClient,
    MUMU_LLM_TURN_TOTAL_METRIC: readOnly.MUMU_LLM_TURN_TOTAL_METRIC,
    storeMumuUploadExtract: uploadExtract.storeMumuUploadExtract,
    getMumuUploadExtractRecord: uploadExtract.getMumuUploadExtractRecord,
    deleteMumuUploadExtract: uploadExtract.deleteMumuUploadExtract,
    resolveMumuUploadExtractAttachment: uploadExtract.resolveMumuUploadExtractAttachment,
    ensureMumuArchiveForUser: archiveService.ensureMumuArchiveForUser,
    getMumuArchiveRemoteDescriptorForUser: archiveService.getMumuArchiveRemoteDescriptorForUser,
    recordMumuArchivePushStatus: archiveService.recordMumuArchivePushStatus,
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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v02a-hub-"));
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

function isChatterReply(event: unknown, chatterSessionId?: string): event is Record<string, any> {
  return (
    isRecord(event)
    && event.type === "mumu_chatter_reply"
    && (chatterSessionId === undefined || event.chatter_session_id === chatterSessionId)
  );
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

function extractState(reply: Record<string, any>): { stage: ExtractStage; question?: string; options?: string[]; draft_template?: Record<string, unknown> } {
  const state = reply.chatter?.extract_state;
  expect(state?.stage).toBeDefined();
  return state;
}

function extractStage(reply: Record<string, any>): ExtractStage {
  return extractState(reply).stage;
}

function userIdFromMumuThreadId(threadId: string): string | null {
  const prefix = "chatter-mumu-user-";
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
