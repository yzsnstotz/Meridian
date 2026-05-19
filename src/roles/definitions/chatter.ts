import { randomUUID } from "node:crypto";
import { ROLES_SERVICE_ID, ROLES_SOCKET_PATH } from "../../config";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../types";
import type { BaseRole, RoleContext } from "../base-role";
import { loadManifestFromTemplate, loadManifestFromFile } from "../chatter/manifest";
import { MemoryResolver } from "../chatter/memory-resolver";
import { buildSandboxSpawnPlan, type SandboxSpawnPlan } from "../chatter/sandbox";
import { makeMemorySkills } from "../chatter/memory-skills";
import { assertModeAllowed, ChatterPolicyError } from "../chatter/allowlist";
import { ChatterStateStore } from "../chatter/chatter-state-store";
import { SessionManager } from "../chatter/session-manager";

const ROLES_SOCKET_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: ROLES_SERVICE_ID,
  socket_path: ROLES_SOCKET_PATH
};

const DEFAULT_AGENT_TARGET = "claude-code";

export class ChatterRole implements BaseRole {
  readonly roleType = "chatter" as const;
  readonly threadId: string;
  readonly config: ChatterRoleConfig;

  private ctx: RoleContext | null = null;
  private resolver: MemoryResolver | null = null;
  private sessionMgr: SessionManager | null = null;
  private sandboxPlan: SandboxSpawnPlan | null = null;
  private store: ChatterStateStore | null = null;

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
    this.ctx = null;
  }

  async onStatusChange(): Promise<void> {
    return undefined;
  }

  async onInboundResult(result: HubResult): Promise<void> {
    if (!this.ctx || !this.sessionMgr || !this.resolver) return;

    // Forward path: result matches a trace we issued
    const trace = this.sessionMgr.getTrace(result.trace_id);
    if (trace) {
      await this.forwardToUser(result.content);
      if (result.run_state === "completed" || result.run_state === "timeout") {
        this.sessionMgr.clearTrace(result.trace_id);
      }
      return;
    }

    // New user turn must carry an envelope. Without one we drop silently
    // (avoids reacting to stray hub traffic that wasn't addressed to us).
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
      const { newSessionId } = this.sessionMgr!.newSession();
      await this.forwardToUser(`new session started: ${newSessionId}`);
      return;
    }

    if (envelope.control === "interrupt") {
      const cancelled = this.sessionMgr!.interrupt();
      await this.forwardToUser(`interrupt: cancelled ${cancelled.length} in-flight item(s)`);
      return;
    }

    if (this.sessionMgr!.currentSessionId === null) {
      this.sessionMgr!.start();
    }

    if (envelope.mode === "session") {
      const skills = makeMemorySkills(this.resolver!, "session");
      const date = new Date().toISOString().slice(0, 10);
      const turnId = randomUUID().slice(0, 8);
      await skills.write({
        binding: "conversation_log",
        vars: { date, turn_id: turnId },
        content: `---\nmode: session\nrole: user\nchatter_session_id: ${envelope.chatter_session_id ?? ""}\n---\n\n${result.content}`
      });
    }

    const outboundTraceId = randomUUID();
    this.sessionMgr!.registerTrace({
      trace_id: outboundTraceId,
      purpose: "agent_turn",
      agent_session_id: this.sessionMgr!.currentSessionId
    });

    const msg: HubMessage = {
      trace_id: outboundTraceId,
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: DEFAULT_AGENT_TARGET,
      priority: 5,
      payload: {
        content: result.content,
        attachments: [],
        ...(this.config.credential_id !== undefined ? { credential_id: this.config.credential_id } : {})
      },
      mode: "bridge",
      reply_channel: ROLES_SOCKET_REPLY_CHANNEL,
      suppress_reply: false
    };

    try {
      await this.ctx!.sendToHub(msg);
    } catch (e) {
      this.sessionMgr!.clearTrace(outboundTraceId);
      await this.forwardToUser(
        `error: agent dispatch failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
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
