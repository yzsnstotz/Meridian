import { randomUUID } from "node:crypto";
import { ROLES_SERVICE_ID, ROLES_SOCKET_PATH } from "../../config";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../types";
import type { BaseRole, RoleContext } from "../base-role";
import { loadManifestFromTemplate, loadManifestFromFile } from "../chatter/manifest";
import { MemoryResolver } from "../chatter/memory-resolver";
import { buildSandboxSpawnPlan, type SandboxSpawnPlan } from "../chatter/sandbox";
import { makeMemorySkills } from "../chatter/memory-skills";
import { assertModeAllowed, assertSkillAllowed, ChatterPolicyError } from "../chatter/allowlist";
import { ChatterStateStore } from "../chatter/chatter-state-store";
import { SessionManager } from "../chatter/session-manager";
import {
  makeStructuredSkills,
  registerStructuredSkills,
  type StructuredSkillName
} from "../chatter/skills/structured";

const ROLES_SOCKET_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: ROLES_SERVICE_ID,
  socket_path: ROLES_SOCKET_PATH
};

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
}

export class ChatterRole implements BaseRole {
  readonly roleType = "chatter" as const;
  readonly threadId: string;
  readonly config: ChatterRoleConfig;

  private ctx: RoleContext | null = null;
  private resolver: MemoryResolver | null = null;
  private sessionMgr: SessionManager | null = null;
  private sandboxPlan: SandboxSpawnPlan | null = null;
  private store: ChatterStateStore | null = null;
  private skillHandlers = new Map<string, (args: unknown) => Promise<unknown>>();

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

  constructor(threadId: string, config: ChatterRoleConfig) {
    this.threadId = threadId;
    this.config = config;
  }

  async onActivate(ctx: RoleContext): Promise<void> {
    this.ctx = ctx;
    const manifest = this.config.template
      ? loadManifestFromTemplate(this.config.template)
      : loadManifestFromFile(this.config.manifest_path as string);
    this.resolver = new MemoryResolver(this.config.memory_folder, manifest);
    this.skillHandlers.clear();
    registerStructuredSkills(makeStructuredSkills(this.resolver), {
      register: (name: StructuredSkillName, handler: (args: unknown) => Promise<unknown>) => {
        this.skillHandlers.set(name, handler);
      }
    });
    this.store = new ChatterStateStore(this.config.memory_folder);
    this.sessionMgr = new SessionManager(this.store);
    this.sessionMgr.rehydrate();
    this.sandboxPlan = buildSandboxSpawnPlan({
      memoryFolder: this.config.memory_folder,
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

    await this.handleNewTurn(result, envelope);
  }

  private async handleNewTurn(
    result: HubResult,
    envelope: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>
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

    const systemPromptId = envelope.system_prompt_id;
    let dispatchContent = result.content;
    if (systemPromptId !== undefined) {
      const systemPrompt = this.resolver!.manifest.systemPromptContents?.get(systemPromptId);
      if (systemPrompt === undefined) {
        await this.forwardToUser(`error: unknown_system_prompt_id: ${systemPromptId}`);
        return;
      }
      dispatchContent = composeTurnContent(systemPrompt, result.content);
    }

    if (envelope.mode === "session") {
      await this.writeTurnToMemory(envelope, result.content);
    }

    if (this.pendingSpawnTraceId !== null) {
      // Spawn still handshaking; queue this turn — onSpawnResponse drains.
      this.pendingTurns.push({ content: dispatchContent });
      return;
    }

    if (this.sessionMgr!.currentSessionId === null) {
      this.kickoffSpawn();
      this.pendingTurns.push({ content: dispatchContent });
      return;
    }

    await this.dispatchRun(dispatchContent);
  }

  private async writeTurnToMemory(
    envelope: NonNullable<NonNullable<HubResult["payload"]>["chatter"]>,
    content: string
  ): Promise<void> {
    const skills = makeMemorySkills(this.resolver!, "session");
    const date = new Date().toISOString().slice(0, 10);
    const turnId = randomUUID().slice(0, 8);
    await skills.write({
      binding: "conversation_log",
      vars: { date, turn_id: turnId },
      content: `---\nmode: session\nrole: user\nchatter_session_id: ${envelope.chatter_session_id ?? ""}\n---\n\n${content}`
    });
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
      await this.dispatchRun(turn.content);
    }
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

  private async dispatchRun(content: string): Promise<void> {
    const traceId = randomUUID();
    this.sessionMgr!.registerTrace({
      trace_id: traceId,
      purpose: "agent_turn",
      agent_session_id: this.sessionMgr!.currentSessionId
    });

    const runMsg: HubMessage = {
      trace_id: traceId,
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: this.sessionMgr!.currentSessionId as string,
      priority: 5,
      payload: { content, attachments: [] },
      mode: "bridge",
      reply_channel: ROLES_SOCKET_REPLY_CHANNEL,
      suppress_reply: false
    };

    try {
      await this.ctx!.sendToHub(runMsg);
    } catch (e) {
      this.sessionMgr!.clearTrace(traceId);
      await this.forwardToUser(
        `error: agent dispatch failed: ${e instanceof Error ? e.message : String(e)}`
      );
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
    void this.forwardToUser(`interrupt: cancelled ${cancelled.length} in-flight item(s)`).catch(
      () => undefined
    );
  }

  private async forwardToUser(content: string): Promise<void> {
    if (!this.ctx || !this.config.user_reply_channel) return;
    const msg: HubMessage = {
      trace_id: randomUUID(),
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: "global",
      priority: 5,
      payload: { content, attachments: [] },
      mode: "bridge",
      reply_channel: this.config.user_reply_channel,
      suppress_reply: true
    };
    await this.ctx.sendToHub(msg);
  }
}

function composeTurnContent(systemPrompt: string, userContent: string): string {
  return [
    "System prompt for this turn:",
    systemPrompt.trimEnd(),
    "",
    "User turn:",
    userContent
  ].join("\n");
}
