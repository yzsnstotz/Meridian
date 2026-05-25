import { randomUUID } from "node:crypto";
import net from "node:net";
import { ROLES_SERVICE_ID, ROLES_SOCKET_PATH } from "../../config";
import { ChatterCandidateObservationSchema } from "../../types";
import type {
  ChatterCandidateObservation,
  ChatterObservationProposedPatch,
  ChatterReadOnlyQuery,
  ChatterReadOnlyQueryResult,
  ChatterRoleConfig,
  HubMessage,
  HubResult,
  MumuChatterDiagnostics,
  MumuReplyParseDiagnostics,
  ReplyChannel
} from "../../types";
import type { BaseRole, RoleContext } from "../base-role";
import {
  hasRecordType,
  loadManifestFromTemplate,
  loadManifestFromFile,
  validateRecord
} from "../chatter/manifest";
import { MemoryResolver } from "../chatter/memory-resolver";
import {
  assertSandboxRootsSeedModeCompatible,
  buildSandboxSpawnPlan,
  initializeSeedsOnProvision,
  type SandboxSpawnPlan
} from "../chatter/sandbox";
import { makeMemorySkills } from "../chatter/memory-skills";
import { assertModeAllowed, assertSkillAllowed, ChatterPolicyError } from "../chatter/allowlist";
import {
  parseAgentStructuredFallback,
  stripAgentStructuredFallbackContent
} from "../chatter/agent-structured-fallback";
import { ChatterStateStore } from "../chatter/chatter-state-store";
import {
  containsUnsafeMumuUserReplyContent,
  fallbackMumuUserReply,
  mumuUserReplyParseDiagnostics,
  parseMumuUserReply
} from "../chatter/mumu-user-reply";
import { ObservationCache } from "../chatter/observation-cache";
import {
  incrementChatterExtractStateResumeTotal,
  incrementChatterExtractStateTransitionTotal,
  incrementChatterReadOnlyQueryTotal,
  incrementChatterSelfInitiatedTurnErrorTotal,
  incrementChatterSelfInitiatedTurnTotal
} from "../chatter/observability";
import { SessionManager, type SelfInitiatedTurnRequest } from "../chatter/session-manager";
import {
  BackgroundTriggerEvaluator,
  type BackgroundTriggerFireRequest,
  type ScheduleSelfInitiatedTurn
} from "../chatter/trigger-evaluator";
import {
  makeStructuredSkills,
  registerStructuredSkills,
  type StructuredEvent,
  type StructuredSkills,
  type StructuredSkillName
} from "../chatter/skills/structured";
import {
  getDefaultMumuMemoryGitSyncQueue,
  isMumuUserMemoryRoot,
  type MumuMemoryGitSyncQueueLike
} from "../chatter/mumu-memory-git-sync";
import {
  buildMumuPromptParts,
  renderMumuPromptParts
} from "../chatter/prompt-parts";

const ROLES_SOCKET_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: ROLES_SERVICE_ID,
  socket_path: ROLES_SOCKET_PATH
};

const ChatterSuggestObservationArgsSchema = ChatterCandidateObservationSchema.omit({
  observation_id: true
});

/**
 * Maps the chatter-side llm_agent_kind to the meridian-hub agent_type the
 * intent:"spawn" target expects. "claude-code" is the chatter-facing CLI
 * variant name; "claude" is the provider type registered with the hub.
 */
function agentTypeForKind(kind: ChatterRoleConfig["llm_agent_kind"]): string {
  switch (kind) {
    case "claude-code":
      return "claude";
    default:
      return kind;
  }
}

/**
 * Result of a queued user turn that arrived while the spawn handshake was
 * still in flight. Content is already composed for this turn only so any
 * system_prompt_id prompt does not persist into later turns.
 */
interface QueuedTurn {
  content: string;
  chatterSessionId?: string;
  attachments: HubResult["attachments"];
  chatter: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>;
}

// Writes a HubResult as a JSON frame to a unix socket path. The default
// implementation opens a fresh net.createConnection per call (one frame per
// connection — same wire format as meridian-hub's SocketChannelAdapter), but
// tests inject a mock to assert delivery without actually binding sockets.
export type ChatterSocketWriter = (
  socketPath: string,
  result: HubResult
) => Promise<void>;

export interface ChatterRoleOptions {
  scheduleSelfInitiatedTurn?: ScheduleSelfInitiatedTurn;
  now?: () => Date;
  socketWriter?: ChatterSocketWriter;
  memoryGitSyncQueue?: MumuMemoryGitSyncQueueLike | false;
}

type ChatterEnvelope = NonNullable<NonNullable<HubResult["payload"]>["chatter"]>;

type ChatterTurnEnvelopeWithMode =
  ChatterEnvelope & {
    mode: "stateless" | "session";
  };

export class ChatterRole implements BaseRole {
  readonly roleType = "chatter" as const;
  readonly threadId: string;
  readonly config: ChatterRoleConfig;

  private ctx: RoleContext | null = null;
  private resolver: MemoryResolver | null = null;
  private sessionMgr: SessionManager | null = null;
  private sandboxPlan: SandboxSpawnPlan | null = null;
  private store: ChatterStateStore | null = null;
  private observationCache: ObservationCache | null = null;
  private structuredSkills: StructuredSkills | null = null;
  private triggerEvaluator: BackgroundTriggerEvaluator | null = null;
  private memoryGitSyncQueue: MumuMemoryGitSyncQueueLike | null = null;
  private skillHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
  private extractStageBySession = new Map<string, string>();

  /**
   * In-flight spawn trace_id; set when we send intent:"spawn" and cleared
   * when the response (HubResult with this trace_id) arrives via
   * onInboundResult. Only one spawn handshake is in flight per Chatter.
   */
  private pendingSpawnTraceId: string | null = null;

  /**
   * Turns that arrived while a spawn was pending; drained in FIFO order
   * after sessionMgr.bindAgentSession() in onSpawnResponse.
   */
  private pendingTurns: QueuedTurn[] = [];

  constructor(
    threadId: string,
    config: ChatterRoleConfig,
    private readonly options: ChatterRoleOptions = {}
  ) {
    this.threadId = threadId;
    this.config = config;
  }

  async onActivate(ctx: RoleContext): Promise<void> {
    this.ctx = ctx;
    const manifest = this.config.template
      ? loadManifestFromTemplate(this.config.template)
      : loadManifestFromFile(this.config.manifest_path as string);
    const seedsInit = this.config.seeds_init
      ? {
          mode: "copy_on_provision" as const,
          source_path: this.config.seeds_init.source_path ?? manifest.seeds_init?.source_path
        }
      : manifest.seeds_init;
    assertSandboxRootsSeedModeCompatible({ manifest, seedsInit });
    this.resolver = new MemoryResolver(this.config.memory_folder, manifest);
    await initializeSeedsOnProvision({
      resolver: this.resolver,
      seedsInit
    });
    this.skillHandlers.clear();
    this.store = new ChatterStateStore(this.config.memory_folder);
    this.triggerEvaluator = new BackgroundTriggerEvaluator({
      manifest,
      store: this.store,
      scheduleSelfInitiatedTurn: (request) => this.scheduleSelfInitiatedTurn(request),
      now: this.options.now,
      log: ctx.log
    });
    this.memoryGitSyncQueue = resolveMemoryGitSyncQueue(this.config.memory_folder, this.options);
    this.structuredSkills = makeStructuredSkills(this.resolver, {
      onEvent: async (event) => {
        this.enqueueStructuredMemoryCommit(event);
        if (event.name === "structured.write") {
          await this.triggerEvaluator?.handleStructuredWrite(event);
        }
      }
    });
    this.observationCache = new ObservationCache(this.store, {
      now: this.options.now
    });
    registerStructuredSkills(this.structuredSkills, {
      register: (name: StructuredSkillName, handler: (args: unknown) => Promise<unknown>) => {
        this.skillHandlers.set(name, handler);
      }
    });
    this.skillHandlers.set("chatter.suggest_observation", (args) => this.handleSuggestObservation(args));
    this.sessionMgr = new SessionManager(this.store);
    this.sessionMgr.rehydrate();
    this.sandboxPlan = buildSandboxSpawnPlan({
      memoryFolder: this.config.memory_folder,
      sandboxRoots: this.resolver.sandboxRoots,
      skillAllowlist: this.config.skill_allowlist,
      llmAgentKind: this.config.llm_agent_kind
    });
    this.sandboxPlan.materialize();
  }

  async onDeactivate(): Promise<void> {
    await this.archive();
  }

  async archive(): Promise<void> {
    await this.shutdownAgentSession();
    this.ctx = null;
    this.resolver = null;
    this.sessionMgr = null;
    this.sandboxPlan = null;
    this.store = null;
    this.observationCache = null;
    this.structuredSkills = null;
    this.triggerEvaluator = null;
    this.memoryGitSyncQueue = null;
    this.skillHandlers.clear();
  }

  async onStatusChange(): Promise<void> {
    return undefined;
  }

  async handleAgentToolCall(name: string, args: unknown): Promise<unknown> {
    if (!this.resolver) {
      return { error: "not_active", details: "chatter role is not active" };
    }

    try {
      assertSkillAllowed(name, this.config.skill_allowlist);
    } catch (error) {
      if (error instanceof ChatterPolicyError) {
        return { error: error.code, details: error.message };
      }
      throw error;
    }

    const handler = this.skillHandlers.get(name);
    if (!handler) {
      return { error: "unknown_skill", details: `unknown tool '${name}'` };
    }
    return handler(args);
  }

  /**
   * Opt-in trace claiming so RoleRunner.dispatch routes by trace_id when
   * the inbound HubResult's thread_id is the agent's (the spawn response
   * carries result.thread_id = the new agent's, not ChatterRole's).
   */
  claimsTrace(traceId: string): boolean {
    return this.sessionMgr?.claimsTrace(traceId) ?? false;
  }

  async onInboundResult(result: HubResult): Promise<void> {
    if (!this.ctx || !this.sessionMgr || !this.resolver) return;

    const trace = this.sessionMgr.getTrace(result.trace_id);
    if (trace) {
      switch (trace.purpose) {
        case "spawn":
          await this.onSpawnResponse(result);
          return;
        case "agent_turn":
          await this.onAgentTurnResponse(result);
          return;
        case "job_dispatch":
          await this.forwardToUser(result.content);
          if (
            result.run_state === "completed"
            || result.run_state === "timeout"
            || result.status === "error"
          ) {
            this.sessionMgr.clearTrace(result.trace_id);
          }
          return;
      }
    }

    // New user turn must carry an envelope. Without one we drop silently.
    const envelope = result.payload?.chatter;
    if (!envelope) {
      this.ctx.log.warn("chatter: dropping inbound with no chatter envelope and no known trace", {
        chatter_id: this.config.chatter_id,
        trace_id: result.trace_id,
        source: result.source
      });
      return;
    }

    if (envelope.read_only_query) {
      await this.handleReadOnlyQuery(envelope.read_only_query, envelope.chatter_session_id);
      return;
    }

    if (envelope.control === "confirm_observation") {
      await this.handleConfirmObservation(envelope.observation_id, envelope.chatter_session_id);
      return;
    }

    if (envelope.control === "reject_observation") {
      await this.handleRejectObservation(envelope.observation_id, envelope.chatter_session_id);
      return;
    }

    if (envelope.mode === undefined) {
      this.ctx.log.warn("chatter: dropping inbound with no chatter mode", {
        chatter_id: this.config.chatter_id,
        trace_id: result.trace_id,
        source: result.source
      });
      return;
    }

    try {
      await this.handleNewTurn(result, envelope as ChatterTurnEnvelopeWithMode);
    } catch (error) {
      this.recordTurnError(result.trace_id, "turn_handler_failed", error);
      throw error;
    }
  }

  private async handleNewTurn(
    result: HubResult,
    envelope: ChatterTurnEnvelopeWithMode
  ): Promise<void> {
    try {
      assertModeAllowed(envelope.mode, this.config.allowed_modes);
    } catch (e) {
      if (e instanceof ChatterPolicyError) {
        await this.forwardToUser(`error: ${e.code}: ${e.message}`);
        return;
      }
      throw e;
    }

    if (envelope.control === "new") {
      await this.handleControlNew();
      return;
    }

    if (envelope.control === "interrupt") {
      this.handleControlInterrupt();
      return;
    }

    this.recordExtractStateObservability(envelope);

    const systemPromptId = envelope.system_prompt_id;
    let systemPrompt: string | undefined;
    if (systemPromptId !== undefined) {
      systemPrompt = this.resolver!.manifest.systemPromptContents?.get(systemPromptId);
      if (systemPrompt === undefined) {
        await this.forwardToUser(`error: unknown_system_prompt_id: ${systemPromptId}`);
        return;
      }
    }

    const contextBlock = await this.buildContextBlock(envelope.context_refs);
    const renderedPrompt = renderMumuPromptParts(buildMumuPromptParts({
      systemPromptId,
      systemPrompt,
      contextBlock,
      envelopePromptParts: envelope.prompt_parts,
      legacyUserContent: result.content
    }));
    const dispatchContent = renderedPrompt.content;
    const dispatchChatter = withPromptDiagnostics(stripRawPromptParts(envelope), renderedPrompt.diagnostics);

    if (envelope.mode === "session") {
      await this.writeTurnToMemory(envelope, result.content);
    }

    if (this.pendingSpawnTraceId !== null) {
      // Spawn still handshaking; queue this turn — onSpawnResponse drains.
      this.pendingTurns.push({
        content: dispatchContent,
        chatterSessionId: envelope.chatter_session_id,
        attachments: result.attachments,
        chatter: dispatchChatter
      });
      return;
    }

    if (this.sessionMgr!.currentSessionId === null) {
      this.kickoffSpawn();
      this.pendingTurns.push({
        content: dispatchContent,
        chatterSessionId: envelope.chatter_session_id,
        attachments: result.attachments,
        chatter: dispatchChatter
      });
      return;
    }

    await this.dispatchRun({
      content: dispatchContent,
      chatterSessionId: envelope.chatter_session_id,
      attachments: result.attachments,
      chatter: dispatchChatter
    });
  }

  private recordExtractStateObservability(envelope: ChatterTurnEnvelopeWithMode): void {
    const extractState = envelope.extract_state;
    if (!extractState) {
      return;
    }
    const sessionKey = envelope.chatter_session_id ?? "__unknown_extract_session__";
    const previousStage = this.extractStageBySession.get(sessionKey);
    const fromStage = previousStage ?? "start";
    incrementChatterExtractStateTransitionTotal(fromStage, extractState.stage);
    if (!previousStage && extractState.stage !== "uploaded") {
      incrementChatterExtractStateResumeTotal();
    }
    this.extractStageBySession.set(sessionKey, extractState.stage);
  }

  private async handleSuggestObservation(args: unknown): Promise<unknown> {
    if (!this.observationCache) {
      return { error: "not_active", details: "chatter observation cache is not active" };
    }

    const parsed = ChatterSuggestObservationArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { error: "invalid_args", details: parsed.error.issues };
    }

    const observationId = randomUUID();
    const candidate: ChatterCandidateObservation = {
      observation_id: observationId,
      ...parsed.data
    };
    this.observationCache.put(observationId, candidate.proposed_patch);
    await this.forwardChatterReply(
      JSON.stringify({ candidate_observation: candidate }),
      { candidate_observation: candidate }
    );
    return { ok: true, observation_id: observationId };
  }

  private async handleConfirmObservation(
    observationId: string | undefined,
    chatterSessionId?: string
  ): Promise<void> {
    if (!observationId) {
      await this.forwardChatterReply(
        "error: missing_observation_id",
        chatterSessionId ? { chatter_session_id: chatterSessionId } : {}
      );
      return;
    }

    const entry = this.observationCache?.get(observationId);
    if (!entry) {
      await this.forwardChatterReply(
        `error: observation_expired_or_unknown: ${observationId}`,
        {
          observation_id: observationId,
          ...(chatterSessionId ? { chatter_session_id: chatterSessionId } : {})
        }
      );
      return;
    }

    const result = await this.applyObservationPatch(entry.proposed_patch);
    if (isStructuredError(result)) {
      await this.forwardChatterReply(
        `error: ${result.error}${result.details ? `: ${JSON.stringify(result.details)}` : ""}`,
        {
          observation_id: observationId,
          ...(chatterSessionId ? { chatter_session_id: chatterSessionId } : {})
        }
      );
      return;
    }

    this.observationCache?.evict(observationId);
    await this.forwardChatterReply(`observation_confirmed: ${observationId}`, {
      observation_id: observationId,
      ...(chatterSessionId ? { chatter_session_id: chatterSessionId } : {})
    });
  }

  private async handleRejectObservation(
    observationId: string | undefined,
    chatterSessionId?: string
  ): Promise<void> {
    if (!observationId) {
      await this.forwardChatterReply(
        "error: missing_observation_id",
        chatterSessionId ? { chatter_session_id: chatterSessionId } : {}
      );
      return;
    }

    const entry = this.observationCache?.get(observationId);
    if (!entry) {
      await this.forwardChatterReply(
        `error: observation_expired_or_unknown: ${observationId}`,
        {
          observation_id: observationId,
          ...(chatterSessionId ? { chatter_session_id: chatterSessionId } : {})
        }
      );
      return;
    }

    this.observationCache?.evict(observationId);
    await this.forwardChatterReply(`observation_rejected: ${observationId}`, {
      observation_id: observationId,
      ...(chatterSessionId ? { chatter_session_id: chatterSessionId } : {})
    });
  }

  private async applyObservationPatch(
    proposedPatch: ChatterObservationProposedPatch
  ): Promise<unknown> {
    const current = await this.structuredSkills!.get(
      proposedPatch.record_type,
      proposedPatch.key
    );
    if (isStructuredError(current) && current.error !== "not_found") {
      return current;
    }

    const currentRecord = isStructuredRecordResult(current) ? current.record : {};
    const patched = mergeJsonRecord(currentRecord, proposedPatch.patch);
    const stamped = mergeJsonRecord(patched, {
      agent_observed: {
        confirmed_at: (this.options.now?.() ?? new Date()).toISOString()
      }
    });
    const stampedValidation = validateRecord(this.resolver!.manifest, proposedPatch.record_type, stamped);
    return this.structuredSkills!.upsert(
      proposedPatch.record_type,
      proposedPatch.key,
      stampedValidation.ok ? stamped : patched
    );
  }

  private async handleReadOnlyQuery(
    query: ChatterReadOnlyQuery,
    chatterSessionId?: string
  ): Promise<void> {
    const skill = query.skill;
    const readOnlyAllowlist = this.resolver!.manifest.read_only_allowlist ?? [];
    if (!readOnlyAllowlist.includes(skill)) {
      incrementChatterReadOnlyQueryTotal(skill, "denied_skill");
      await this.forwardReadOnlyQueryResult({
        ok: false,
        error: `denied_skill: ${skill}`
      }, chatterSessionId);
      return;
    }

    const handler = this.skillHandlers.get(skill);
    if (!handler) {
      incrementChatterReadOnlyQueryTotal(skill, "error");
      await this.forwardReadOnlyQueryResult({
        ok: false,
        error: `unknown_skill: ${skill}`
      }, chatterSessionId);
      return;
    }

    try {
      const result = await handler(query.args);
      if (isStructuredError(result)) {
        incrementChatterReadOnlyQueryTotal(skill, "error");
        await this.forwardReadOnlyQueryResult({
          ok: false,
          error: result.error,
          result
        }, chatterSessionId);
        return;
      }

      incrementChatterReadOnlyQueryTotal(skill, "ok");
      await this.forwardReadOnlyQueryResult({ ok: true, result }, chatterSessionId);
    } catch (error) {
      incrementChatterReadOnlyQueryTotal(skill, "error");
      await this.forwardReadOnlyQueryResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }, chatterSessionId);
    }
  }

  private async buildContextBlock(
    contextRefs: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>["context_refs"]
  ): Promise<string | null> {
    if (!contextRefs || contextRefs.length === 0) {
      return null;
    }

    const entries: string[] = [];
    for (const ref of contextRefs) {
      entries.push(await this.buildContextEntry(ref));
    }

    return ["## Pre-loaded context", ...entries].join("\n");
  }

  private async buildContextEntry(ref: { type: string; key: string }): Promise<string> {
    const placeholder = contextPlaceholder(ref);
    const manifest = this.resolver!.manifest;

    if (!hasRecordType(manifest, ref.type)) {
      this.ctx?.log.warn("chatter: unknown context ref type", {
        chatter_id: this.config.chatter_id,
        type: ref.type,
        key: ref.key
      });
      return formatContextEntry(ref, placeholder);
    }

    const result: unknown = await this.structuredSkills!.get(ref.type, ref.key);
    if (isStructuredError(result)) {
      this.ctx?.log.warn(
        result.error === "not_found"
          ? "chatter: context ref not found"
          : "chatter: context ref get failed",
        {
          chatter_id: this.config.chatter_id,
          type: ref.type,
          key: ref.key,
          error: result.error,
          details: result.details
        }
      );
      return formatContextEntry(ref, placeholder);
    }

    if (!isStructuredRecordResult(result)) {
      this.ctx?.log.warn("chatter: context ref returned malformed result", {
        chatter_id: this.config.chatter_id,
        type: ref.type,
        key: ref.key
      });
      return formatContextEntry(ref, placeholder);
    }

    const validation = validateRecord(manifest, ref.type, result.record);
    if (!validation.ok) {
      this.ctx?.log.warn("chatter: context ref failed schema validation", {
        chatter_id: this.config.chatter_id,
        type: ref.type,
        key: ref.key,
        errors: validation.errors
      });
      return formatContextEntry(ref, placeholder);
    }

    return formatContextEntry(ref, `\`\`\`json\n${JSON.stringify(validation.value, null, 2)}\n\`\`\``);
  }

  private async writeTurnToMemory(
    envelope: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>,
    content: string
  ): Promise<void> {
    const skills = makeMemorySkills(this.resolver!, "session");
    const date = new Date().toISOString().slice(0, 10);
    const turnId = randomUUID().slice(0, 8);
    const frontmatter = [
      "---",
      "mode: session",
      "role: user",
      `chatter_session_id: ${envelope.chatter_session_id ?? ""}`,
      ...(envelope.project_id ? [`project_id: ${envelope.project_id}`] : []),
      ...(envelope.story_id ? [`story_id: ${envelope.story_id}`] : []),
      ...(envelope.template_id ? [`template_id: ${envelope.template_id}`] : []),
      ...(envelope.genre ? [`genre: ${envelope.genre}`] : []),
      ...(envelope.transcript?.origin ? [`transcript_origin: ${envelope.transcript.origin}`] : []),
      ...(envelope.transcript?.user_display_content
        ? [`display_content_json: ${JSON.stringify(envelope.transcript.user_display_content)}`]
        : []),
      "---"
    ].join("\n");
    const result = await skills.write({
      binding: "conversation_log",
      vars: { date, turn_id: turnId },
      content: `${frontmatter}\n\n${content}`
    });
    if (result.ok) {
      this.enqueueTurnMemoryCommit();
    }
  }

  private enqueueStructuredMemoryCommit(event: StructuredEvent): void {
    this.enqueueMemoryCommit({
      eventKind: event.name === "structured.delete" ? "structured_delete" : "structured_write",
      recordType: event.type,
      key: event.key
    });
  }

  private enqueueTurnMemoryCommit(): void {
    this.enqueueMemoryCommit({ eventKind: "turn_write" });
  }

  private enqueueMemoryCommit(
    event:
      | { eventKind: "structured_write" | "structured_delete"; recordType: string; key: string }
      | { eventKind: "turn_write" }
  ): void {
    if (!this.memoryGitSyncQueue) {
      return;
    }
    try {
      this.memoryGitSyncQueue.enqueue({
        memoryRoot: this.config.memory_folder,
        userId: pathBasename(this.config.memory_folder),
        source: "chatter",
        ...event
      });
    } catch (error) {
      this.ctx?.log.warn("chatter: memory archive enqueue failed", {
        chatter_id: this.config.chatter_id,
        event_kind: event.eventKind,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private kickoffSpawn(): void {
    const traceId = randomUUID();
    this.pendingSpawnTraceId = traceId;
    this.sessionMgr!.registerTrace({
      trace_id: traceId,
      purpose: "spawn",
      agent_session_id: null
    });

    const spawnMsg: HubMessage = {
      trace_id: traceId,
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "spawn",
      target: agentTypeForKind(this.config.llm_agent_kind),
      priority: 5,
      payload: {
        content: "",
        attachments: [],
        spawn_dir: this.config.memory_folder,
        tool_descriptors: [...(this.sandboxPlan?.toolDescriptors ?? [])],
        ...(this.config.llm_model !== undefined ? { model_id: this.config.llm_model } : {}),
        ...(this.config.credential_id !== undefined ? { credential_id: this.config.credential_id } : {})
      },
      mode: "bridge",
      reply_channel: ROLES_SOCKET_REPLY_CHANNEL,
      suppress_reply: false
    };

    void this.ctx!.sendToHub(spawnMsg).catch((e) => {
      this.recordTurnError(traceId, "spawn_dispatch_failed", e);
      this.failPendingSpawn(`spawn dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private async onSpawnResponse(result: HubResult): Promise<void> {
    if (this.pendingSpawnTraceId !== result.trace_id) {
      // Late arrival after /new or /interrupt cancelled the spawn — drop.
      this.sessionMgr!.clearTrace(result.trace_id);
      return;
    }

    if (result.status === "error") {
      this.recordTurnError(result.trace_id, "spawn_failed", result.content);
      this.failPendingSpawn(`spawn failed: ${result.content}`);
      return;
    }

    const newAgentThreadId = result.thread_id;
    if (!newAgentThreadId) {
      this.failPendingSpawn("spawn response missing thread_id");
      return;
    }

    this.sessionMgr!.bindAgentSession(newAgentThreadId);
    this.sessionMgr!.clearTrace(result.trace_id);
    this.pendingSpawnTraceId = null;

    const queued = this.pendingTurns.splice(0);
    for (const turn of queued) {
      await this.dispatchRun(turn);
    }
    await this.drainSelfInitiatedTurnQueue();
  }

  private async onAgentTurnResponse(result: HubResult): Promise<void> {
    const trace = this.sessionMgr!.getTrace(result.trace_id);
    if (trace?.chatter_session_id) {
      const fallback = await this.applyAgentStructuredFallback(result.content, result.payload?.chatter);
      const reply = this.applyMumuUserReplyBoundary(fallback.content, {
        ...(fallback.chatter ?? {}),
        ...(result.payload?.chatter ?? {}),
        chatter_session_id: trace.chatter_session_id,
        ...(trace.diagnostics ? { diagnostics: trace.diagnostics } : {})
      });
      await this.forwardChatterReply(reply.content, reply.chatter);
    } else {
      const fallback = await this.applyAgentStructuredFallback(result.content, result.payload?.chatter);
      const reply = this.applyMumuUserReplyBoundary(fallback.content, {
        ...(fallback.chatter ?? {}),
        ...(result.payload?.chatter ?? {})
      });
      await this.deliverChatterReply(reply.content, reply.chatter, "success");
    }
    if (result.status === "error") {
      this.recordTurnError(result.trace_id, "agent_turn_failed", result.content);
    } else if (result.run_state === "completed") {
      this.clearTurnError();
    }

    if (
      result.run_state === "completed"
      || result.run_state === "timeout"
      || result.status === "error"
    ) {
      this.sessionMgr!.clearTrace(result.trace_id);
      await this.drainSelfInitiatedTurnQueue();
    }
  }

  private applyMumuUserReplyBoundary(
    content: string,
    chatter: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>
  ): {
    content: string;
    chatter: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>;
  } {
    if (!this.isMumuUserReplyChannel()) {
      return { content, chatter: stripRawPromptParts(chatter) };
    }

    if (chatter.reply_parse) {
      if (!containsUnsafeMumuUserReplyContent(content)) {
        return {
          content,
          chatter: withReplyParseDiagnostics(stripRawPromptParts(chatter), chatter.reply_parse)
        };
      }
      const fallback = fallbackMumuUserReply("unsafe_content", chatter.reply_parse.valid_block_count);
      const replyParse = mumuUserReplyParseDiagnostics(fallback);
      return {
        content: fallback.content,
        chatter: withReplyParseDiagnostics(stripRawPromptParts(chatter), replyParse)
      };
    }

    const parsed = parseMumuUserReply(content);
    if (!parsed.ok) {
      this.ctx?.log.warn("chatter: mumu user reply parser used fallback", {
        chatter_id: this.config.chatter_id,
        status: parsed.status,
        valid_block_count: parsed.valid_block_count,
        raw_content_length: content.length
      });
    }

    const replyParse = mumuUserReplyParseDiagnostics(parsed);
    return {
      content: parsed.content,
      chatter: withReplyParseDiagnostics(stripRawPromptParts(chatter), replyParse)
    };
  }

  private isMumuUserReplyChannel(): boolean {
    const replyChannel = this.config.user_reply_channel;
    return replyChannel.channel === "socket" && replyChannel.chat_id.startsWith("ads:mumu:");
  }

  private async applyAgentStructuredFallback(
    content: string,
    existingChatter?: NonNullable<HubResult["payload"]>["chatter"]
  ): Promise<{
    content: string;
    chatter: NonNullable<HubResult["payload"]>["chatter"];
  }> {
    const fallback = parseAgentStructuredFallback(content);
    const chatter: NonNullable<HubResult["payload"]>["chatter"] = {};

    if (!existingChatter?.extract_state && fallback.chatter.extract_state) {
      chatter.extract_state = fallback.chatter.extract_state;
    }

    if (!existingChatter?.candidate_observation) {
      for (const call of fallback.toolCalls) {
        const result = await this.handleAgentToolCall(call.tool, call.args);
        if (isStructuredError(result)) {
          this.ctx?.log.warn("chatter: structured fallback tool call failed", {
            chatter_id: this.config.chatter_id,
            tool: call.tool,
            error: result.error,
            details: result.details
          });
        }
      }
    }

    return {
      content: stripAgentStructuredFallbackContent(content),
      chatter
    };
  }

  private failPendingSpawn(reason: string): void {
    if (this.pendingSpawnTraceId !== null) {
      this.sessionMgr!.clearTrace(this.pendingSpawnTraceId);
      this.pendingSpawnTraceId = null;
    }
    const queued = this.pendingTurns.splice(0);
    for (let i = 0; i < queued.length; i += 1) {
      void this.forwardToUser(`error: ${reason}`).catch(() => undefined);
    }
  }

  private async shutdownAgentSession(): Promise<void> {
    const sessionMgr = this.sessionMgr;
    if (!sessionMgr) return;

    if (this.pendingSpawnTraceId !== null) {
      sessionMgr.clearTrace(this.pendingSpawnTraceId);
      this.pendingSpawnTraceId = null;
    }
    this.pendingTurns.splice(0);

    const previousAgentThreadId = sessionMgr.currentSessionId;
    try {
      if (previousAgentThreadId !== null && this.ctx) {
        const killMsg: HubMessage = {
          trace_id: randomUUID(),
          thread_id: this.threadId,
          actor_id: ROLES_SERVICE_ID,
          intent: "kill",
          target: previousAgentThreadId,
          priority: 5,
          payload: { content: "", attachments: [] },
          mode: "bridge",
          reply_channel: ROLES_SOCKET_REPLY_CHANNEL,
          suppress_reply: true
        };
        await this.ctx.sendToHub(killMsg);
      }
    } catch (error) {
      this.ctx?.log.warn("chatter: archive kill failed", {
        chatter_id: this.config.chatter_id,
        agent_session_id: previousAgentThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      sessionMgr.markSessionDead();
    }
  }

  private async dispatchRun(turn: QueuedTurn): Promise<void> {
    const traceId = randomUUID();
    this.sessionMgr!.registerTrace({
      trace_id: traceId,
      purpose: "agent_turn",
      agent_session_id: this.sessionMgr!.currentSessionId,
      ...(turn.chatterSessionId ? { chatter_session_id: turn.chatterSessionId } : {}),
      ...(turn.chatter.diagnostics ? { diagnostics: turn.chatter.diagnostics } : {})
    });

    const runMsg: HubMessage = {
      trace_id: traceId,
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: this.sessionMgr!.currentSessionId as string,
      priority: 5,
      payload: { content: turn.content, attachments: turn.attachments, chatter: turn.chatter },
      mode: "bridge",
      reply_channel: ROLES_SOCKET_REPLY_CHANNEL,
      suppress_reply: false
    };

    try {
      await this.ctx!.sendToHub(runMsg);
      this.clearTurnError();
    } catch (e) {
      this.sessionMgr!.clearTrace(traceId);
      this.recordTurnError(traceId, "agent_dispatch_failed", e);
      await this.forwardToUser(
        `error: agent dispatch failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async dispatchSelfInitiatedRun(request: SelfInitiatedTurnRequest): Promise<void> {
    const agentSessionId = this.sessionMgr!.currentSessionId;
    if (agentSessionId === null) {
      this.recordSelfInitiatedTurnError(request.trigger_name, "missing_agent_session");
      return;
    }

    const message: HubMessage = {
      trace_id: randomUUID(),
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: agentSessionId,
      priority: 5,
      payload: {
        content: "",
        attachments: [],
        chatter: {
          origin: "trigger",
          system_prompt_id: request.system_prompt_id
        }
      },
      mode: "bridge",
      reply_channel: this.config.user_reply_channel,
      suppress_reply: false
    };

    this.ctx!.log.info("chatter: scheduled self-initiated turn", {
      chatter_id: this.config.chatter_id,
      trigger_name: request.trigger_name,
      origin: request.origin
    });
    incrementChatterSelfInitiatedTurnTotal(request.trigger_name);

    try {
      await this.ctx!.sendToHub(message);
    } catch (error) {
      this.recordSelfInitiatedTurnError(request.trigger_name, error);
    }
  }

  private async drainSelfInitiatedTurnQueue(): Promise<void> {
    if (!this.sessionMgr || this.sessionMgr.hasActiveAgentTurn) return;

    while (!this.sessionMgr.hasActiveAgentTurn && this.sessionMgr.queuedSelfInitiatedTurnCount > 0) {
      const next = this.sessionMgr.shiftSelfInitiatedTurn();
      if (!next) return;
      await this.dispatchSelfInitiatedRun(next);
    }
  }

  private async handleControlNew(): Promise<void> {
    if (this.pendingSpawnTraceId !== null) {
      await this.forwardToUser(
        "error: cannot rotate session while spawn is in progress; try again after current spawn completes"
      );
      return;
    }

    const previousAgentThreadId = this.sessionMgr!.currentSessionId;
    if (previousAgentThreadId !== null) {
      const killMsg: HubMessage = {
        trace_id: randomUUID(),
        thread_id: this.threadId,
        actor_id: ROLES_SERVICE_ID,
        intent: "kill",
        target: previousAgentThreadId,
        priority: 5,
        payload: { content: "", attachments: [] },
        mode: "bridge",
        reply_channel: ROLES_SOCKET_REPLY_CHANNEL,
        suppress_reply: true
      };
      void this.ctx!.sendToHub(killMsg).catch(() => undefined);
    }

    this.sessionMgr!.unbindAgentSession();
    await this.forwardToUser("new session pending: next turn will spawn a fresh agent");
  }

  private handleControlInterrupt(): void {
    if (this.pendingSpawnTraceId !== null) {
      this.sessionMgr!.clearTrace(this.pendingSpawnTraceId);
      this.pendingSpawnTraceId = null;
    }
    const cancelled = this.sessionMgr!.interrupt();
    this.pendingTurns.splice(0);
    this.sessionMgr!.clearSelfInitiatedTurnQueue();
    void this.forwardToUser(`interrupt: cancelled ${cancelled.length} in-flight item(s)`).catch(
      () => undefined
    );
  }

  private async forwardToUser(content: string): Promise<void> {
    if (!this.ctx || !this.config.user_reply_channel) return;
    await this.deliverChatterReply(content, {}, "success");
  }

  private async forwardChatterReply(
    content: string,
    chatter: NonNullable<HubMessage["payload"]["chatter"]>
  ): Promise<void> {
    if (!this.ctx || !this.config.user_reply_channel) return;
    await this.deliverChatterReply(content, chatter, "success");
  }

  private recordTurnError(traceId: string, code: string, error: unknown): void {
    this.store?.recordTurnError(traceId, code, error);
  }

  private clearTurnError(): void {
    this.store?.clearTurnError();
  }

  private recordSelfInitiatedTurnError(triggerName: string, error: unknown): void {
    incrementChatterSelfInitiatedTurnErrorTotal(triggerName);
    this.ctx?.log.warn("chatter: self-initiated turn failed", {
      chatter_id: this.config.chatter_id,
      trigger_name: triggerName,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  private async forwardReadOnlyQueryResult(
    result: ChatterReadOnlyQueryResult,
    chatterSessionId?: string
  ): Promise<void> {
    if (!this.ctx || !this.config.user_reply_channel) {
      return;
    }
    const envelope: NonNullable<NonNullable<HubResult["payload"]>["chatter"]> = {
      read_only_query_result: result,
      ...(chatterSessionId ? { chatter_session_id: chatterSessionId } : {})
    };
    const content = JSON.stringify({ read_only_query_result: result });
    await this.deliverChatterReply(content, envelope, result.ok ? "success" : "error");
  }

  // Deliver a chatter reply to the user_reply_channel.
  //
  // Always queues a HubMessage via ctx.sendToHub (preserves the existing
  // observation contract for tests + telegram/web channels — their adapters
  // can read content+chatter from the hub's unified-reply path).
  //
  // For socket channels (ADS-driven chatters) we ADDITIONALLY write a
  // HubResult directly to the user_reply_channel.socket_path. This is the
  // only path that actually delivers, because the hub's processIncomingMessage
  // (a) suppresses the unified-reply when message.suppress_reply is true and
  // (b) builds its result via buildResult, which discards message.payload —
  // so the chatter envelope (chatter_session_id, read_only_query_result, ...)
  // would otherwise be lost in transit. The receiver demuxes by
  // chatter_session_id; without the envelope, it can't.
  private async deliverChatterReply(
    content: string,
    chatter: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>,
    status: HubResult["status"]
  ): Promise<void> {
    if (!this.ctx || !this.config.user_reply_channel) {
      return;
    }
    const replyChannel = this.config.user_reply_channel;

    const msg: HubMessage = {
      trace_id: randomUUID(),
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: "global",
      priority: 5,
      payload: { content, attachments: [], chatter },
      mode: "bridge",
      reply_channel: replyChannel,
      suppress_reply: true
    };
    await this.ctx.sendToHub(msg);

    if (replyChannel.channel === "socket" && replyChannel.socket_path) {
      await this.writeHubResultToSocket(replyChannel.socket_path, content, chatter, status);
    }
  }

  private async writeHubResultToSocket(
    socketPath: string,
    content: string,
    chatter: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>,
    status: HubResult["status"]
  ): Promise<void> {
    const result: HubResult = {
      trace_id: randomUUID(),
      thread_id: this.threadId,
      source: ROLES_SERVICE_ID,
      status,
      content,
      attachments: [],
      timestamp: new Date().toISOString(),
      payload: { chatter }
    };

    const writer = this.options.socketWriter ?? defaultChatterSocketWriter;
    try {
      await writer(socketPath, result);
    } catch (error) {
      this.ctx?.log.warn("chatter: socket reply delivery failed", {
        chatter_id: this.config.chatter_id,
        socket_path: socketPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async scheduleSelfInitiatedTurn(request: BackgroundTriggerFireRequest): Promise<void> {
    if (!this.options.scheduleSelfInitiatedTurn) {
      await this.scheduleInternalSelfInitiatedTurn(request);
      return;
    }
    await this.options.scheduleSelfInitiatedTurn(request);
  }

  private async scheduleInternalSelfInitiatedTurn(request: BackgroundTriggerFireRequest): Promise<void> {
    if (!this.ctx || !this.sessionMgr || !this.resolver) {
      incrementChatterSelfInitiatedTurnErrorTotal(request.trigger_name);
      return;
    }

    const systemPromptExists = this.resolver.manifest.systemPromptContents?.has(request.system_prompt_id) ?? false;
    if (!systemPromptExists) {
      this.recordSelfInitiatedTurnError(request.trigger_name, `unknown_system_prompt_id: ${request.system_prompt_id}`);
      return;
    }

    const turnRequest: SelfInitiatedTurnRequest = {
      system_prompt_id: request.system_prompt_id,
      origin: "trigger",
      trigger_name: request.trigger_name
    };

    if (this.pendingSpawnTraceId !== null) {
      this.sessionMgr.enqueueSelfInitiatedTurn(turnRequest);
      return;
    }

    if (this.sessionMgr.currentSessionId === null) {
      this.recordSelfInitiatedTurnError(request.trigger_name, "missing_agent_session");
      return;
    }

    if (this.sessionMgr.hasActiveAgentTurn) {
      this.sessionMgr.enqueueSelfInitiatedTurn(turnRequest);
      return;
    }

    await this.dispatchSelfInitiatedRun(turnRequest);
  }
}

const CHATTER_SOCKET_REPLY_CONNECT_TIMEOUT_MS = 5_000;

const defaultChatterSocketWriter: ChatterSocketWriter = (socketPath, result) =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(socketPath);
    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      socket.destroy(new Error(
        `chatter socket reply connect timed out after ${CHATTER_SOCKET_REPLY_CONNECT_TIMEOUT_MS}ms`
      ));
    }, CHATTER_SOCKET_REPLY_CONNECT_TIMEOUT_MS);

    socket.once("connect", () => {
      clearTimeout(timer);
      try {
        socket.end(JSON.stringify(result), () => settle());
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      settle(error);
    });
  });

function stripRawPromptParts(chatter: ChatterEnvelope): ChatterEnvelope {
  const safeChatter = { ...chatter };
  delete safeChatter.prompt_parts;
  return safeChatter;
}

function withPromptDiagnostics(
  chatter: ChatterEnvelope,
  diagnostics: Pick<MumuChatterDiagnostics, "prompt_part_ids" | "preference_status">
): ChatterEnvelope {
  return {
    ...chatter,
    diagnostics: {
      ...(chatter.diagnostics ?? {}),
      prompt_part_ids: diagnostics.prompt_part_ids,
      preference_status: chatter.diagnostics?.preference_status ?? diagnostics.preference_status
    }
  };
}

function withReplyParseDiagnostics(
  chatter: ChatterEnvelope,
  replyParse: MumuReplyParseDiagnostics
): ChatterEnvelope {
  return {
    ...chatter,
    reply_parse: replyParse,
    diagnostics: {
      ...(chatter.diagnostics ?? {}),
      reply_parse: { ...replyParse }
    }
  };
}

function contextPlaceholder(ref: { type: string; key: string }): string {
  return `**[context not found: ${ref.type}/${ref.key}]**`;
}

function formatContextEntry(ref: { type: string; key: string }, body: string): string {
  return [`### type: ${ref.type}, key: ${ref.key}`, body].join("\n");
}

function isStructuredError(value: unknown): value is { error: string; details?: unknown } {
  return isObject(value) && typeof value.error === "string";
}

function isStructuredRecordResult(value: unknown): value is { record: unknown } {
  return isObject(value) && "record" in value;
}

function mergeJsonRecord(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const baseRecord = isObject(base) ? base : {};
  return mergeJsonValue(baseRecord, patch) as Record<string, unknown>;
}

function mergeJsonValue(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) {
    return mergeJsonArrays(base, patch);
  }
  if (isObject(base) && isObject(patch)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = key in merged ? mergeJsonValue(merged[key], value) : cloneJsonValue(value);
    }
    return merged;
  }
  return cloneJsonValue(patch);
}

function mergeJsonArrays(base: unknown[], patch: unknown[]): unknown[] {
  const merged = base.map(cloneJsonValue);
  const seen = new Set(merged.map(stableJsonKey));
  for (const value of patch) {
    const key = stableJsonKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(cloneJsonValue(value));
    }
  }
  return merged;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)])
    );
  }
  return value;
}

function stableJsonKey(value: unknown): string {
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveMemoryGitSyncQueue(
  memoryFolder: string,
  options: ChatterRoleOptions
): MumuMemoryGitSyncQueueLike | null {
  if (options.memoryGitSyncQueue === false) {
    return null;
  }
  if (options.memoryGitSyncQueue) {
    return options.memoryGitSyncQueue;
  }
  return isMumuUserMemoryRoot(memoryFolder) ? getDefaultMumuMemoryGitSyncQueue() : null;
}

function pathBasename(value: string): string {
  const parts = value.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
