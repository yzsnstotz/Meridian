import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import { z } from "zod";

import { config } from "../config";
import { createLogger } from "../logger";
import { buildClaudeStreamArgs } from "../agents/claude";
import { buildCodexExecArgs, buildCodexResumeArgs } from "../agents/codex";
import { buildGeminiStreamArgs } from "../agents/gemini";
import { isApprovalPrompt, parseApprovalSummaryFromRawContent } from "../shared/approval";
import { cleanupStagedAttachments, transformAttachments } from "../shared/attachment-transform";
import { classifyAgentOutput, type AgentOutputKind } from "../shared/agent-output";
import { shapeHistoryPayload } from "../shared/history-payload";
import { createClaudeStreamParser } from "../shared/stream-parsers/claude";
import { createCodexStreamParser, extractThreadId } from "../shared/stream-parsers/codex";
import { createGeminiStreamParser } from "../shared/stream-parsers/gemini";
import { streamFromSpawn, type OutputDelta } from "../shared/stream-adapter";
import { resolveTelegramDetailRecord } from "./result-sender";
import { AgentAPIClient } from "../shared/agentapi-client";
import { sendIpcRequest } from "../shared/ipc";
import { buildWebGuiUrl, tryBuildGuiInlineKeyboard } from "../shared/telegram-controls";
import {
  BUILT_IN_INTENTS,
  AgentInstanceStatusSchema,
  AgentTypeSchema,
  CallerIdentitySchema,
  HubMessageSchema,
  HubResultSchema,
  ThreadProgressSnapshotSchema,
  type AgentInstance,
  type AgentType,
  type AttachmentResult,
  type CallerIdentity,
  type FileAttachment,
  type HubMessage,
  type HubResult,
  type HubRunState,
  type ReplyChannel,
  type ServiceEndpoint,
  type ThreadProgressSnapshot
} from "../types";
import type { WireAuth } from "../shared/caller-wire";
import { CallerRegistry, type CallerRecord } from "./caller-registry";
import { InstanceManager } from "./instance-manager";
import { OutputBus } from "./output-bus";
import { InstanceRegistry } from "./registry";
import { ServiceRegistry } from "./service-registry";
import {
  buildPersistedHubState,
  type ConversationEventKind,
  loadPersistedHubState,
  savePersistedHubState,
  type PersistedConversationHistoryEntry,
  type PersistedHubState,
  type PersistedPushSubscription
} from "./state-store";

interface AgentClient {
  connect: (socketPath: string) => Promise<void>;
  disconnect: () => void;
  sendMessage: (
    content: string,
    attachments: HubMessage["payload"]["attachments"],
    agentType?: AgentType
  ) => Promise<Record<string, unknown>>;
  getStatus: () => Promise<Record<string, unknown>>;
  getMessages?: () => Promise<Record<string, unknown>[]>;
}

interface AgentMessageSnapshot {
  id: number;
  content: string;
  kind: AgentOutputKind;
}

type AgentReplyWaitResult =
  | {
      kind: "final";
      content: string;
    }
  | {
      kind: "non_final";
      runState: Exclude<HubRunState, "completed">;
      content: string | null;
    };

interface StreamRunResult {
  content: string;
  attachmentResults: AttachmentResult[];
}

interface SessionAttachmentMetadata {
  channel: string;
  chatId: string;
  botId: string | null;
  chatName: string | null;
  botName: string | null;
}

interface MonitorUpdateSubscription {
  sessionId: string;
  chatId: string;
  botId?: string;
  replyChannel: ReplyChannel;
  intervalMs: number;
  nextDispatchAtMs: number;
}

export interface MonitorUpdateDispatch {
  threadId: string;
  chatId: string;
  botId?: string;
  replyChannel: ReplyChannel;
}

interface PushSubscription {
  sessionId?: string;
  chatId: string;
  botId?: string;
  replyChannel: ReplyChannel;
}

export interface ConversationHistoryEntry {
  id: string;
  sequence: number;
  event_kind: ConversationEventKind;
  source: string;
  type: "user" | "agent";
  content: string;
  details_text: string;
  raw_content: string;
  trace_id: string | null;
  timestamp: string;
  replace_key: string | null;
}

interface ActiveRunState {
  traceId: string;
  streamProcess?: ChildProcess | null;
  interrupted?: boolean;
}

interface CompletedRunRecord {
  traceId: string;
  completedAtMs: number;
}

export interface PushDeliveryTarget {
  threadId: string;
  chatId: string;
  botId?: string;
  replyChannel: ReplyChannel;
}

const LIVE_INSTANCE_STATUSES = new Set<AgentInstance["status"]>(["idle", "running", "waiting"]);
const SUMMARY_MARKER_BEGIN = "[[MERIDIAN_SUMMARY_BEGIN";
const SUMMARY_MARKER_END = "[[MERIDIAN_SUMMARY_END";
const AGENT_ROLES = new Set(["agent", "assistant"]);
const THREAD_HISTORY_LIMIT = 400;
const ATTACHMENT_INLINE_CHAR_LIMIT = 12_000;
const ATTACHMENT_TOTAL_INLINE_CHAR_LIMIT = 40_000;

function conversationEntryTypeForEventKind(eventKind: ConversationEventKind): "user" | "agent" {
  return eventKind === "user_send" || eventKind === "terminal_input" ? "user" : "agent";
}

function isReplaceableConversationEventKind(eventKind: ConversationEventKind): eventKind is "progress" | "approval" {
  return eventKind === "progress" || eventKind === "approval";
}

function isSupersededByFinalReplyConversationEventKind(eventKind: ConversationEventKind): eventKind is "progress" {
  return eventKind === "progress";
}

function encodeSessionId(chatId: string, botId: string | undefined): string {
  return botId ? `${botId}:${chatId}` : chatId;
}

export interface HubRouterOptions {
  clientFactory?: (threadId: string) => AgentClient;
  instanceManager?: InstanceManager;
  now?: () => Date;
  outputBus?: OutputBus;
  statePath?: string;
  serviceRegistry?: ServiceRegistry;
}

const BUILT_IN_INTENT_SET = new Set<string>(BUILT_IN_INTENTS);
const ADMIN_ONLY_INTENTS = new Set<string>(["register_caller", "unregister_caller", "rotate_caller_key"]);
const ADMIN_CALLER_ID = "meridian-admin";

const RegisterCallerPayloadSchema = z
  .object({
    caller_id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
    caller_label: z.string().min(1).max(64),
    caller_kind: z.literal("external").optional()
  })
  .strict();

const CallerIdOnlyPayloadSchema = z
  .object({
    caller_id: z.string().min(1)
  })
  .strict();

class RunInterruptedError extends Error {
  constructor(readonly threadId: string) {
    super(`Agent run interrupted for thread_id=${threadId}`);
    this.name = "RunInterruptedError";
  }
}

function resolveSourceFromTarget(target: string): AgentType {
  const candidate = AgentTypeSchema.safeParse(target);
  if (candidate.success) {
    return candidate.data;
  }
  return "codex";
}

function buildSummaryProtocolPrompt(traceId: string): string {
  return [
    "",
    "Meridian protocol requirement (must follow exactly):",
    `1) Output exactly ONE summary block with trace_id=${traceId}.`,
    "2) Do not output any content outside the summary block.",
    "3) Both tags must be single-line and must match the same id.",
    "4) Put your FULL reply between the tags — answer the user's question or complete their request as you normally would.",
    "5) Do not wrap tags in code fences.",
    "",
    "Tag format reference (replace <trace_id> with current trace id):",
    "- Open tag: [[MERIDIAN_SUMMARY_BEGIN id=<trace_id>]]",
    "- Close tag: [[MERIDIAN_SUMMARY_END id=<trace_id>]]"
  ].join("\n");
}

function appendSummaryProtocolPrompt(input: string, traceId: string): string {
  return `${input.trimEnd()}\n${buildSummaryProtocolPrompt(traceId)}`;
}

function appendExtractedAttachments(
  content: string,
  attachments: Array<{ filename: string; content?: string; result: AttachmentResult }>
): { prompt: string; attachmentResults: AttachmentResult[] } {
  if (attachments.length === 0) {
    return {
      prompt: content,
      attachmentResults: []
    };
  }

  let remainingBudget = ATTACHMENT_TOTAL_INLINE_CHAR_LIMIT;
  const promptSections: string[] = [];
  const attachmentResults: AttachmentResult[] = [];

  for (const attachment of attachments) {
    if (attachment.result.status === "rejected") {
      attachmentResults.push(attachment.result);
      continue;
    }

    const rawContent = typeof attachment.content === "string" ? attachment.content : "";
    const remainingForAttachment = Math.min(ATTACHMENT_INLINE_CHAR_LIMIT, Math.max(remainingBudget, 0));
    if (remainingForAttachment <= 0) {
      attachmentResults.push({
        filename: attachment.filename,
        status: "rejected",
        reason: "prompt_budget_exceeded"
      });
      continue;
    }

    const truncated = rawContent.length > remainingForAttachment;
    const inlinedContent = truncated ? rawContent.slice(0, remainingForAttachment) : rawContent;
    remainingBudget -= inlinedContent.length;

    const attachmentHeader = truncated
      ? `Attachment ${attachment.filename} (truncated by Meridian attachment transport):`
      : `Attachment ${attachment.filename}:`;
    promptSections.push(
      [attachmentHeader, `\`\`\`${attachment.filename}`, inlinedContent, "```"].join("\n")
    );
    attachmentResults.push(
      truncated
        ? {
            ...attachment.result,
            reason: attachment.result.reason ?? "truncated"
          }
        : attachment.result
    );
  }

  if (promptSections.length === 0) {
    return {
      prompt: content,
      attachmentResults
    };
  }

  return {
    prompt: `${content}\n\n${promptSections.join("\n\n")}`,
    attachmentResults
  };
}

function parseSummaryTagId(tagText: string): string | null {
  const matched = tagText.match(/\bid=([0-9a-fA-F-]{36})\b/);
  return matched?.[1]?.toLowerCase() ?? null;
}

function stripMeridianContentFraming(content: string): string {
  return content.replace(/^\[thread=[^\]]*\]\n?/, "");
}

function stripSummaryProtocolTags(content: string): string {
  return content
    .replace(/\[\[MERIDIAN_SUMMARY_BEGIN[^\]]*\]\]\s*/g, "")
    .replace(/\s*\[\[MERIDIAN_SUMMARY_END[^\]]*\]\]/g, "")
    .trim();
}

function extractSummaryBlocks(
  content: string,
  traceId: string
): { summary: string | null; residual: string; incomplete: boolean } {
  const beginIndex = content.indexOf(SUMMARY_MARKER_BEGIN);
  if (beginIndex < 0) {
    return { summary: null, residual: content, incomplete: false };
  }

  const beginClose = content.indexOf("]]", beginIndex);
  if (beginClose < 0) {
    return { summary: null, residual: content, incomplete: false };
  }

  const beginTag = content.slice(beginIndex, beginClose + 2);
  if (beginTag.includes("\n")) {
    return { summary: null, residual: content, incomplete: false };
  }
  const beginId = parseSummaryTagId(beginTag);
  if (!beginId || beginId !== traceId.toLowerCase()) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }

  const endIndex = content.indexOf(SUMMARY_MARKER_END, beginClose + 2);
  if (endIndex < 0) {
    const partial = content.slice(beginClose + 2).trim();
    const summary = partial ? `${partial}\n\n(summary incomplete)` : "summary incomplete";
    const residual = `${content.slice(0, beginIndex)}\n${partial}`.trim();
    return { summary, residual, incomplete: true };
  }

  const endClose = content.indexOf("]]", endIndex);
  if (endClose < 0) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }

  const endTag = content.slice(endIndex, endClose + 2);
  if (endTag.includes("\n")) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }
  const endId = parseSummaryTagId(endTag);
  if (!endId || endId !== beginId) {
    return { summary: null, residual: stripSummaryProtocolTags(content), incomplete: false };
  }

  const summary = content.slice(beginClose + 2, endIndex).trim();
  const residual = `${content.slice(0, beginIndex)}${content.slice(endClose + 2)}`.trim();
  return {
    summary: summary || null,
    residual,
    incomplete: false
  };
}

function extractLatestCompleteSummaryBlock(content: string, traceId: string): string | null {
  const normalizedTraceId = traceId.toLowerCase();
  let cursor = 0;
  let latest: string | null = null;

  while (cursor < content.length) {
    const beginIndex = content.indexOf(SUMMARY_MARKER_BEGIN, cursor);
    if (beginIndex < 0) {
      break;
    }
    const beginClose = content.indexOf("]]", beginIndex);
    if (beginClose < 0) {
      break;
    }

    const beginTag = content.slice(beginIndex, beginClose + 2);
    const beginId = parseSummaryTagId(beginTag);
    cursor = beginClose + 2;
    if (!beginId) {
      continue;
    }

    let searchFrom = beginClose + 2;
    while (searchFrom < content.length) {
      const endIndex = content.indexOf(SUMMARY_MARKER_END, searchFrom);
      if (endIndex < 0) {
        break;
      }
      const endClose = content.indexOf("]]", endIndex);
      if (endClose < 0) {
        break;
      }
      const endTag = content.slice(endIndex, endClose + 2);
      const endId = parseSummaryTagId(endTag);
      searchFrom = endClose + 2;
      if (!endId || endId !== beginId) {
        continue;
      }

      if (beginId === normalizedTraceId) {
        latest = content.slice(beginClose + 2, endIndex).trim();
      }
      cursor = endClose + 2;
      break;
    }
  }

  return latest;
}

export class HubRouter {
  private readonly log = createLogger("hub");
  private readonly clientFactory: (threadId: string) => AgentClient;
  private readonly instanceManager: InstanceManager;
  private readonly now: () => Date;
  private readonly outputBus: OutputBus;
  private readonly statePath: string;
  private readonly serviceRegistry: ServiceRegistry;
  private readonly monitorUpdateSubscriptionsByThread = new Map<string, Map<string, MonitorUpdateSubscription>>();
  private readonly pushSubscriptionsByThread = new Map<string, Map<string, PushSubscription>>();
  private readonly attachmentMetaBySession = new Map<string, SessionAttachmentMetadata>();
  private readonly activeRunsByThread = new Map<string, ActiveRunState>();
  private readonly completedRunsByThread = new Map<string, CompletedRunRecord>();
  private readonly conversationHistoryByThread = new Map<string, ConversationHistoryEntry[]>();
  private readonly pendingRunFollowups = new Set<string>();
  private callerRegistry: CallerRegistry | null = null;

  constructor(
    private readonly registry: InstanceRegistry,
    options: HubRouterOptions = {}
  ) {
    this.clientFactory =
      options.clientFactory ??
      ((threadId: string) => {
        return new AgentAPIClient({ threadId });
      });
    this.instanceManager = options.instanceManager ?? new InstanceManager(this.registry);
    this.now = options.now ?? (() => new Date());
    this.outputBus = options.outputBus ?? new OutputBus();
    this.statePath = options.statePath ?? config.MERIDIAN_STATE_PATH;
    this.serviceRegistry = options.serviceRegistry ?? new ServiceRegistry();
  }

  async initialize(): Promise<void> {
    const persistedState = loadPersistedHubState(this.statePath, this.now().toISOString());
    const result = await this.instanceManager.rehydrateFromState(persistedState);
    this.rehydrateLocalState(persistedState);
    this.callerRegistry = new CallerRegistry({
      initialRecords: persistedState.callers ?? [],
      persist: () => this.persistStateSafely(),
      now: this.now
    });
    this.persistStateSafely();
    this.log.info(
      {
        trace_id: null,
        thread_id: null,
        state_path: this.statePath,
        restored_threads: result.restored_thread_ids,
        pruned_threads: result.pruned_thread_ids
      },
      "Hub router state initialized"
    );
  }

  async route(rawMessage: HubMessage, auth?: WireAuth | null): Promise<HubResult> {
    const message = HubMessageSchema.parse(rawMessage);
    this.pruneAttachmentMetadata();
    const startedAt = Date.now();
    this.log.info(
      {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        actor_id: message.actor_id,
        span_id: message.span_id ?? null,
        parent_span_id: message.parent_span_id ?? null,
        intent: message.intent,
        target: message.target,
        dispatch_status: "ok"
      },
      "Routing HubMessage"
    );

    if (auth !== undefined) {
      const authOutcome = this.authenticateCaller(message, auth);
      if (!authOutcome.ok) {
        return authOutcome.errorResult;
      }
      const adminGate = this.checkAdminIntentGate(message);
      if (adminGate) {
        return adminGate;
      }
    }

    try {
      const result = await this.routeByIntent(message);
      this.persistStateSafely();
      const latencyMs = Date.now() - startedAt;
      this.log.info(
        {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          actor_id: message.actor_id,
          span_id: message.span_id ?? null,
          parent_span_id: message.parent_span_id ?? null,
          intent: message.intent,
          target: message.target,
          dispatch_status: "ok",
          result_status: result.status,
          status: result.status,
          latency_ms: latencyMs
        },
        "Hub routing complete"
      );
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const latencyMs = Date.now() - startedAt;
      this.log.error(
        {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          actor_id: message.actor_id,
          span_id: message.span_id ?? null,
          parent_span_id: message.parent_span_id ?? null,
          intent: message.intent,
          target: message.target,
          dispatch_status: "failed",
          result_status: "error",
          latency_ms: latencyMs,
          err: errorMessage
        },
        "Hub routing failed"
      );
      this.persistStateSafely();
      return this.buildResult(
        message,
        "error",
        this.resolveResultSource(message),
        `Routing failed: ${errorMessage}`
      );
    }
  }

  private async routeByIntent(message: HubMessage): Promise<HubResult> {
    if (this.isBuiltInIntent(message.intent)) {
      switch (message.intent) {
        case "run":
          return await this.handleRun(message);
        case "terminal_input":
          return this.handleTerminalInput(message);
        case "status":
          return await this.handleStatus(message);
        case "list":
          return await this.handleList(message);
        case "list_models":
          return await this.handleListModels(message);
        case "spawn":
          return await this.handleSpawn(message);
        case "restart":
          return await this.handleRestart(message);
        case "kill":
          return await this.handleKill(message);
        case "interrupt":
          return await this.handleInterrupt(message);
        case "attach":
          return this.handleAttach(message);
        case "detach":
          return this.handleDetach(message);
        case "reboot":
          return await this.handleReboot(message);
        case "gui":
          return this.handleGui(message);
        case "switch_model":
          return await this.handleSwitchModel(message);
        case "detail":
          return this.handleDetail(message);
        case "monitor_update":
          return this.handleMonitorUpdate(message);
        case "monitor_manual_update":
          return await this.handleManualMonitorUpdate(message);
        case "push":
          return this.handlePush(message);
        case "capture_interval":
          return this.handleCaptureInterval(message);
        case "history":
          return this.handleHistory(message);
        case "set_auto_approve":
          return this.handleSetAutoApprove(message);
        case "register_service":
          return this.handleRegisterService(message);
        case "unregister_service":
          return this.handleUnregisterService(message);
        case "register_caller":
          return this.handleRegisterCaller(message);
        case "unregister_caller":
          return this.handleUnregisterCaller(message);
        case "rotate_caller_key":
          return this.handleRotateCallerKey(message);
        case "list_callers":
          return this.handleListCallers(message);
        case "reply":
          return this.handleReply(message);
        default:
          return this.buildResult(message, "error", this.resolveResultSource(message), "Unsupported intent");
      }
    }

    const serviceEndpoint = this.serviceRegistry.resolve(message.intent);
    if (serviceEndpoint) {
      return await this.dispatchToService(serviceEndpoint, message);
    }

    return this.buildResult(message, "error", this.resolveResultSource(message), "Unsupported intent");
  }

  private async handleRun(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const client = this.clientFactory(instance.thread_id);
    let clientConnected = false;
    this.activeRunsByThread.set(instance.thread_id, { traceId: message.trace_id });
    this.recordUserConversationEntry(threadId, message.payload.content, message.trace_id, "user_send");
    this.persistStateSafely();

    try {
      if (instance.supportsStream) {
        const streamContent = await this.tryHandleStreamRun(message, threadId);
        if (streamContent !== null) {
          const content = this.formatRunContent(instance.thread_id, streamContent.content);
          const result = this.buildResult(message, "success", instance.agent_type, content, instance.thread_id, {
            attachmentResults: streamContent.attachmentResults
          });
          this.recordAgentConversationEntry(threadId, content, message.trace_id, message.payload.content);
          return result;
        }
      }

      await client.connect(instance.socket_path);
      clientConnected = true;
      const previousSnapshot = await this.getLatestAgentMessageSnapshot(client);
      const runContent = appendSummaryProtocolPrompt(message.payload.content, message.trace_id);
      const response = await client.sendMessage(runContent, message.payload.attachments, instance.agent_type);
      const responseAttachmentResults = this.extractAttachmentResults(response);
      this.registry.setStatus(instance.thread_id, "running");
      const runLogContext = { trace_id: message.trace_id, thread_id: instance.thread_id };
      const agentReply = await this.waitForAgentReply(client, previousSnapshot, message.trace_id, runLogContext);
      if (agentReply === null) {
        this.log.warn(
          runLogContext,
          "Run using fallback content: waitForAgentReply returned null; response body or getLatestAgentMessageSnapshot used as result content"
        );
      }
      if (agentReply?.kind === "final") {
        const content = this.formatRunContent(instance.thread_id, agentReply.content);
        const attachments = this.extractResultAttachments(response);
        const result = this.buildResult(
          message,
          "success",
          instance.agent_type,
          content,
          instance.thread_id,
          {
            attachments,
            attachmentResults: responseAttachmentResults,
            runState: "completed"
          }
        );
        this.recordAgentConversationEntry(threadId, content, message.trace_id, message.payload.content);
        return result;
      }

      if (agentReply?.kind === "non_final") {
        return this.buildPendingRunResult(
          message,
          instance.agent_type,
          instance.thread_id,
          agentReply.runState,
          agentReply.content,
          responseAttachmentResults
        );
      }

      const fallbackContent = await this.resolveFallbackRunContent(client, response, previousSnapshot);
      const fallbackClassification = classifyAgentOutput(fallbackContent);
      if (fallbackContent === "Agent is processing..." || fallbackClassification.kind === "action_required") {
        const runState: Exclude<HubRunState, "completed"> =
          fallbackClassification.kind === "action_required"
            ? "still_running"
            : (await this.getClientRunActivity(client)) === "active"
              ? "still_running"
              : "timeout";
        return this.buildPendingRunResult(
          message,
          instance.agent_type,
          instance.thread_id,
          runState,
          fallbackContent === "Agent is processing..." ? null : fallbackContent,
          responseAttachmentResults
        );
      }

      const content = this.formatRunContent(instance.thread_id, fallbackContent);
      const attachments = this.extractResultAttachments(response);
      const result = this.buildResult(
        message,
        "success",
        instance.agent_type,
        content,
        instance.thread_id,
        {
          attachments,
          attachmentResults: responseAttachmentResults,
          runState: "completed"
        }
      );
      this.recordAgentConversationEntry(threadId, content, message.trace_id, message.payload.content);
      return result;
    } catch (error) {
      if (error instanceof RunInterruptedError) {
        return this.buildResult(
          message,
          "success",
          instance.agent_type,
          "Agent run interrupted.",
          instance.thread_id,
          { runState: "completed" }
        );
      }
      throw error;
    } finally {
      const activeRun = this.activeRunsByThread.get(instance.thread_id);
      if (activeRun?.traceId === message.trace_id) {
        this.activeRunsByThread.delete(instance.thread_id);
        this.completedRunsByThread.set(instance.thread_id, {
          traceId: message.trace_id,
          completedAtMs: Date.now()
        });
      }
      client.disconnect();
    }
  }

  private async tryHandleStreamRun(message: HubMessage, threadId: string): Promise<StreamRunResult | null> {
    const maxAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runStreamAttempt(message, threadId);
      } catch (error) {
        lastError = error;
        if (error instanceof RunInterruptedError) {
          throw error;
        }
        const summary = error instanceof Error ? error.message : String(error);
        this.log.warn(
          {
            trace_id: message.trace_id,
            thread_id: threadId,
            attempt,
            max_attempts: maxAttempts,
            err: summary
          },
          "Direct stream run attempt failed"
        );
      }
    }

    if (this.resolveInstance(threadId).mode === "stateless_call") {
      throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "stateless stream run failed"));
    }

    this.registry.setSupportsStream(threadId, false);
    this.log.warn(
      {
        trace_id: message.trace_id,
        thread_id: threadId,
        attempts: maxAttempts
      },
      "Disabled direct streaming after repeated failures; falling back to agentapi bridge"
    );
    return null;
  }

  private async runStreamAttempt(message: HubMessage, threadId: string): Promise<StreamRunResult> {
    const instance = this.resolveInstance(threadId);
    const transformedAttachments = await transformAttachments(message.payload.attachments ?? [], instance.agent_type);
    const textAttachments = transformedAttachments.transformed.filter(
      (attachment): attachment is Extract<(typeof transformedAttachments.transformed)[number], { kind: "text" }> =>
        attachment.kind === "text"
    );
    const imageAttachments = transformedAttachments.transformed.filter(
      (attachment): attachment is Extract<(typeof transformedAttachments.transformed)[number], { kind: "image" }> =>
        attachment.kind === "image"
    );
    const promptWithAttachments = appendExtractedAttachments(message.payload.content, textAttachments);
    const imagePaths = imageAttachments
      .map((attachment) => attachment.path)
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    const attachmentResults = [
      ...promptWithAttachments.attachmentResults,
      ...imageAttachments.map((attachment) => attachment.result),
      ...transformedAttachments.rejected.map((attachment) => attachment.result)
    ];
    const args = this.buildStreamArgs(instance, imagePaths);
    const prompt = promptWithAttachments.prompt;
    const parser = this.createStreamParser(instance);
    let process: ChildProcess | null = null;
    let finalDelta: OutputDelta | null = null;
    let streamedText = "";
    let explicitResultText: string | null = null;

    this.registry.setStatus(threadId, "running");

    try {
      const spawnedAgent = this.instanceManager.spawnStreamAgent(
        threadId,
        instance.agent_type,
        args,
        prompt,
        message.trace_id
      );
      process = spawnedAgent.process;
      const activeRun = this.activeRunsByThread.get(threadId);
      if (activeRun?.traceId === message.trace_id) {
        activeRun.streamProcess = process;
      }
      const stderrSummary = this.captureProcessStderr(spawnedAgent.process);

      for await (const delta of streamFromSpawn(spawnedAgent.stdout, parser)) {
        this.outputBus.pushDelta(message.trace_id, delta);

        if (typeof delta.text === "string") {
          if (delta.phase === "working") {
            streamedText += delta.text;
          } else if (delta.phase === "result") {
            explicitResultText = delta.text;
          }
        }

        if (delta.final) {
          finalDelta = delta;
        }
      }

      const { exitCode, signal } = await this.awaitChildExit(process);
      if (this.isRunInterrupted(threadId, message.trace_id)) {
        throw new RunInterruptedError(threadId);
      }
      if (finalDelta && this.isRecoverableStreamError(finalDelta)) {
        throw new Error(finalDelta.text ?? "Stream transport error");
      }
      if (!finalDelta) {
        throw new Error(this.describeStreamExit(exitCode, signal, stderrSummary()));
      }
      if (exitCode !== 0 && finalDelta.phase !== "error") {
        throw new Error(this.describeStreamExit(exitCode, signal, stderrSummary()));
      }

      if (finalDelta.phase === "error") {
        return {
          content: finalDelta.text ?? explicitResultText ?? (streamedText || "Task failed."),
          attachmentResults
        };
      }

      return {
        content: explicitResultText ?? (streamedText || "Task completed."),
        attachmentResults
      };
    } catch (error) {
      if (this.isRunInterrupted(threadId, message.trace_id)) {
        throw new RunInterruptedError(threadId);
      }
      throw error;
    } finally {
      if (process && process.exitCode === null && process.signalCode === null) {
        process.kill();
      }
      if (instance.mode === "stateless_call" && this.registry.get(threadId)?.status === "running") {
        this.registry.setStatus(threadId, "idle");
      }
      await cleanupStagedAttachments(transformedAttachments.cleanupPaths);
    }
  }

  private buildStreamArgs(instance: AgentInstance, imagePaths: string[] = []): string[] {
    if (instance.agent_type === "claude") {
      return [
        ...buildClaudeStreamArgs(instance.model_id, instance.auto_approve),
        ...imagePaths.flatMap((imagePath) => ["--image", imagePath])
      ];
    }
    if (instance.agent_type === "gemini") {
      return buildGeminiStreamArgs(instance.model_id);
    }
    if (instance.agent_type === "codex") {
      return instance.mode !== "stateless_call" && instance.codexSessionId
        ? buildCodexResumeArgs(
            instance.codexSessionId,
            instance.model_id,
            instance.auto_approve,
            instance.reasoning_effort,
            instance.sandbox_mode
          )
        : buildCodexExecArgs(
            instance.model_id,
            instance.auto_approve,
            instance.reasoning_effort,
            instance.sandbox_mode
          );
    }

    throw new Error(`Direct streaming is not supported for agent_type=${instance.agent_type}`);
  }

  private createStreamParser(instance: AgentInstance): (event: unknown) => OutputDelta | null {
    if (instance.agent_type === "claude") {
      return createClaudeStreamParser();
    }
    if (instance.agent_type === "gemini") {
      return createGeminiStreamParser();
    }
    if (instance.agent_type === "codex") {
      const parser = createCodexStreamParser();
      return (event: unknown) => {
        const codexThreadId = extractThreadId(event);
        if (codexThreadId && instance.mode !== "stateless_call") {
          this.registry.setCodexSessionId(instance.thread_id, codexThreadId);
        }
        return parser(event);
      };
    }

    return () => null;
  }

  private buildStreamPrompt(content: string, attachments: HubMessage["payload"]["attachments"] = []): string {
    if (attachments.length === 0) {
      return content;
    }

    const omitted = attachments
      .map((item) => item.filename || item.path)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (omitted.length === 0) {
      return content;
    }

    return `${content}\n\n[attachments omitted by transport: ${omitted.join(", ")}]`;
  }

  private captureProcessStderr(process: ChildProcess): () => string {
    const chunks: string[] = [];
    process.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) {
        return;
      }
      chunks.push(text);
      if (chunks.length > 8) {
        chunks.shift();
      }
    });

    return () => chunks.join("").trim();
  }

  private async awaitChildExit(process: ChildProcess): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    if (process.exitCode !== null || process.signalCode !== null) {
      return {
        exitCode: process.exitCode,
        signal: process.signalCode
      };
    }

    return await new Promise((resolve) => {
      process.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        resolve({ exitCode, signal });
      });
    });
  }

  private isRecoverableStreamError(delta: OutputDelta): boolean {
    if (delta.phase !== "error") {
      return false;
    }

    if (!delta.data || typeof delta.data !== "object") {
      return false;
    }

    const record = delta.data as Record<string, unknown>;
    return record.type === "stream_error" && record.recoverable === true;
  }

  private describeStreamExit(exitCode: number | null, signal: NodeJS.Signals | null, stderr: string): string {
    const status =
      exitCode !== null
        ? `exit_code=${exitCode}`
        : signal
          ? `signal=${signal}`
          : "stream ended without a final delta";

    return stderr ? `Direct stream process failed (${status}): ${stderr}` : `Direct stream process failed (${status})`;
  }

  private handleTerminalInput(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const blockedResult = this.blockAdsPublicAction(message, instance);
    if (blockedResult) {
      return blockedResult;
    }
    const content = this.instanceManager.sendTerminalInput(threadId, message.payload.content);
    if (message.payload.content?.trim()) {
      this.recordUserConversationEntry(threadId, message.payload.content.trim(), message.trace_id, "terminal_input");
      this.resolveApprovalConversationEntry(threadId);
      this.persistStateSafely();
    }
    return this.buildResult(message, "success", instance.agent_type, content, threadId);
  }

  private async handleStatus(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const status = await this.instanceManager.status(threadId);
    this.persistStateSafely();
    const content = this.appendAttachmentSummary(JSON.stringify(status, null, 2), status.instance.thread_id);
    return this.buildResult(
      message,
      "success",
      status.instance.agent_type,
      content,
      status.instance.thread_id
    );
  }

  private async handleList(message: HubMessage): Promise<HubResult> {
    const requestSessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const instances = this.instanceManager
      .list()
      .filter((instance) => LIVE_INSTANCE_STATUSES.has(instance.status));
    const listedInstances = await Promise.all(instances.map(async (instance) => {
      let currentInstance = instance;
      if (typeof this.instanceManager.status === "function") {
        try {
          currentInstance = (await this.instanceManager.status(currentInstance.thread_id)).instance;
          this.persistStateSafely();
        } catch (error) {
          this.log.debug(
            {
              operation: "list_status_probe_failed",
              thread_id: currentInstance.thread_id,
              socket_path: currentInstance.socket_path,
              pid: currentInstance.pid,
              err: error instanceof Error ? error.message : String(error)
            },
            "Continuing list response without a live instance status refresh"
          );
        }
      }

      const attachment = this.instanceManager.getThreadAttachment(currentInstance.thread_id);
      const attachable = this.instanceManager.isThreadAttachableBySession(currentInstance.thread_id, requestSessionId);
      const attachedLabels = attachment.sessions.map((session) => this.describeAttachedSession(session));
      const history = this.readConversationHistory(currentInstance.thread_id);
      const lastEntry = history[history.length - 1] ?? null;
      let lastTraceId: string | null = null;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const candidate = history[index]?.trace_id;
        if (typeof candidate === "string" && candidate.trim()) {
          lastTraceId = candidate.trim();
          break;
        }
      }
      return {
        ...currentInstance,
        current_model_id: currentInstance.model_id ?? null,
        attached: attachment.sessions.length > 0,
        attached_sessions: attachment.sessions,
        attached_labels: attachedLabels,
        attached_interface: attachment.interface_id,
        attachable,
        last_trace_id: lastTraceId,
        last_interaction_at: lastEntry?.timestamp ?? null
      };
    }));
    const content = listedInstances.length === 0 ? "No active agent instances." : JSON.stringify(listedInstances, null, 2);
    return this.buildResult(message, "success", this.resolveResultSource(message), content);
  }

  private async handleListModels(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const catalog = await this.instanceManager.listModels(threadId);
    return this.buildResult(message, "success", instance.agent_type, JSON.stringify(catalog, null, 2), threadId);
  }

  private async handleSpawn(message: HubMessage): Promise<HubResult> {
    const type = AgentTypeSchema.parse(message.target);
    const spawnDir = message.payload.spawn_dir?.trim() || undefined;
    const modelId = message.payload.model_id?.trim() || undefined;
    const reasoningEffort = message.payload.effort;
    const integrationProfile = message.payload.integration_profile;
    const sandboxMode = message.payload.sandbox_mode;
    const threadId = await this.instanceManager.spawn(
      type,
      message.mode,
      spawnDir,
      modelId,
      message.payload.auto_approve,
      reasoningEffort,
      message.trace_id,
      integrationProfile,
      sandboxMode
    );
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    this.instanceManager.attach(threadId, sessionId);
    this.rememberAttachmentMetadata(sessionId, message);
    const spawned = this.registry.get(threadId);
    const baseContent =
      spawned === undefined
        ? `Spawned ${type} instance: ${threadId}`
        : JSON.stringify({ thread_id: threadId, instance: spawned }, null, 2);
    return this.buildResult(message, "success", type, this.appendAttachmentSummary(baseContent, threadId), threadId, {
      telegramInlineKeyboard: tryBuildGuiInlineKeyboard(threadId, message.payload.gui_host_port_override)
    });
  }

  private async handleKill(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const attachment = this.instanceManager.getThreadAttachment(threadId);
    const attachmentSummary = this.buildAttachmentSummary(attachment.sessions);
    await this.instanceManager.kill(threadId);
    for (const session of attachment.sessions) {
      this.forgetAttachmentMetadata(session);
    }
    const content = attachmentSummary
      ? `Agent instance ${threadId} killed\n\n${attachmentSummary}`
      : `Agent instance ${threadId} killed`;
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      content,
      threadId
    );
  }

  private async handleInterrupt(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const activeRun = this.activeRunsByThread.get(threadId);

    if (activeRun) {
      activeRun.interrupted = true;
      const streamProcess = activeRun.streamProcess;
      if (streamProcess && streamProcess.exitCode === null && streamProcess.signalCode === null) {
        streamProcess.kill("SIGINT");
      } else {
        await this.instanceManager.interrupt(threadId);
      }
    } else {
      await this.instanceManager.interrupt(threadId);
    }

    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      `Agent instance ${threadId} interrupted`,
      threadId
    );
  }

  private async handleRestart(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const restartedThreadId = await this.instanceManager.restart(threadId);
    const restarted = this.registry.get(restartedThreadId);
    const content =
      restarted === undefined
        ? `Restarted ${threadId}`
        : JSON.stringify({ thread_id: restartedThreadId, instance: restarted }, null, 2);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      this.appendAttachmentSummary(content, restartedThreadId),
      restartedThreadId
    );
  }

  private handleAttach(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const binding = this.instanceManager.attach(threadId, sessionId);
    this.rememberAttachmentMetadata(sessionId, message);
    const content = this.appendAttachmentSummary(JSON.stringify(binding, null, 2), threadId);
    return this.buildResult(message, "success", instance.agent_type, content, threadId, {
      telegramInlineKeyboard: tryBuildGuiInlineKeyboard(threadId, message.payload.gui_host_port_override)
    });
  }

  private handleDetach(message: HubMessage): HubResult {
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const expectedThreadId = this.extractConcreteThreadId(message.target) ?? this.extractConcreteThreadId(message.thread_id);
    const attachedThreadId = this.instanceManager.getAttachedThread(sessionId);

    if (!attachedThreadId) {
      throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
    }
    if (expectedThreadId && attachedThreadId !== expectedThreadId) {
      throw new Error(`Session is attached to ${attachedThreadId}, not ${expectedThreadId}`);
    }

    const detachedThreadId = this.instanceManager.detach(sessionId);
    if (!detachedThreadId) {
      throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
    }
    this.forgetAttachmentMetadata(sessionId);

    const source = this.registry.get(detachedThreadId)?.agent_type ?? this.resolveResultSource(message);
    return this.buildResult(
      message,
      "success",
      source,
      `Detached session from ${detachedThreadId}`,
      detachedThreadId
    );
  }

  private async handleReboot(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const rebootedThreadId = await this.instanceManager.restart(threadId);
    const rebooted = this.registry.get(rebootedThreadId);
    const content =
      rebooted === undefined
        ? `Rebooted ${threadId}`
        : JSON.stringify({ thread_id: rebootedThreadId, instance: rebooted }, null, 2);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      this.appendAttachmentSummary(content, rebootedThreadId),
      rebootedThreadId
    );
  }

  private handleGui(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const content = this.appendAttachmentSummary(
      buildWebGuiUrl(threadId, message.payload.gui_host_port_override),
      threadId
    );
    return this.buildResult(message, "success", instance.agent_type, content, threadId);
  }

  private async handleSwitchModel(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadIdFromThread(message);
    const instance = this.resolveInstance(threadId);
    const modelId = message.payload.content.trim();
    if (!modelId) {
      throw new Error("switch_model requires a provider model id");
    }
    const switchedThreadId = await this.instanceManager.switchModel(threadId, modelId);
    const switched = this.registry.get(switchedThreadId);
    const content =
      switched === undefined
        ? `Switched ${threadId} to model=${modelId}`
        : JSON.stringify({ thread_id: switchedThreadId, instance: switched }, null, 2);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      this.appendAttachmentSummary(content, switchedThreadId),
      switchedThreadId
    );
  }

  private handleDetail(message: HubMessage): HubResult {
    const requestedTrace = message.payload.content.trim() || undefined;
    const requestedThread =
      this.extractConcreteThreadId(message.target) ??
      this.extractConcreteThreadId(message.thread_id) ??
      this.instanceManager.getAttachedThread(encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id)) ??
      undefined;
    const historyDetail = this.resolveConversationDetailRecord(requestedTrace, requestedThread);
    if (historyDetail) {
      const title = `Detail for trace=${historyDetail.traceId} thread=${historyDetail.threadId}`;
      return this.buildResult(
        message,
        "success",
        historyDetail.source,
        `${title}\n\n${historyDetail.fullText}`,
        historyDetail.threadId
      );
    }

    const detail = resolveTelegramDetailRecord({
      chatId: message.reply_channel.chat_id,
      botId: message.reply_channel.bot_id,
      traceId: requestedTrace,
      threadId: requestedThread
    });

    if (!detail) {
      return this.buildResult(
        message,
        "success",
        this.resolveResultSource(message),
        "No cached detail found. Send a new request first, then run /detail again."
      );
    }

    const title = `Detail for trace=${detail.traceId} thread=${detail.threadId}`;
    return this.buildResult(
      message,
      "success",
      detail.source,
      `${title}\n\n${detail.fullText}`,
      detail.threadId
    );
  }

  private handleReply(message: HubMessage): HubResult {
    return this.buildResult(
      message,
      "success",
      this.resolveResultSource(message),
      message.payload.content
    );
  }

  private handleMonitorUpdate(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const chatId = message.reply_channel.chat_id;
    const botId = message.reply_channel.bot_id;
    const sessionId = encodeSessionId(chatId, botId);
    const requestedIntervalSec = message.payload.monitor_updates_interval_sec;
    const requestedEnabled = message.payload.monitor_updates_enabled;
    const inferredEnabled = requestedEnabled ?? (requestedIntervalSec !== undefined ? true : undefined);
    const existing = this.monitorUpdateSubscriptionsByThread.get(threadId)?.get(sessionId) ?? null;

    if (inferredEnabled === undefined) {
      if (!existing) {
        return this.buildResult(
          message,
          "success",
          instance.agent_type,
          `Monitor updates are OFF for thread=${threadId} chat=${chatId}.`,
          threadId
        );
      }
      return this.buildResult(
        message,
        "success",
        instance.agent_type,
        `Monitor updates are ON for thread=${threadId} chat=${chatId} interval=${Math.floor(existing.intervalMs / 1000)}s.`,
        threadId
      );
    }

    if (!inferredEnabled) {
      this.deleteMonitorUpdateSubscription(threadId, sessionId);
      return this.buildResult(
        message,
        "success",
        instance.agent_type,
        `Monitor updates turned OFF for thread=${threadId} chat=${chatId}.`,
        threadId
      );
    }

    const existingIntervalSec = existing ? Math.floor(existing.intervalMs / 1000) : undefined;
    const normalizedIntervalSec = this.normalizeMonitorUpdateIntervalSec(
      requestedIntervalSec ?? existingIntervalSec
    );
    this.upsertMonitorUpdateSubscription(threadId, sessionId, chatId, botId, normalizedIntervalSec, message.reply_channel);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      `Monitor updates turned ON for thread=${threadId} chat=${chatId} interval=${normalizedIntervalSec}s.`,
      threadId
    );
  }

  private async handleManualMonitorUpdate(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    return await this.buildProgressResultForThread(threadId, message.trace_id);
  }

  private pruneAttachmentMetadata(): void {
    const activeSessions = new Set<string>();
    for (const instance of this.registry.list()) {
      const attachment = this.instanceManager.getThreadAttachment(instance.thread_id);
      for (const session of attachment.sessions) {
        activeSessions.add(session);
      }
    }

    for (const session of this.attachmentMetaBySession.keys()) {
      if (!activeSessions.has(session)) {
        this.attachmentMetaBySession.delete(session);
      }
    }
  }

  private rememberAttachmentMetadata(sessionId: string, message: HubMessage): void {
    this.attachmentMetaBySession.set(sessionId, {
      channel: message.reply_channel.channel,
      chatId: message.reply_channel.chat_id,
      botId: message.reply_channel.bot_id ?? null,
      chatName: message.reply_channel.chat_name?.trim() || null,
      botName: message.reply_channel.bot_name?.trim() || null
    });
  }

  private forgetAttachmentMetadata(sessionId: string): void {
    this.attachmentMetaBySession.delete(sessionId);
  }

  private appendAttachmentSummary(content: string, threadId: string): string {
    const attachment = this.instanceManager.getThreadAttachment(threadId);
    const summary = this.buildAttachmentSummary(attachment.sessions);
    if (!summary) {
      return content;
    }
    return `${content}\n\n${summary}`;
  }

  private buildAttachmentSummary(sessions: string[]): string | null {
    if (sessions.length === 0) {
      return null;
    }
    const lines = ["Attached chat sessions:"];
    for (const session of sessions) {
      lines.push(`- ${this.describeAttachedSession(session)}`);
    }
    return lines.join("\n");
  }

  private describeAttachedSession(session: string): string {
    const metadata = this.attachmentMetaBySession.get(session);
    const parsed = this.parseSession(session);
    const chatLabel = metadata?.chatName ?? parsed.chatId;
    const botLabel = this.resolveBotLabel(metadata?.botName, metadata?.botId ?? parsed.botId);
    if (botLabel) {
      return `${chatLabel} via ${botLabel}`;
    }
    return chatLabel;
  }

  private parseSession(session: string): { botId: string | null; chatId: string } {
    const separatorIndex = session.indexOf(":");
    if (separatorIndex <= 0) {
      return { botId: null, chatId: session };
    }

    const maybeBotId = session.slice(0, separatorIndex);
    const rest = session.slice(separatorIndex + 1);
    if (/^\d+$/.test(maybeBotId)) {
      return { botId: maybeBotId, chatId: rest };
    }
    return { botId: null, chatId: session };
  }

  resolveReplyChannelForSession(session: string): ReplyChannel {
    const metadata = this.attachmentMetaBySession.get(session);
    if (metadata) {
      const rc: ReplyChannel = {
        channel: metadata.channel as ReplyChannel["channel"],
        chat_id: metadata.chatId,
        bot_id: metadata.botId ?? undefined,
        chat_name: metadata.chatName ?? undefined,
        bot_name: metadata.botName ?? undefined
      };
      return rc;
    }
    const parsed = this.parseSession(session);
    return {
      channel: "telegram",
      chat_id: parsed.chatId,
      bot_id: parsed.botId ?? undefined
    };
  }

  private resolveBotLabel(botName: string | null | undefined, botId: string | null): string | null {
    const normalizedBotName = botName?.trim() ?? "";
    if (normalizedBotName) {
      return normalizedBotName.startsWith("@") ? normalizedBotName : `@${normalizedBotName}`;
    }
    if (botId) {
      return `bot#${botId}`;
    }
    return null;
  }

  private resolveInstance(threadId: string): AgentInstance {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`No registered agent instance found for thread_id=${threadId}`);
    }
    return instance;
  }

  private resolveThreadId(message: HubMessage): string {
    const explicitThread = this.extractConcreteThreadId(message.target) ?? this.extractConcreteThreadId(message.thread_id);
    if (explicitThread) {
      return explicitThread;
    }

    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const attachedThread = this.instanceManager.getAttachedThread(sessionId);
    if (attachedThread) {
      return attachedThread;
    }

    throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
  }

  private resolveThreadIdFromThread(message: HubMessage): string {
    const explicitThread = this.extractConcreteThreadId(message.thread_id);
    if (explicitThread) {
      return explicitThread;
    }

    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const attachedThread = this.instanceManager.getAttachedThread(sessionId);
    if (attachedThread) {
      return attachedThread;
    }

    throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
  }

  private extractConcreteThreadId(candidate: string): string | null {
    const normalized = candidate.trim();
    if (!normalized) {
      return null;
    }

    if (normalized === "active" || normalized === "all" || normalized === "global" || normalized === "pending" || normalized === "unbound") {
      return null;
    }

    return normalized;
  }

  private resolveResultSource(message: HubMessage): AgentType {
    const threadId = this.extractConcreteThreadId(message.thread_id);
    if (threadId && this.registry.has(threadId)) {
      const threadInstance = this.registry.get(threadId);
      if (threadInstance) {
        return threadInstance.agent_type;
      }
    }

    const targetThread = this.extractConcreteThreadId(message.target);
    if (targetThread && this.registry.has(targetThread)) {
      const targetInstance = this.registry.get(targetThread);
      if (targetInstance) {
        return targetInstance.agent_type;
      }
    }

    return resolveSourceFromTarget(message.target);
  }

  resolveSourceForThread(threadId: string): AgentType {
    return this.registry.get(threadId)?.agent_type ?? "codex";
  }

  resolveInstanceForThread(threadId: string): AgentInstance | null {
    return this.registry.get(threadId) ?? null;
  }

  registerServiceEndpoint(endpoint: ServiceEndpoint): ServiceEndpoint {
    return this.serviceRegistry.register(endpoint);
  }

  unregisterServiceEndpoint(serviceId: string): boolean {
    return this.serviceRegistry.unregister(serviceId);
  }

  listServiceEndpoints(): ServiceEndpoint[] {
    return this.serviceRegistry.list();
  }

  async buildCompletionResultForThread(threadId: string, traceId: string | null): Promise<HubResult> {
    const instance = this.resolveInstance(threadId);
    const client = this.clientFactory(instance.thread_id);
    await client.connect(instance.socket_path);

    try {
      const content = await this.resolveCompletionContent(client, threadId);
      return HubResultSchema.parse({
        trace_id: traceId ?? randomUUID(),
        thread_id: threadId,
        source: instance.agent_type,
        status: "success",
        content,
        attachments: [],
        telegram_inline_keyboard: tryBuildGuiInlineKeyboard(threadId),
        timestamp: this.now().toISOString()
      });
    } finally {
      client.disconnect();
    }
  }

  async buildProgressResultForThread(threadId: string, traceId: string | null): Promise<HubResult> {
    const snapshot = await this.buildProgressSnapshotForThread(threadId, traceId);
    return HubResultSchema.parse({
      trace_id: snapshot.trace_id,
      thread_id: threadId,
      source: snapshot.source,
      status: "partial",
      content: snapshot.content,
      progress: snapshot,
      attachments: [],
      timestamp: snapshot.updated_at
    });
  }

  getOutputBus(): OutputBus {
    return this.outputBus;
  }

  setInstanceStatus(threadId: string, status: string): void {
    const normalizedStatus = this.normalizeMonitorStatus(status);
    if (!normalizedStatus) {
      return;
    }
    const parsed = AgentInstanceStatusSchema.safeParse(normalizedStatus);
    if (!parsed.success) {
      return;
    }
    this.registry.setStatus(threadId, parsed.data);
    this.persistStateSafely();
  }

  getAttachedSessionsForThread(threadId: string): string[] {
    return this.instanceManager.getSessionsForThread(threadId);
  }

  getMonitorUpdateSubscribersForThread(threadId: string): string[] {
    const subscriptions = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!subscriptions) {
      return [];
    }
    return [...subscriptions.keys()];
  }

  collectDueMonitorUpdateDispatches(nowMs = Date.now()): MonitorUpdateDispatch[] {
    const due: MonitorUpdateDispatch[] = [];
    for (const [threadId, subscriptions] of this.monitorUpdateSubscriptionsByThread.entries()) {
      const status = this.registry.get(threadId)?.status;
      if (status !== "running") {
        continue;
      }

      for (const subscription of subscriptions.values()) {
        if (subscription.nextDispatchAtMs > nowMs) {
          continue;
        }
        subscription.nextDispatchAtMs = nowMs + subscription.intervalMs;
        due.push({
          threadId,
          chatId: subscription.chatId,
          botId: subscription.botId,
          replyChannel: subscription.replyChannel
        });
      }
    }
    return due;
  }

  forceMonitorUpdateDispatchNow(threadId: string, nowMs = Date.now()): void {
    const subscriptions = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!subscriptions) {
      return;
    }
    for (const subscription of subscriptions.values()) {
      subscription.nextDispatchAtMs = nowMs;
    }
  }

  isThreadRunning(threadId: string): boolean {
    return this.registry.get(threadId)?.status === "running";
  }

  isRunActiveForThread(threadId: string): boolean {
    return this.activeRunsByThread.has(threadId);
  }

  private isRunInterrupted(threadId: string, traceId: string): boolean {
    const activeRun = this.activeRunsByThread.get(threadId);
    return activeRun?.traceId === traceId && activeRun.interrupted === true;
  }

  getRegistryInstance(threadId: string): { auto_approve?: boolean } | undefined {
    return this.registry.get(threadId);
  }

  private blockAdsPublicAction(message: HubMessage, instance: AgentInstance): HubResult | null {
    if (instance.integration_profile !== "ads_public") {
      return null;
    }
    return this.buildResult(
      message,
      "error",
      instance.agent_type,
      "action blocked for ADS public sessions",
      instance.thread_id
    );
  }

  sendAutoApproveTerminalInput(threadId: string): void {
    try {
      this.instanceManager.sendTerminalInput(threadId, "all");
    } catch (error) {
      this.log.error(
        {
          trace_id: null,
          thread_id: threadId,
          err: error instanceof Error ? error.message : String(error)
        },
        "Failed to send auto-approve terminal input"
      );
    }
  }

  getPaneCaptureIntervalMs(): number {
    return this.instanceManager.getPaneCaptureIntervalMs();
  }

  setPaneCaptureIntervalMs(intervalMs: number): void {
    this.instanceManager.setPaneCaptureIntervalMs(intervalMs);
  }

  getActiveRunTraceId(threadId: string): string | null {
    return this.activeRunsByThread.get(threadId)?.traceId ?? null;
  }

  /**
   * Returns true if a run completed for this thread within the last `cooldownMs`.
   * Used to suppress duplicate push/monitor deliveries that race with the run result.
   */
  isWithinRunCompletionCooldown(threadId: string, cooldownMs: number, nowMs = Date.now()): boolean {
    const record = this.completedRunsByThread.get(threadId);
    if (!record) {
      return false;
    }
    return nowMs - record.completedAtMs < cooldownMs;
  }

  private isBuiltInIntent(intent: string): boolean {
    return BUILT_IN_INTENT_SET.has(intent);
  }

  ensureBuiltinCallers(
    builtins: ReadonlyArray<{ caller_id: string; caller_label: string }>,
    deriveKey: (callerId: string) => string
  ): void {
    const registry = this.requireCallerRegistry();
    for (const entry of builtins) {
      registry.ensureBuiltin({
        caller_id: entry.caller_id,
        caller_label: entry.caller_label,
        deriveKey: () => deriveKey(entry.caller_id)
      });
    }
  }

  getCallerRegistry(): CallerRegistry | null {
    return this.callerRegistry;
  }

  private requireCallerRegistry(): CallerRegistry {
    if (!this.callerRegistry) {
      // Tests may exercise router methods without first calling initialize();
      // bootstrap an in-memory registry so the admin handlers and middleware
      // have somewhere to write. Real production goes through initialize().
      this.callerRegistry = new CallerRegistry({
        initialRecords: [],
        persist: () => this.persistStateSafely(),
        now: this.now
      });
    }
    return this.callerRegistry;
  }

  private authenticateCaller(
    message: HubMessage,
    auth: WireAuth | null
  ):
    | { ok: true; record: CallerRecord }
    | { ok: false; errorResult: HubResult } {
    if (!auth || !auth.caller_id || !auth.caller_key) {
      return { ok: false, errorResult: this.buildAuthErrorResult(message, "caller_required") };
    }
    const registry = this.requireCallerRegistry();
    const record = registry.verify(auth.caller_id, auth.caller_key);
    if (record) {
      registry.touchLastSeen(record.caller_id);
      const injected: CallerIdentity = {
        caller_id: record.caller_id,
        caller_label: record.caller_label,
        ...(message.caller?.caller_version ? { caller_version: message.caller.caller_version } : {})
      };
      // Registry is authoritative for caller_label; overwrite any client-supplied value.
      (message as { caller?: CallerIdentity }).caller = CallerIdentitySchema.parse(injected);
      return { ok: true, record };
    }
    const existing = registry.get(auth.caller_id);
    if (!existing || existing.revoked_at !== null) {
      return { ok: false, errorResult: this.buildAuthErrorResult(message, "caller_unknown") };
    }
    return { ok: false, errorResult: this.buildAuthErrorResult(message, "caller_invalid") };
  }

  private checkAdminIntentGate(message: HubMessage): HubResult | null {
    if (!ADMIN_ONLY_INTENTS.has(message.intent)) {
      return null;
    }
    if (message.caller?.caller_id === ADMIN_CALLER_ID) {
      return null;
    }
    return this.buildAuthErrorResult(message, "caller_not_authorized_for_intent");
  }

  private buildAuthErrorResult(message: HubMessage, content: string): HubResult {
    return this.buildResult(
      message,
      "error",
      this.resolveResultSource(message),
      content,
      message.thread_id
    );
  }

  private parseAdminPayload<T>(
    message: HubMessage,
    schema: z.ZodType<T>
  ): { ok: true; data: T } | { ok: false; errorResult: HubResult } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.payload.content);
    } catch {
      return {
        ok: false,
        errorResult: this.buildResult(
          message,
          "error",
          this.resolveResultSource(message),
          `${message.intent}: payload.content must be JSON`,
          message.thread_id
        )
      };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        errorResult: this.buildResult(
          message,
          "error",
          this.resolveResultSource(message),
          `${message.intent}: invalid payload (${result.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ")})`,
          message.thread_id
        )
      };
    }
    return { ok: true, data: result.data };
  }

  private projectCallerForResponse(record: CallerRecord): Omit<CallerRecord, "key_hash"> {
    // Strip key_hash before responding — Playbook §3.5: hashes never cross a process boundary.
    const { key_hash: _ignored, ...projected } = record;
    void _ignored;
    return projected;
  }

  private handleRegisterCaller(message: HubMessage): HubResult {
    const parsed = this.parseAdminPayload(message, RegisterCallerPayloadSchema);
    if (!parsed.ok) {
      return parsed.errorResult;
    }
    try {
      const result = this.requireCallerRegistry().mint({
        caller_id: parsed.data.caller_id,
        caller_label: parsed.data.caller_label,
        kind: "external"
      });
      return this.buildResult(
        message,
        "success",
        this.resolveResultSource(message),
        JSON.stringify({
          caller_id: result.record.caller_id,
          caller_key: result.cleartextKey
        }),
        message.thread_id
      );
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return this.buildResult(
        message,
        "error",
        this.resolveResultSource(message),
        `register_caller failed: ${err}`,
        message.thread_id
      );
    }
  }

  private handleUnregisterCaller(message: HubMessage): HubResult {
    const parsed = this.parseAdminPayload(message, CallerIdOnlyPayloadSchema);
    if (!parsed.ok) {
      return parsed.errorResult;
    }
    try {
      const { revoked_at } = this.requireCallerRegistry().revoke(parsed.data.caller_id);
      return this.buildResult(
        message,
        "success",
        this.resolveResultSource(message),
        JSON.stringify({ revoked_at }),
        message.thread_id
      );
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return this.buildResult(
        message,
        "error",
        this.resolveResultSource(message),
        `unregister_caller failed: ${err}`,
        message.thread_id
      );
    }
  }

  private handleRotateCallerKey(message: HubMessage): HubResult {
    const parsed = this.parseAdminPayload(message, CallerIdOnlyPayloadSchema);
    if (!parsed.ok) {
      return parsed.errorResult;
    }
    try {
      const result = this.requireCallerRegistry().rotate(parsed.data.caller_id);
      return this.buildResult(
        message,
        "success",
        this.resolveResultSource(message),
        JSON.stringify({ caller_key: result.cleartextKey }),
        message.thread_id
      );
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return this.buildResult(
        message,
        "error",
        this.resolveResultSource(message),
        `rotate_caller_key failed: ${err}`,
        message.thread_id
      );
    }
  }

  private handleListCallers(message: HubMessage): HubResult {
    const callers = this.requireCallerRegistry().list().map((record) => this.projectCallerForResponse(record));
    return this.buildResult(
      message,
      "success",
      this.resolveResultSource(message),
      JSON.stringify({
        callers,
        bootstrap_key_set: !!process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY
      }),
      message.thread_id
    );
  }

  private async dispatchToService(endpoint: ServiceEndpoint, message: HubMessage): Promise<HubResult> {
    const childMessage = {
      ...message,
      parent_span_id: message.span_id,
      span_id: randomUUID()
    };
    const response = await sendIpcRequest<HubMessage, HubResult>(endpoint.socket_path, childMessage);
    return HubResultSchema.parse(response);
  }

  private extractContent(response: Record<string, unknown>): string {
    const content = response.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content;
    }

    const message = response.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }

    return JSON.stringify(response, null, 2);
  }

  private extractResultAttachments(response: Record<string, unknown>): FileAttachment[] {
    const rawFiles = response.files;
    if (!Array.isArray(rawFiles)) {
      return [];
    }

    const attachments: FileAttachment[] = [];
    for (const rawFile of rawFiles) {
      if (typeof rawFile === "string") {
        const normalizedPath = rawFile.trim();
        if (!normalizedPath) {
          continue;
        }
        attachments.push({
          path: normalizedPath
        });
        continue;
      }

      if (!rawFile || typeof rawFile !== "object") {
        continue;
      }

      const candidate = rawFile as Record<string, unknown>;
      const normalizedPath =
        typeof candidate.path === "string"
          ? candidate.path.trim()
          : typeof candidate.file_path === "string"
            ? candidate.file_path.trim()
            : typeof candidate.abspath === "string"
              ? candidate.abspath.trim()
              : "";
      if (!normalizedPath) {
        continue;
      }

      attachments.push({
        path: normalizedPath,
        filename:
          typeof candidate.filename === "string"
            ? candidate.filename.trim() || undefined
            : typeof candidate.name === "string"
              ? candidate.name.trim() || undefined
              : typeof candidate.basename === "string"
                ? candidate.basename.trim() || undefined
                : undefined,
        mime_type:
          typeof candidate.mime_type === "string"
            ? candidate.mime_type.trim() || undefined
            : typeof candidate.mimeType === "string"
              ? candidate.mimeType.trim() || undefined
              : undefined
      });
    }

    return attachments;
  }

  private extractAttachmentResults(response: Record<string, unknown>): AttachmentResult[] {
    const rawAttachmentResults = response.attachment_results;
    if (!Array.isArray(rawAttachmentResults)) {
      return [];
    }

    const attachmentResults: AttachmentResult[] = [];
    for (const rawAttachmentResult of rawAttachmentResults) {
      if (!rawAttachmentResult || typeof rawAttachmentResult !== "object") {
        continue;
      }

      const candidate = rawAttachmentResult as Record<string, unknown>;
      const filename = typeof candidate.filename === "string" ? candidate.filename.trim() : "";
      const status = typeof candidate.status === "string" ? candidate.status.trim() : "";
      const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : undefined;
      if (!filename || (status !== "accepted" && status !== "extracted" && status !== "rejected")) {
        continue;
      }

      attachmentResults.push({
        filename,
        status,
        ...(reason ? { reason } : {})
      });
    }

    return attachmentResults;
  }

  private async resolveCompletionContent(client: AgentClient, threadId: string): Promise<string> {
    if (!client.getMessages) {
      return this.formatRunContent(threadId, "Task completed.");
    }

    try {
      const messages = await client.getMessages();
      const snapshots = this.extractAgentMessageSnapshots(messages);
      const latest = this.pickLatestStableSnapshot(snapshots);
      if (latest) {
        return this.formatRunContent(threadId, latest.content);
      }
    } catch {
      // Best effort only; monitor completion still returns an explicit result.
    }

    return this.formatRunContent(threadId, "Task completed.");
  }

  async buildProgressSnapshotForThread(threadId: string, traceId: string | null): Promise<ThreadProgressSnapshot> {
    const instance = this.resolveInstance(threadId);
    const client = this.clientFactory(instance.thread_id);
    await client.connect(instance.socket_path);

    try {
      const resolvedTraceId = this.resolveProgressTraceId(threadId, traceId);
      const historyEntry = this.findLatestConversationEntryForTrace(threadId, resolvedTraceId);
      const pendingEntry =
        historyEntry && isReplaceableConversationEventKind(historyEntry.event_kind)
          ? historyEntry
          : null;
      const latestSnapshot = await this.getLatestProgressSnapshot(client, threadId);
      const waitingForInput =
        latestSnapshot?.kind === "action_required" ||
        historyEntry?.event_kind === "approval" ||
        instance.status === "waiting";
      const displayText = this.formatRunContent(
        threadId,
        latestSnapshot?.content ||
          pendingEntry?.content ||
          (waitingForInput ? "Waiting for approval..." : "Task is running...")
      );

      return ThreadProgressSnapshotSchema.parse({
        trace_id: resolvedTraceId,
        thread_id: threadId,
        source: instance.agent_type,
        status: "partial",
        event_kind: waitingForInput ? "approval" : "progress",
        phase: waitingForInput ? "waiting_for_input" : "running",
        waiting_for_input: waitingForInput,
        content: displayText,
        display_text: displayText,
        updated_at: this.now().toISOString()
      });
    } finally {
      client.disconnect();
    }
  }

  private pickLatestStableSnapshot(snapshots: AgentMessageSnapshot[]): AgentMessageSnapshot | null {
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      if (!snapshot) {
        continue;
      }
      return snapshot;
    }

    return snapshots.length > 0 ? (snapshots[snapshots.length - 1] ?? null) : null;
  }

  private normalizeMonitorStatus(status: string): AgentInstance["status"] | null {
    const normalized = status.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    if (normalized === "stable" || normalized === "done" || normalized === "completed") {
      return "waiting";
    }

    if (
      normalized === "idle" ||
      normalized === "running" ||
      normalized === "waiting" ||
      normalized === "stopped" ||
      normalized === "error"
    ) {
      return normalized;
    }

    return null;
  }

  private upsertMonitorUpdateSubscription(
    threadId: string,
    sessionId: string,
    chatId: string,
    botId: string | undefined,
    intervalSec: number,
    replyChannel: ReplyChannel
  ): void {
    let byChat = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!byChat) {
      byChat = new Map<string, MonitorUpdateSubscription>();
      this.monitorUpdateSubscriptionsByThread.set(threadId, byChat);
    }

    byChat.set(sessionId, {
      sessionId,
      chatId,
      botId,
      replyChannel,
      intervalMs: intervalSec * 1000,
      nextDispatchAtMs: this.now().getTime()
    });
  }

  private deleteMonitorUpdateSubscription(threadId: string, sessionId: string): void {
    const byChat = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!byChat) {
      return;
    }

    byChat.delete(sessionId);
    if (byChat.size === 0) {
      this.monitorUpdateSubscriptionsByThread.delete(threadId);
    }
  }

  // ── Push subscription management ──

  private handlePush(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const enabled = message.payload.push_enabled;

    if (instance.mode !== "pane_bridge") {
      return this.buildResult(
        message, "error", instance.agent_type,
        "Push is only available for pane_bridge mode instances.",
        threadId
      );
    }

    if (message.reply_channel.channel === "web") {
      return this.handlePushFromWeb(message, threadId, instance, enabled);
    }

    const chatId = message.reply_channel.chat_id;
    const botId = message.reply_channel.bot_id;
    const sessionId = encodeSessionId(chatId, botId);

    if (enabled === undefined || enabled === null) {
      const existing = this.pushSubscriptionsByThread.get(threadId)?.get(sessionId);
      const state = existing ? "ON" : "OFF";
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text is ${state} for thread=${threadId}.`,
        threadId
      );
    }

    if (!enabled) {
      this.deletePushSubscription(threadId, sessionId);
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text turned OFF for thread=${threadId}.`,
        threadId
      );
    }

    this.upsertPushSubscription(threadId, sessionId, chatId, botId, message.reply_channel);
    return this.buildResult(
      message, "success", instance.agent_type,
      `Push agent text turned ON for thread=${threadId}.`,
      threadId
    );
  }

  private handlePushFromWeb(
    message: HubMessage,
    threadId: string,
    instance: AgentInstance,
    enabled: boolean | undefined | null
  ): HubResult {
    const existingCount = this.pushSubscriptionsByThread.get(threadId)?.size ?? 0;

    if (enabled === undefined || enabled === null) {
      const state = existingCount > 0 ? "ON" : "OFF";
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text is ${state} for thread=${threadId} (${existingCount} subscriber(s)).`,
        threadId
      );
    }

    if (!enabled) {
      this.pushSubscriptionsByThread.delete(threadId);
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text turned OFF for thread=${threadId}.`,
        threadId
      );
    }

    const attachedSessions = this.getAttachedSessionsForThread(threadId);
    let subscribed = 0;
    for (const session of attachedSessions) {
      const parsed = this.parseSessionTarget(session);
      if (!parsed) continue;
      const replyChannel = this.resolveReplyChannelForSession(session);
      this.upsertPushSubscription(threadId, session, parsed.chatId, parsed.botId, replyChannel);
      subscribed++;
    }

    if (subscribed === 0) {
      return this.buildResult(
        message, "error", instance.agent_type,
        `No attached Telegram sessions for thread=${threadId}. Use Telegram /push on to subscribe.`,
        threadId
      );
    }

    return this.buildResult(
      message, "success", instance.agent_type,
      `Push agent text turned ON for thread=${threadId} (${subscribed} session(s)).`,
      threadId
    );
  }

  private handleCaptureInterval(message: HubMessage): HubResult {
    const content = message.payload.content.trim();
    if (content) {
      const requestedMs = Number.parseInt(content, 10);
      if (Number.isFinite(requestedMs)) {
        this.instanceManager.setPaneCaptureIntervalMs(requestedMs);
      }
    }
    const currentMs = this.instanceManager.getPaneCaptureIntervalMs();
    return this.buildResult(message, "success", this.resolveResultSource(message), String(currentMs));
  }

  private handleHistory(message: HubMessage): HubResult {
    const requestedThreadId = this.extractConcreteThreadId(message.target) ?? this.extractConcreteThreadId(message.thread_id);
    if (requestedThreadId) {
      const shapedHistory = shapeHistoryPayload(this.getConversationHistoryForThread(requestedThreadId), {
        limit: message.payload.history_limit,
        maxContentChars: message.payload.history_max_content_chars,
        maxDetailChars: message.payload.history_max_detail_chars,
        maxRawChars: message.payload.history_max_raw_chars
      });
      return this.buildResult(
        message,
        "success",
        this.resolveResultSource(message),
        JSON.stringify(shapedHistory, null, 2),
        requestedThreadId
      );
    }

    return this.buildResult(
      message,
      "success",
      this.resolveResultSource(message),
      JSON.stringify(this.listConversationThreads(), null, 2),
      "global"
    );
  }

  private handleSetAutoApprove(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const blockedResult = this.blockAdsPublicAction(message, instance);
    if (blockedResult) {
      return blockedResult;
    }
    const value = message.payload.content.trim().toLowerCase() === "true";
    const updated = this.registry.setAutoApprove(threadId, value);
    if (!updated) {
      return this.buildResult(
        message,
        "error",
        instance.agent_type,
        `Failed to set auto_approve for thread=${threadId}`,
        threadId
      );
    }
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      `auto_approve=${value} for thread=${threadId}`,
      threadId
    );
  }

  /**
   * Dynamic A2A registration: meridian-roles (and other services) register their callback socket
   * so the hub can route custom intents. Outbound `run` traffic still uses agent thread_ids.
   */
  private handleRegisterService(message: HubMessage): HubResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.payload.content);
    } catch {
      return this.buildResult(
        message,
        "error",
        "codex",
        "register_service: payload.content must be JSON",
        message.thread_id
      );
    }

    const raw = parsed as {
      service?: string;
      socket_path?: string;
      agent_card?: { skills?: Array<{ intents?: string[] }> };
    };
    const socketPath = raw.socket_path?.trim();
    if (!socketPath) {
      return this.buildResult(
        message,
        "error",
        "codex",
        "register_service: payload must include socket_path",
        message.thread_id
      );
    }

    const serviceId = raw.service?.trim() ?? "service";
    const intents: string[] = [];
    for (const skill of raw.agent_card?.skills ?? []) {
      for (const intent of skill.intents ?? []) {
        const trimmed = intent.trim();
        if (trimmed) {
          intents.push(trimmed);
        }
      }
    }

    try {
      this.serviceRegistry.register({
        service: serviceId,
        socket_path: socketPath,
        intents
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return this.buildResult(message, "error", "codex", `register_service failed: ${err}`, message.thread_id);
    }

    return this.buildResult(
      message,
      "success",
      "codex",
      JSON.stringify({ ok: true, service: serviceId, socket_path: socketPath, intents }),
      message.thread_id
    );
  }

  private handleUnregisterService(message: HubMessage): HubResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.payload.content);
    } catch {
      return this.buildResult(
        message,
        "error",
        "codex",
        "unregister_service: payload.content must be JSON",
        message.thread_id
      );
    }

    const raw = parsed as { service?: string };
    const serviceId = raw.service?.trim();
    if (!serviceId) {
      return this.buildResult(
        message,
        "error",
        "codex",
        "unregister_service: payload must include service",
        message.thread_id
      );
    }

    const removed = this.serviceRegistry.unregister(serviceId);
    return this.buildResult(
      message,
      "success",
      "codex",
      JSON.stringify({ ok: true, service: serviceId, removed }),
      message.thread_id
    );
  }

  private parseSessionTarget(session: string): { chatId: string; botId?: string } | null {
    if (!session || session.startsWith("web:")) return null;
    const separatorIndex = session.indexOf(":");
    if (separatorIndex <= 0) {
      return { chatId: session };
    }
    const candidateBotId = session.slice(0, separatorIndex);
    if (!/^\d+$/.test(candidateBotId)) {
      return { chatId: session };
    }
    return {
      botId: candidateBotId,
      chatId: session.slice(separatorIndex + 1)
    };
  }

  private upsertPushSubscription(threadId: string, sessionId: string, chatId: string, botId: string | undefined, replyChannel: ReplyChannel): void {
    let byChat = this.pushSubscriptionsByThread.get(threadId);
    if (!byChat) {
      byChat = new Map();
      this.pushSubscriptionsByThread.set(threadId, byChat);
    }
    byChat.set(sessionId, { sessionId, chatId, botId, replyChannel });
  }

  private deletePushSubscription(threadId: string, sessionId: string): void {
    const byChat = this.pushSubscriptionsByThread.get(threadId);
    if (!byChat) return;
    byChat.delete(sessionId);
    if (byChat.size === 0) {
      this.pushSubscriptionsByThread.delete(threadId);
    }
  }

  getPushDeliveryTargets(): PushDeliveryTarget[] {
    const targets: PushDeliveryTarget[] = [];
    for (const [threadId, byChat] of this.pushSubscriptionsByThread.entries()) {
      for (const sub of byChat.values()) {
        targets.push({ threadId, chatId: sub.chatId, botId: sub.botId, replyChannel: sub.replyChannel });
      }
    }
    return targets;
  }

  getThreadsWithPushSubscriptions(): string[] {
    return [...this.pushSubscriptionsByThread.keys()];
  }

  getPushSubscriptionsForThread(threadId: string): PushSubscription[] {
    const byChat = this.pushSubscriptionsByThread.get(threadId);
    if (!byChat) return [];
    return [...byChat.values()];
  }

  getConversationHistoryForThread(threadId: string): ConversationHistoryEntry[] {
    return this.readConversationHistory(threadId);
  }

  listConversationThreads(): Array<{
    thread_id: string;
    updated_at: string | null;
    preview: string;
    active: boolean;
    status: AgentInstance["status"] | "stopped";
    agent_type: AgentType | null;
    model_id: string | null;
  }> {
    const threadIds = new Set<string>();
    for (const threadId of this.conversationHistoryByThread.keys()) {
      threadIds.add(threadId);
    }
    for (const instance of this.registry.list()) {
      threadIds.add(instance.thread_id);
    }

    return [...threadIds]
      .map((threadId) => {
        const instance = this.registry.get(threadId) ?? null;
        const history = this.readConversationHistory(threadId);
        const lastEntry = history[history.length - 1] ?? null;
        const previewSource = lastEntry?.content?.trim() || lastEntry?.details_text?.trim() || "";
        const preview = previewSource ? previewSource.split(/\r?\n/, 1)[0] ?? "" : "";
        return {
          thread_id: threadId,
          updated_at: lastEntry?.timestamp ?? instance?.created_at ?? null,
          preview,
          active: instance !== null && LIVE_INSTANCE_STATUSES.has(instance.status),
          status: instance?.status ?? "stopped",
          agent_type: instance?.agent_type ?? null,
          model_id: instance?.model_id ?? null
        };
      })
      .sort((left, right) => {
        const leftTs = left.updated_at ?? "";
        const rightTs = right.updated_at ?? "";
        return rightTs.localeCompare(leftTs);
      });
  }

  recordAgentPushConversation(
    threadId: string,
    rawContent: string,
    traceId: string | null = null,
    eventKindHint: "progress" | "final_reply" = "progress"
  ): void {
    if (eventKindHint === "final_reply") {
      this.recordAgentConversationEntry(threadId, rawContent, traceId, null);
      this.persistStateSafely();
      return;
    }
    const normalizedRaw = stripSummaryProtocolTags(stripMeridianContentFraming(rawContent)).trim() || rawContent.trim();
    const approvalSummary = parseApprovalSummaryFromRawContent(rawContent) ?? (isApprovalPrompt(normalizedRaw) ? normalizedRaw : null);
    const eventKind: ConversationEventKind = approvalSummary ? "approval" : "progress";
    const content = approvalSummary ?? normalizedRaw ?? "Task is running...";
    this.recordCanonicalConversationEntry(threadId, {
      event_kind: eventKind,
      source: this.resolveSourceForThread(threadId),
      content,
      details_text: normalizedRaw && normalizedRaw !== content ? normalizedRaw : "",
      raw_content: rawContent,
      trace_id: traceId,
      timestamp: this.now().toISOString(),
      replace_key: this.buildReplaceKey(threadId, traceId, eventKind)
    });
    this.persistStateSafely();
  }

  getLatestConversationEntry(threadId: string, traceId?: string | null, type: "user" | "agent" | null = null): ConversationHistoryEntry | null {
    const history = this.readConversationHistory(threadId);
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (!entry) {
        continue;
      }
      if (type && entry.type !== type) {
        continue;
      }
      if (traceId && entry.trace_id !== traceId) {
        continue;
      }
      return entry;
    }
    return null;
  }

  private resolveConversationDetailRecord(
    requestedTraceId?: string,
    requestedThreadId?: string
  ): { traceId: string; threadId: string; source: AgentType; fullText: string } | null {
    const threadCandidates = requestedThreadId
      ? [requestedThreadId]
      : [...new Set([...this.conversationHistoryByThread.keys(), ...this.registry.list().map((instance) => instance.thread_id)])];

    for (const threadId of threadCandidates) {
      const entry = this.getLatestConversationEntry(threadId, requestedTraceId ?? null, "agent");
      if (!entry) {
        continue;
      }
      const fullText = entry.details_text.trim() || entry.raw_content.trim() || entry.content.trim();
      if (!fullText) {
        continue;
      }
      return {
        traceId: entry.trace_id ?? requestedTraceId ?? "unknown",
        threadId,
        source: this.resolveSourceForThread(threadId),
        fullText
      };
    }
    return null;
  }

  private recordAgentConversationEntry(
    threadId: string,
    rawContent: string,
    traceId: string | null,
    inputText: string | null
  ): void {
    const summary = this.summarizeConversationContent(rawContent, traceId);
    const detailsText = this.composeConversationDetails(inputText, rawContent);
    this.recordCanonicalConversationEntry(threadId, {
      event_kind: "final_reply",
      source: this.resolveSourceForThread(threadId),
      content: summary,
      details_text: detailsText,
      raw_content: rawContent,
      trace_id: traceId,
      timestamp: this.now().toISOString(),
      replace_key: null
    });
  }

  private summarizeConversationContent(rawContent: string, traceId: string | null): string {
    const normalized = stripSummaryProtocolTags(stripMeridianContentFraming(rawContent)).trim();
    const extracted = traceId ? extractSummaryBlocks(rawContent, traceId) : { summary: null, residual: normalized, incomplete: false };
    if (extracted.summary) {
      return extracted.summary;
    }
    return normalized || "Update received. Expand details for full output.";
  }

  private composeConversationDetails(inputText: string | null, rawContent: string): string {
    const cleanOutput = stripSummaryProtocolTags(stripMeridianContentFraming(rawContent)).trim();
    const cleanInput = inputText?.trim() ?? "";
    if (!cleanInput) {
      return cleanOutput;
    }
    if (!cleanOutput) {
      return `Your message:\n${cleanInput}`;
    }
    return `Your message:\n${cleanInput}\n\nAgent reply:\n${cleanOutput}`;
  }

  private recordUserConversationEntry(
    threadId: string,
    rawContent: string,
    traceId: string | null,
    eventKind: "user_send" | "terminal_input"
  ): void {
    this.recordCanonicalConversationEntry(threadId, {
      event_kind: eventKind,
      source: "user",
      content: rawContent,
      details_text: "",
      raw_content: rawContent,
      trace_id: traceId,
      timestamp: this.now().toISOString(),
      replace_key: null
    });
  }

  private recordCanonicalConversationEntry(
    threadId: string,
    entry: Omit<ConversationHistoryEntry, "id" | "sequence" | "type">
  ): void {
    const history = this.readConversationHistory(threadId);

    if (entry.event_kind === "final_reply" && entry.trace_id) {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const existing = history[index];
        if (!existing) {
          continue;
        }
        if (
          existing.trace_id === entry.trace_id &&
          isSupersededByFinalReplyConversationEventKind(existing.event_kind)
        ) {
          history.splice(index, 1);
        }
      }
    }

    if (entry.replace_key) {
      const existingIndex = history.findIndex((candidate) => candidate.replace_key === entry.replace_key);
      if (existingIndex >= 0) {
        const existing = history[existingIndex];
        history[existingIndex] = {
          ...existing,
          event_kind: entry.event_kind,
          source: entry.source,
          type: conversationEntryTypeForEventKind(entry.event_kind),
          content: entry.content,
          details_text: entry.details_text,
          raw_content: entry.raw_content,
          trace_id: entry.trace_id,
          timestamp: entry.timestamp,
          replace_key: entry.replace_key
        };
        this.conversationHistoryByThread.set(threadId, this.trimConversationHistory(history));
        return;
      }
    }

    const previous = history[history.length - 1] ?? null;
    if (
      previous &&
      previous.event_kind === entry.event_kind &&
      previous.content.trim() === entry.content.trim() &&
      previous.details_text.trim() === entry.details_text.trim() &&
      previous.trace_id === entry.trace_id &&
      previous.replace_key === entry.replace_key
    ) {
      return;
    }

    history.push({
      id: randomUUID(),
      sequence: this.nextConversationSequence(history),
      event_kind: entry.event_kind,
      source: entry.source,
      type: conversationEntryTypeForEventKind(entry.event_kind),
      content: entry.content,
      details_text: entry.details_text,
      raw_content: entry.raw_content,
      trace_id: entry.trace_id,
      timestamp: entry.timestamp,
      replace_key: entry.replace_key
    });
    this.conversationHistoryByThread.set(threadId, this.trimConversationHistory(history));
  }

  private resolveApprovalConversationEntry(threadId: string): void {
    const history = this.readConversationHistory(threadId);
    const activeTraceId = this.activeRunsByThread.get(threadId)?.traceId ?? null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (!entry || entry.event_kind !== "approval") {
        continue;
      }
      if (activeTraceId && entry.trace_id && entry.trace_id !== activeTraceId) {
        continue;
      }

      const traceId = entry.trace_id ?? activeTraceId ?? null;
      const replaceKey = traceId ? `${traceId}:progress` : `${threadId}:progress`;
      for (let candidateIndex = history.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
        if (candidateIndex === index) {
          continue;
        }
        const candidate = history[candidateIndex];
        if (!candidate || candidate.replace_key !== replaceKey) {
          continue;
        }
        history.splice(candidateIndex, 1);
        if (candidateIndex < index) {
          index -= 1;
        }
      }

      history[index] = {
        ...entry,
        event_kind: "progress",
        type: conversationEntryTypeForEventKind("progress"),
        content: "Task is running...",
        details_text: "",
        raw_content: "Task is running...",
        timestamp: this.now().toISOString(),
        replace_key: replaceKey
      };
      this.conversationHistoryByThread.set(threadId, this.trimConversationHistory(history));
      return;
    }
  }

  private schedulePendingRunFinalization(threadId: string, traceId: string, inputText: string): void {
    const followupKey = `${threadId}:${traceId}`;
    if (this.pendingRunFollowups.has(followupKey)) {
      return;
    }

    this.pendingRunFollowups.add(followupKey);
    void this.finalizePendingRunInBackground(threadId, traceId, inputText, followupKey);
  }

  private async finalizePendingRunInBackground(
    threadId: string,
    traceId: string,
    inputText: string,
    followupKey: string
  ): Promise<void> {
    let client: AgentClient | null = null;
    try {
      const instance = this.resolveInstance(threadId);
      client = this.clientFactory(instance.thread_id);
      await client.connect(instance.socket_path);
      const completedReply = await this.waitForAgentReply(client, null, traceId, {
        trace_id: traceId,
        thread_id: threadId
      });
      if (!completedReply || completedReply.kind !== "final") {
        return;
      }

      const content = this.formatRunContent(threadId, completedReply.content);
      this.recordAgentConversationEntry(threadId, content, traceId, inputText);
      this.persistStateSafely();
    } catch (error) {
      this.log.warn(
        {
          trace_id: traceId,
          thread_id: threadId,
          reason: "pending_run_followup_failed",
          err: error instanceof Error ? error.message : String(error)
        },
        "Pending run finalization watcher failed"
      );
    } finally {
      this.pendingRunFollowups.delete(followupKey);
      client?.disconnect();
    }
  }

  private rehydrateLocalState(state: PersistedHubState): void {
    this.pushSubscriptionsByThread.clear();
    this.conversationHistoryByThread.clear();

    for (const [threadId, subscriptions] of Object.entries(state.push_subscriptions ?? {})) {
      if (!this.registry.has(threadId)) {
        continue;
      }
      const byChat = new Map<string, PushSubscription>();
      for (const subscription of subscriptions) {
        byChat.set(subscription.session_id, {
          sessionId: subscription.session_id,
          chatId: subscription.chat_id,
          botId: subscription.bot_id ?? undefined,
          replyChannel: {
            channel: "telegram",
            chat_id: subscription.chat_id,
            bot_id: subscription.bot_id ?? undefined
          }
        });
      }
      if (byChat.size > 0) {
        this.pushSubscriptionsByThread.set(threadId, byChat);
      }
    }

    for (const [threadId, entries] of Object.entries(state.conversation_history ?? {})) {
      this.conversationHistoryByThread.set(
        threadId,
        entries.map((entry) => ({
          id: entry.id,
          sequence: entry.sequence,
          event_kind: entry.event_kind,
          source: entry.source,
          type: conversationEntryTypeForEventKind(entry.event_kind),
          content: entry.content,
          details_text: entry.details_text ?? "",
          raw_content: entry.raw_content ?? entry.details_text ?? entry.content,
          trace_id: entry.trace_id ?? null,
          timestamp: entry.timestamp,
          replace_key: entry.replace_key ?? null
        })).sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp))
      );
    }
  }

  private serializePushSubscriptions(): Record<string, PersistedPushSubscription[]> {
    const snapshot: Record<string, PersistedPushSubscription[]> = {};
    for (const [threadId, subscriptions] of this.pushSubscriptionsByThread.entries()) {
      snapshot[threadId] = [...subscriptions.entries()].map(([sessionId, subscription]) => ({
        session_id: subscription.sessionId ?? sessionId,
        chat_id: subscription.chatId,
        bot_id: subscription.botId ?? null
      }));
    }
    return snapshot;
  }

  private serializeConversationHistory(): Record<string, PersistedConversationHistoryEntry[]> {
    const snapshot: Record<string, PersistedConversationHistoryEntry[]> = {};
    for (const [threadId, entries] of this.conversationHistoryByThread.entries()) {
      snapshot[threadId] = entries.map((entry) => ({
        id: entry.id,
        sequence: entry.sequence,
        event_kind: entry.event_kind,
        source: entry.source,
        content: entry.content,
        details_text: entry.details_text,
        raw_content: entry.raw_content,
        trace_id: entry.trace_id,
        timestamp: entry.timestamp,
        replace_key: entry.replace_key
      }));
    }
    return snapshot;
  }

  private buildReplaceKey(
    threadId: string,
    traceId: string | null,
    eventKind: Extract<ConversationEventKind, "progress" | "approval">
  ): string | null {
    if (eventKind !== "approval") {
      return null;
    }

    return traceId ? `${traceId}:${eventKind}` : `${threadId}:${eventKind}`;
  }

  private nextConversationSequence(history: ConversationHistoryEntry[]): number {
    const latest = history[history.length - 1];
    return (latest?.sequence ?? 0) + 1;
  }

  private resolveProgressTraceId(threadId: string, traceId: string | null): string {
    const activeTraceId = this.activeRunsByThread.get(threadId)?.traceId;
    if (activeTraceId) {
      return activeTraceId;
    }

    const history = this.readConversationHistory(threadId);
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (entry?.trace_id) {
        return entry.trace_id;
      }
    }

    return traceId ?? randomUUID();
  }

  private findLatestConversationEntryForTrace(threadId: string, traceId: string | null): ConversationHistoryEntry | null {
    const history = this.readConversationHistory(threadId);
    if (traceId) {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const entry = history[index];
        if (entry?.trace_id === traceId) {
          return entry;
        }
      }
    }

    return history[history.length - 1] ?? null;
  }

  private trimConversationHistory(history: ConversationHistoryEntry[]): ConversationHistoryEntry[] {
    history.sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp));
    if (history.length > THREAD_HISTORY_LIMIT) {
      history.splice(0, history.length - THREAD_HISTORY_LIMIT);
    }
    return history;
  }

  private readConversationHistory(threadId: string): ConversationHistoryEntry[] {
    return [...(this.conversationHistoryByThread.get(threadId) ?? [])].sort(
      (left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp)
    );
  }

  private async getLatestProgressSnapshot(client: AgentClient, threadId: string): Promise<AgentMessageSnapshot | null> {
    if (!client.getMessages) {
      return null;
    }

    try {
      const messages = await client.getMessages();
      const snapshots = this.extractAgentMessageSnapshots(messages);
      const latest = this.pickLatestStableSnapshot(snapshots);
      if (!latest) {
        return null;
      }
      return {
        ...latest,
        content: this.formatRunContent(threadId, latest.content)
      };
    } catch {
      return null;
    }
  }

  private normalizeMonitorUpdateIntervalSec(candidate: number | undefined): number {
    const fallback = config.MONITOR_UPDATE_DEFAULT_INTERVAL_SEC;
    const raw = candidate ?? fallback;
    const normalized = Math.floor(raw);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error("Monitor update interval must be a positive integer (seconds)");
    }
    if (normalized < config.MONITOR_UPDATE_MIN_INTERVAL_SEC || normalized > config.MONITOR_UPDATE_MAX_INTERVAL_SEC) {
      throw new Error(
        `Monitor update interval must be between ${config.MONITOR_UPDATE_MIN_INTERVAL_SEC} and ${config.MONITOR_UPDATE_MAX_INTERVAL_SEC} seconds`
      );
    }
    return normalized;
  }

  private async getLatestAgentMessageSnapshot(client: AgentClient): Promise<AgentMessageSnapshot | null> {
    if (!client.getMessages) {
      return null;
    }

    try {
      const messages = await client.getMessages();
      const snapshots = this.extractAgentMessageSnapshots(messages);
      return snapshots.length > 0 ? snapshots[snapshots.length - 1] ?? null : null;
    } catch {
      return null;
    }
  }

  private async waitForAgentReply(
    client: AgentClient,
    previousSnapshot: AgentMessageSnapshot | null,
    traceId: string,
    runLogContext?: { trace_id: string; thread_id: string }
  ): Promise<AgentReplyWaitResult | null> {
    if (!client.getMessages) {
      this.log.warn(
        { ...runLogContext, reason: "client_has_no_getMessages" },
        "waitForAgentReply returning null: client does not implement getMessages"
      );
      return null;
    }

    const maxAttempts = config.AGENT_REPLY_WAIT_MAX_ATTEMPTS;
    const delayMs = config.AGENT_REPLY_WAIT_DELAY_MS;
    const maxUnchangedSnapshotPolls = 3;
    let fallbackCandidate: string | null = null;
    let fallbackTail: string | null = null;
    let stablePolls = 0;
    let unchangedSnapshotPolls = 0;
    let lastKnownRunActivity: "active" | "inactive" | "unknown" = "unknown";

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (runLogContext && this.isRunInterrupted(runLogContext.thread_id, traceId)) {
        throw new RunInterruptedError(runLogContext.thread_id);
      }

      try {
        const messages = await client.getMessages();
        const summaryCandidate = this.extractLatestCompletedSummaryForTrace(messages, traceId);
        if (summaryCandidate) {
          return { kind: "final", content: summaryCandidate };
        }

        const snapshots = this.extractAgentMessageSnapshots(messages, traceId);
        const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] ?? null : null;
        const combinedReply = this.combineNewAgentReplySnapshots(snapshots, previousSnapshot);
        const hasNewAgentReply = latest ? this.isNewAgentReply(latest, previousSnapshot) : false;

        if (latest && previousSnapshot && !hasNewAgentReply) {
          unchangedSnapshotPolls += 1;
          lastKnownRunActivity = await this.getClientRunActivity(client);
          if (unchangedSnapshotPolls >= maxUnchangedSnapshotPolls && lastKnownRunActivity === "inactive") {
            return { kind: "non_final", runState: "timeout", content: null };
          }
        } else {
          unchangedSnapshotPolls = 0;
        }

        if (latest && combinedReply && hasNewAgentReply) {
          const changedCandidate = fallbackCandidate !== combinedReply;
          if (changedCandidate) {
            fallbackCandidate = combinedReply;
            fallbackTail = latest.content;
            stablePolls = 0;
          } else {
            stablePolls += 1;
          }

          lastKnownRunActivity = await this.getClientRunActivity(client);
          if (latest.kind === "action_required" && stablePolls >= 1) {
            return { kind: "non_final", runState: "still_running", content: fallbackCandidate };
          }

          // Stable polls are now fallback-only when no complete summary block is available.
          if (
            fallbackCandidate &&
            fallbackTail &&
            !this.isNonFinalTerminalFrame(fallbackTail) &&
            stablePolls >= 2 &&
            lastKnownRunActivity !== "active"
          ) {
            return { kind: "final", content: fallbackCandidate };
          }
        }
      } catch (error) {
        this.log.warn(
          {
            ...runLogContext,
            reason: "getMessages_threw",
            err: error instanceof Error ? error.message : String(error)
          },
          "waitForAgentReply returning null: getMessages() threw"
        );
        return null;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    if (fallbackCandidate && fallbackTail && !this.isNonFinalTerminalFrame(fallbackTail)) {
      const runState = lastKnownRunActivity === "active" ? "still_running" : "timeout";
      return lastKnownRunActivity === "active"
        ? { kind: "non_final", runState, content: fallbackCandidate }
        : { kind: "final", content: fallbackCandidate };
    }

    if (fallbackCandidate === null || (fallbackTail && this.isNonFinalTerminalFrame(fallbackTail))) {
      const noStableReply = fallbackCandidate === null;
      this.log.warn(
        {
          ...runLogContext,
          reason: noStableReply
            ? "no_stable_reply_within_max_attempts"
            : "only_non_final_frames_within_max_attempts",
          max_attempts: maxAttempts,
          delay_ms: delayMs
        },
        "waitForAgentReply returning null: no complete summary block within max attempts and fallback did not stabilize"
      );
      return {
        kind: "non_final",
        // No reply at all during the terminal wait window is a timeout even if the
        // agent still reports itself as running. Otherwise dispatcher workers can
        // remain stuck indefinitely on a generic "Task is running..." placeholder.
        runState: noStableReply
          ? "timeout"
          : (lastKnownRunActivity === "inactive" ? "timeout" : "still_running"),
        content: fallbackTail && this.isNonFinalTerminalFrame(fallbackTail) ? fallbackCandidate : null
      };
    }
    return { kind: "final", content: fallbackCandidate };
  }

  private async getClientRunActivity(client: AgentClient): Promise<"active" | "inactive" | "unknown"> {
    try {
      const status = await client.getStatus();
      const rawStatus =
        typeof status.status === "string"
          ? status.status.trim().toLowerCase()
          : typeof status.agent_status === "string"
            ? status.agent_status.trim().toLowerCase()
            : "";
      if (!rawStatus) {
        return "unknown";
      }
      if (rawStatus === "running" || rawStatus === "waiting") {
        return "active";
      }
      if (rawStatus === "idle" || rawStatus === "stopped" || rawStatus === "error") {
        return "inactive";
      }
    } catch {
      return "unknown";
    }

    return "unknown";
  }

  private async resolveFallbackRunContent(
    client: AgentClient,
    response: Record<string, unknown>,
    previousSnapshot: AgentMessageSnapshot | null
  ): Promise<string> {
    const isAck = this.isTransportAckResponse(response);
    const extracted = this.extractContent(response);
    const extractedClassification = classifyAgentOutput(extracted);

    if (!isAck && extracted.trim().length > 0) {
      if (extractedClassification.kind === "action_required") {
        return extractedClassification.text.trim() || extracted.trim();
      }
      if (extractedClassification.kind === "message") {
        return extractedClassification.text.trim() || extracted.trim();
      }
    }

    const latestSnapshot = await this.getLatestAgentMessageSnapshot(client);
    if (
      latestSnapshot?.content &&
      !this.isNonFinalTerminalFrame(latestSnapshot.content) &&
      this.isNewAgentReply(latestSnapshot, previousSnapshot)
    ) {
      return latestSnapshot.content;
    }

    if (isAck) {
      return "Agent is processing...";
    }

    if (extractedClassification.kind === "transient") {
      return "Agent is processing...";
    }

    return extractedClassification.text.trim() || extracted;
  }

  private isTransportAckResponse(response: Record<string, unknown>): boolean {
    const ok = response.ok;
    const content = response.content;
    const message = response.message;
    return ok === true && typeof content !== "string" && typeof message !== "string";
  }

  private isNewAgentReply(
    latest: AgentMessageSnapshot,
    previous: AgentMessageSnapshot | null
  ): boolean {
    if (!previous) {
      return true;
    }

    return latest.id > previous.id || latest.content !== previous.content;
  }

  private isNonFinalTerminalFrame(content: string): boolean {
    const kind = classifyAgentOutput(content).kind;
    return kind === "transient" || kind === "action_required";
  }

  private extractLatestCompletedSummaryForTrace(
    messages: Record<string, unknown>[],
    traceId: string
  ): string | null {
    let latestByMessageId: { id: number; content: string } | null = null;
    let fallbackCounter = 0;

    for (const message of messages) {
      fallbackCounter += 1;
      const role = typeof message.role === "string" ? message.role : "";
      if (!AGENT_ROLES.has(role)) {
        continue;
      }

      const contentCandidate =
        typeof message.content === "string"
          ? message.content
          : typeof message.message === "string"
            ? message.message
            : "";
      if (!contentCandidate.trim()) {
        continue;
      }

      const idCandidate =
        typeof message.id === "number" && Number.isFinite(message.id)
          ? message.id
          : Number.isFinite(Number(message.id))
            ? Number(message.id)
            : fallbackCounter;

      const extracted = extractLatestCompleteSummaryBlock(contentCandidate, traceId);
      if (!extracted) {
        continue;
      }
      const trimmed = extracted.trim();
      if (!trimmed) {
        continue;
      }

      if (!latestByMessageId || idCandidate >= latestByMessageId.id) {
        latestByMessageId = {
          id: idCandidate,
          content: trimmed
        };
      }
    }

    return latestByMessageId?.content ?? null;
  }

  private extractAgentMessageSnapshots(
    messages: Record<string, unknown>[],
    traceId?: string
  ): AgentMessageSnapshot[] {
    const snapshots: AgentMessageSnapshot[] = [];
    let fallbackCounter = 0;

    for (const message of messages) {
      fallbackCounter += 1;
      const role = typeof message.role === "string" ? message.role : "";
      if (!AGENT_ROLES.has(role)) {
        continue;
      }

      const contentCandidate =
        typeof message.content === "string"
          ? message.content
          : typeof message.message === "string"
            ? message.message
            : "";
      const classified = classifyAgentOutput(contentCandidate);
      const content = classified.text.trim();
      if (!content || classified.kind === "transient") {
        continue;
      }
      const summaryBlock = traceId ? extractLatestCompleteSummaryBlock(contentCandidate, traceId) : null;
      if (traceId && summaryBlock !== null) {
        continue;
      }

      const idCandidate =
        typeof message.id === "number" && Number.isFinite(message.id)
          ? message.id
          : Number.isFinite(Number(message.id))
            ? Number(message.id)
            : fallbackCounter;

      snapshots.push({ id: idCandidate, content, kind: classified.kind });
    }

    snapshots.sort((left, right) => left.id - right.id);
    return snapshots;
  }

  private combineNewAgentReplySnapshots(
    snapshots: AgentMessageSnapshot[],
    previous: AgentMessageSnapshot | null
  ): string | null {
    if (snapshots.length === 0) {
      return null;
    }

    if (!previous) {
      return snapshots[snapshots.length - 1]?.content ?? null;
    }

    // Return only the latest new snapshot — joining all segments caused
    // stale conversation history to leak into the result.
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      if (!snapshot) {
        continue;
      }
      if (snapshot.id > previous.id || (snapshot.id === previous.id && snapshot.content !== previous.content)) {
        return snapshot.content;
      }
    }

    return null;
  }

  private formatRunContent(_threadId: string, content: string): string {
    return content;
  }

  private buildPendingRunResult(
    message: HubMessage,
    source: AgentType,
    threadId: string,
    runState: Exclude<HubRunState, "completed">,
    fallbackContent: string | null,
    attachmentResults: AttachmentResult[] = []
  ): HubResult {
    this.log.warn(
      {
        trace_id: message.trace_id,
        thread_id: threadId,
        intent: message.intent,
        run_state: runState
      },
      "Returning non-terminal result on terminal wait path"
    );
    const progress = this.buildPendingRunSnapshot(threadId, message.trace_id, source, fallbackContent);
    this.recordAgentPushConversation(threadId, progress.content, message.trace_id);
    if (progress.event_kind === "approval") {
      this.schedulePendingRunFinalization(threadId, message.trace_id, message.payload.content);
    }
    return HubResultSchema.parse({
      trace_id: message.trace_id,
      thread_id: threadId,
      source,
      status: "partial",
      run_state: runState,
      content: progress.content,
      progress,
      attachments: [],
      attachment_results: attachmentResults.length > 0 ? attachmentResults : undefined,
      timestamp: progress.updated_at
    });
  }

  private buildPendingRunSnapshot(
    threadId: string,
    traceId: string,
    source: AgentType,
    fallbackContent: string | null
  ): ThreadProgressSnapshot {
    const historyEntry = this.findLatestConversationEntryForTrace(threadId, traceId);
    const pendingEntry =
      historyEntry && isReplaceableConversationEventKind(historyEntry.event_kind)
        ? historyEntry
        : null;
    const fallbackClassification = fallbackContent ? classifyAgentOutput(fallbackContent) : null;
    const waitingForInput =
      fallbackClassification?.kind === "action_required" ||
      historyEntry?.event_kind === "approval" ||
      this.registry.get(threadId)?.status === "waiting";
    const displayText = this.formatRunContent(
      threadId,
      fallbackContent?.trim() ||
        pendingEntry?.content ||
        (waitingForInput ? "Waiting for approval..." : "Task is running...")
    );

    return ThreadProgressSnapshotSchema.parse({
      trace_id: traceId,
      thread_id: threadId,
      source,
      status: "partial",
      event_kind: waitingForInput ? "approval" : "progress",
      phase: waitingForInput ? "waiting_for_input" : "running",
      waiting_for_input: waitingForInput,
      content: displayText,
      display_text: displayText,
      updated_at: this.now().toISOString()
    });
  }

  private buildResult(
    message: HubMessage,
    status: HubResult["status"],
    source: AgentType,
    content: string,
    threadIdOverride?: string,
    options?: {
      attachments?: FileAttachment[];
      attachmentResults?: AttachmentResult[];
      telegramInlineKeyboard?: HubResult["telegram_inline_keyboard"];
      runState?: HubResult["run_state"];
    }
  ): HubResult {
    return HubResultSchema.parse({
      trace_id: message.trace_id,
      thread_id: threadIdOverride ?? message.thread_id,
      source,
      status,
      run_state: options?.runState,
      content,
      attachments: options?.attachments ?? [],
      attachment_results: options?.attachmentResults?.length ? options.attachmentResults : undefined,
      telegram_inline_keyboard: options?.telegramInlineKeyboard,
      timestamp: this.now().toISOString()
    });
  }

  private persistStateSafely(): void {
    try {
      const snapshot = this.instanceManager.snapshotState();
      savePersistedHubState(
        this.statePath,
        buildPersistedHubState(
          this.now().toISOString(),
          snapshot.instances ?? [],
          snapshot.session_bindings ?? {},
          this.serializePushSubscriptions(),
          this.serializeConversationHistory(),
          this.callerRegistry?.list() ?? []
        )
      );
    } catch (error) {
      this.log.warn(
        {
          trace_id: null,
          thread_id: null,
          state_path: this.statePath,
          err: error instanceof Error ? error.message : String(error)
        },
        "Failed to persist hub state"
      );
    }
  }
}
