import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import type { HubMessage, HubResult, LifecycleStatus } from "../../types";
import { LifecycleStore, hubResultContainsInlineReport } from "./lifecycle-store";
import { isMissingThreadEvidence } from "./missing-thread";

export interface ReconciliationChange {
  workerId: string;
  from: LifecycleStatus;
  to: LifecycleStatus;
  trigger: string;
}

export interface ReconciliationReport {
  changed: ReconciliationChange[];
  unchanged: string[];
}

export interface ReconcileOptions {
  staleTimeoutMs?: number;
}

export const DEFAULT_RECONCILE_STALE_TIMEOUT_MS = 30 * 60 * 1000;
export const DISPATCHER_ENTRY_ID = "dispatcher";
export const reconciliationFs = {
  existsSync: fs.existsSync,
  statSync: fs.statSync
};

type ReconciliationHubClient = {
  serviceId?: string;
  sendRequest?: (message: HubMessage) => Promise<HubResult>;
};

export type HubThreadObservationKind = "running" | "idle" | "completed" | "failed" | "missing";

export interface HubThreadObservation {
  kind: HubThreadObservationKind;
  rawStatus: string | null;
}

interface ConversationHistoryEntry {
  event_kind?: string;
  source?: string;
  content?: string;
  details_text?: string;
  raw_content?: string;
  trace_id?: string | null;
  timestamp?: string;
}

const RUNNING_STATUSES = new Set(["running", "waiting", "queued", "starting", "in_progress"]);
const IDLE_STATUSES = new Set(["idle", "stable"]);
const COMPLETED_STATUSES = new Set(["completed", "success"]);
const FAILED_STATUSES = new Set(["error", "failed", "timeout"]);
export async function reconcile(
  lifecycleStore: LifecycleStore,
  hubClient: A2AClient,
  options: ReconcileOptions = {}
): Promise<ReconciliationReport> {
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_RECONCILE_STALE_TIMEOUT_MS;
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const state = lifecycleStore.load();
  const report: ReconciliationReport = {
    changed: [],
    unchanged: []
  };

  await reconcileDispatcher(lifecycleStore, state, hubClient, report);

  const RECONCILABLE_STATUSES = new Set<string>(["running", "abandoned"]);

  for (const [workerId, worker] of Object.entries(state.workers)) {
    if (!RECONCILABLE_STATUSES.has(worker.status)) {
      report.unchanged.push(workerId);
      continue;
    }

    const outputsPresent = outputsExist(worker.expected_outputs);
    const recordedResultTransition = determineRecordedResultTransition(worker.hub_result, outputsPresent);
    if (recordedResultTransition) {
      state.workers[workerId] = {
        ...worker,
        status: recordedResultTransition.to,
        last_seen_at: nowIso
      };
      lifecycleStore.logTransition(workerId, worker.status, recordedResultTransition.to, recordedResultTransition.trigger);
      report.changed.push({
        workerId,
        from: worker.status,
        to: recordedResultTransition.to,
        trigger: recordedResultTransition.trigger
      });
      continue;
    }

    const observation = await queryHubThreadObservation(hubClient, worker.thread_id);
    const recoveredHubResult =
      !worker.hub_result && !outputsPresent && observation.kind !== "running"
        ? await recoverHubResultFromHistory(hubClient, worker.thread_id, worker.trace_id)
        : null;
    const effectiveHubResult = recoveredHubResult ?? worker.hub_result;
    const recoveredTransition = determineRecordedResultTransition(effectiveHubResult, outputsPresent);
    if (recoveredTransition) {
      const terminalTimestamp = effectiveHubResult?.timestamp ?? nowIso;
      state.workers[workerId] = {
        ...worker,
        trace_id: effectiveHubResult?.trace_id || worker.trace_id,
        last_seen_at: terminalTimestamp,
        status: recoveredTransition.to,
        hub_result: effectiveHubResult
      };
      lifecycleStore.logTransition(workerId, worker.status, recoveredTransition.to, recoveredTransition.trigger);
      report.changed.push({
        workerId,
        from: worker.status,
        to: recoveredTransition.to,
        trigger: recoveredTransition.trigger
      });
      continue;
    }

    const transition = determineWorkerTransition(
      observation,
      outputsPresent,
      effectiveHubResult,
      worker.started_at,
      nowMs,
      staleTimeoutMs
    );

    if (!transition) {
      report.unchanged.push(workerId);
      continue;
    }

    state.workers[workerId] = {
      ...worker,
      trace_id: effectiveHubResult?.trace_id || worker.trace_id,
      status: transition.to,
      last_seen_at: effectiveHubResult?.timestamp ?? nowIso,
      hub_result: effectiveHubResult
    };
    lifecycleStore.logTransition(workerId, worker.status, transition.to, transition.trigger);
    report.changed.push({
      workerId,
      from: worker.status,
      to: transition.to,
      trigger: transition.trigger
    });
  }

  state.last_reconciled_at = nowIso;
  lifecycleStore.save(state);
  return report;
}

async function reconcileDispatcher(
  lifecycleStore: LifecycleStore,
  state: ReturnType<LifecycleStore["load"]>,
  hubClient: A2AClient,
  report: ReconciliationReport
): Promise<void> {
  if (state.dispatcher.status !== "running") {
    report.unchanged.push(DISPATCHER_ENTRY_ID);
    return;
  }

  const observation = await queryHubThreadObservation(hubClient, state.dispatcher.thread_id);
  if (observation.kind === "missing") {
    state.dispatcher = {
      ...state.dispatcher,
      status: "abandoned"
    };
    lifecycleStore.logTransition(DISPATCHER_ENTRY_ID, "running", "abandoned", "dispatcher_thread_missing");
    report.changed.push({
      workerId: DISPATCHER_ENTRY_ID,
      from: "running",
      to: "abandoned",
      trigger: "dispatcher_thread_missing"
    });
    return;
  }

  if (observation.kind === "failed") {
    state.dispatcher = {
      ...state.dispatcher,
      status: "failed"
    };
    lifecycleStore.logTransition(
      DISPATCHER_ENTRY_ID,
      "running",
      "failed",
      `hub_status:${observation.rawStatus ?? "failed"}`
    );
    report.changed.push({
      workerId: DISPATCHER_ENTRY_ID,
      from: "running",
      to: "failed",
      trigger: `hub_status:${observation.rawStatus ?? "failed"}`
    });
    return;
  }

  report.unchanged.push(DISPATCHER_ENTRY_ID);
}

function determineWorkerTransition(
  observation: HubThreadObservation,
  outputsPresent: boolean,
  hubResult: HubResult | null,
  startedAt: string,
  nowMs: number,
  staleTimeoutMs: number
): Pick<ReconciliationChange, "to" | "trigger"> | null {
  const hasInlineReport = hubResult ? hubResultContainsInlineReport(hubResult) : false;

  if ((observation.kind === "completed" || observation.kind === "idle") && outputsPresent) {
    return {
      to: "completed",
      trigger: `hub_status:${observation.rawStatus ?? observation.kind}:outputs_present`
    };
  }

  if ((observation.kind === "completed" || observation.kind === "idle") && hasInlineReport) {
    return {
      to: "completed",
      trigger: `hub_status:${observation.rawStatus ?? observation.kind}:inline_report`
    };
  }

  if (observation.kind === "failed") {
    return {
      to: "failed",
      trigger: `hub_status:${observation.rawStatus ?? "failed"}`
    };
  }

  if (observation.kind === "missing") {
    if (outputsPresent) {
      return {
        to: "completed",
        trigger: "thread_missing:outputs_present"
      };
    }

    if (hasInlineReport) {
      return {
        to: "completed",
        trigger: "thread_missing:inline_report"
      };
    }

    if (isStale(startedAt, nowMs, staleTimeoutMs)) {
      return {
        to: "abandoned",
        trigger: "thread_missing:stale_timeout"
      };
    }
  }

  // Worker thread exists but is idle with no hub result — the run command never
  // reached the agent (e.g. fire-and-forget HTTP handoff failed silently).
  // Transition to abandoned after stale timeout so the watchdog can recover.
  if (observation.kind === "idle" && !hubResult && !outputsPresent && isStale(startedAt, nowMs, staleTimeoutMs)) {
    return {
      to: "abandoned",
      trigger: "hub_idle:no_result:stale_timeout"
    };
  }

  return null;
}

function determineRecordedResultTransition(
  hubResult: HubResult | null,
  outputsPresent: boolean
): Pick<ReconciliationChange, "to" | "trigger"> | null {
  if (!hubResult) {
    return null;
  }

  if (hubResult.status === "timeout" || hubResult.run_state === "timeout") {
    return {
      to: "failed",
      trigger: "hub_result:timeout"
    };
  }

  if (hubResult.status === "success" && (!hubResult.run_state || hubResult.run_state === "completed")) {
    if (containsProviderError(hubResult.content)) {
      return {
        to: "failed",
        trigger: "hub_result:provider_error"
      };
    }

    if (outputsPresent) {
      return {
        to: "completed",
        trigger: "hub_result:outputs_present"
      };
    }

    if (reportedOutputsExist(hubResult)) {
      return {
        to: "completed",
        trigger: "hub_result:reported_outputs_present"
      };
    }

    if (hubResultContainsInlineReport(hubResult)) {
      return {
        to: "completed",
        trigger: "hub_result:inline_report"
      };
    }
  }

  return null;
}

export async function queryHubThreadObservation(
  hubClient: A2AClient,
  threadId: string | null
): Promise<HubThreadObservation> {
  if (!threadId) {
    return {
      kind: "missing",
      rawStatus: null
    };
  }

  const statusClient = hubClient as unknown as ReconciliationHubClient;
  if (typeof statusClient.sendRequest !== "function") {
    throw new Error("A2AClient does not expose sendRequest for reconciliation");
  }

  const actorId =
    typeof statusClient.serviceId === "string" && statusClient.serviceId.trim().length > 0
      ? statusClient.serviceId
      : "service:meridian-roles";
  const result = await statusClient.sendRequest(buildStatusMessage(threadId, actorId));
  return classifyStatusResult(result);
}

async function recoverHubResultFromHistory(
  hubClient: A2AClient,
  threadId: string | null,
  traceId: string | null
): Promise<HubResult | null> {
  if (!threadId) {
    return null;
  }

  const statusClient = hubClient as unknown as ReconciliationHubClient;
  if (typeof statusClient.sendRequest !== "function") {
    throw new Error("A2AClient does not expose sendRequest for reconciliation");
  }

  const actorId =
    typeof statusClient.serviceId === "string" && statusClient.serviceId.trim().length > 0
      ? statusClient.serviceId
      : "service:meridian-roles";
  const historyResult = await statusClient.sendRequest(buildHistoryMessage(threadId, actorId));
  if (historyResult.status !== "success") {
    return null;
  }

  const historyEntries = parseConversationHistoryEntries(historyResult.content);
  const finalReplyEntry = findLatestFinalReplyEntry(historyEntries, traceId);
  if (!finalReplyEntry) {
    return null;
  }

  return buildRecoveredHubResult(threadId, finalReplyEntry, traceId);
}

function buildStatusMessage(threadId: string, actorId: string): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: threadId,
    actor_id: actorId,
    intent: "status",
    target: threadId,
    priority: 5,
    mode: "bridge",
    reply_channel: {
      channel: "web",
      chat_id: actorId
    },
    payload: {
      content: "",
      attachments: []
    }
  };
}

function buildHistoryMessage(threadId: string, actorId: string): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: threadId,
    actor_id: actorId,
    intent: "history",
    target: threadId,
    priority: 5,
    mode: "bridge",
    reply_channel: {
      channel: "web",
      chat_id: actorId
    },
    payload: {
      content: "",
      attachments: []
    }
  };
}

function classifyStatusResult(result: HubResult): HubThreadObservation {
  if (result.status === "error" && isMissingThreadResult(result.content)) {
    return {
      kind: "missing",
      rawStatus: null
    };
  }

  const statusCandidates = extractStatusCandidates(result.content);
  for (const candidate of statusCandidates) {
    if (FAILED_STATUSES.has(candidate)) {
      return {
        kind: "failed",
        rawStatus: candidate
      };
    }
  }

  for (const candidate of statusCandidates) {
    if (COMPLETED_STATUSES.has(candidate)) {
      return {
        kind: "completed",
        rawStatus: candidate
      };
    }
  }

  for (const candidate of statusCandidates) {
    if (IDLE_STATUSES.has(candidate)) {
      return {
        kind: "idle",
        rawStatus: candidate
      };
    }
  }

  for (const candidate of statusCandidates) {
    if (RUNNING_STATUSES.has(candidate)) {
      return {
        kind: "running",
        rawStatus: candidate
      };
    }
  }

  return {
    kind: "running",
    rawStatus: statusCandidates[0] ?? null
  };
}

function parseConversationHistoryEntries(rawContent: string): ConversationHistoryEntry[] {
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    return Array.isArray(parsed) ? parsed as ConversationHistoryEntry[] : [];
  } catch {
    return [];
  }
}

function findLatestFinalReplyEntry(
  historyEntries: ConversationHistoryEntry[],
  traceId: string | null
): ConversationHistoryEntry | null {
  for (let index = historyEntries.length - 1; index >= 0; index -= 1) {
    const entry = historyEntries[index];
    if (!entry || entry.event_kind !== "final_reply") {
      continue;
    }

    if (traceId && entry.trace_id !== traceId) {
      continue;
    }

    const rawContent = normalizeHistoryText(entry.raw_content);
    const detailsText = normalizeHistoryText(entry.details_text);
    const content = normalizeHistoryText(entry.content);
    if (!rawContent && !detailsText && !content) {
      continue;
    }

    return entry;
  }

  return null;
}

function buildRecoveredHubResult(
  threadId: string,
  entry: ConversationHistoryEntry,
  expectedTraceId: string | null
): HubResult {
  const rawContent = normalizeHistoryText(entry.raw_content);
  const detailsText = normalizeHistoryText(entry.details_text);
  const summaryText = normalizeHistoryText(entry.content);

  return {
    trace_id: entry.trace_id ?? expectedTraceId ?? randomUUID(),
    thread_id: threadId,
    source: normalizeHistorySource(entry.source),
    status: "success",
    run_state: "completed",
    content: rawContent || detailsText || summaryText || "Update received. Expand details for full output.",
    summary_text: summaryText || undefined,
    details_text: detailsText || undefined,
    attachments: [],
    timestamp: normalizeHistoryTimestamp(entry.timestamp)
  };
}

function normalizeHistorySource(value: string | undefined): HubResult["source"] {
  return value === "claude" || value === "codex" || value === "gemini" || value === "cursor"
    ? value
    : "codex";
}

function normalizeHistoryTimestamp(value: string | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value : new Date().toISOString();
}

function normalizeHistoryText(value: string | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function extractStatusCandidates(rawContent: string): string[] {
  const parsed = parseLeadingJsonObject(rawContent);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const candidates: string[] = [];
  collectStatusCandidate(parsed, "status", candidates);

  const instance = readRecordField(parsed, "instance");
  if (instance) {
    collectStatusCandidate(instance, "status", candidates);
  }

  const agentStatus = readRecordField(parsed, "agent_status");
  if (agentStatus) {
    collectStatusCandidate(agentStatus, "status", candidates);
  } else {
    collectStatusCandidate(parsed, "agent_status", candidates);
  }

  return candidates;
}

function collectStatusCandidate(record: Record<string, unknown>, key: string, candidates: string[]): void {
  const candidate = record[key];
  if (typeof candidate !== "string") {
    return;
  }

  const normalized = candidate.trim().toLowerCase();
  if (normalized.length === 0) {
    return;
  }

  candidates.push(normalized);
}

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseLeadingJsonObject(rawContent: string): Record<string, unknown> | null {
  const startIndex = rawContent.indexOf("{");
  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < rawContent.length; index += 1) {
    const character = rawContent[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawContent.slice(startIndex, index + 1)) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  return null;
}

function isMissingThreadResult(content: string): boolean {
  return isMissingThreadEvidence(content);
}

function outputsExist(paths: string[]): boolean {
  if (paths.length === 0) {
    return false;
  }

  return paths.every((filePath) => {
    if (!reconciliationFs.existsSync(filePath)) {
      return false;
    }

    try {
      return reconciliationFs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
  });
}

function reportedOutputsExist(hubResult: HubResult): boolean {
  return extractReportedOutputPaths(hubResult).some((filePath) => {
    if (!isCompletionArtifactPath(filePath) || !reconciliationFs.existsSync(filePath)) {
      return false;
    }

    try {
      return reconciliationFs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
  });
}

function extractReportedOutputPaths(hubResult: HubResult): string[] {
  const candidateTexts = [
    hubResult.content,
    hubResult.summary_text,
    hubResult.details_text
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const paths = new Set<string>();

  for (const text of candidateTexts) {
    for (const match of text.matchAll(/\/[^\s)`\]'"]+/g)) {
      const candidatePath = normalizeReportedOutputPath(match[0]);
      if (candidatePath) {
        paths.add(candidatePath);
      }
    }
  }

  return [...paths];
}

function normalizeReportedOutputPath(candidatePath: string): string | null {
  const normalized = candidatePath.trim().replace(/[),.;:]+$/g, "").replace(/#[^/]*$/, "");
  if (!path.isAbsolute(normalized)) {
    return null;
  }

  return path.normalize(normalized);
}

function isCompletionArtifactPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(normalized);

  return (
    normalized.includes("/dev_history/")
    && (
      /_report\.md$/.test(basename)
      || basename === "delta_check_report.md"
      || basename === "pr_review_report.md"
    )
  ) || (normalized.includes("/reports/") && basename.endsWith(".md"));
}

function isStale(startedAt: string, nowMs: number, staleTimeoutMs: number): boolean {
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    return false;
  }

  return nowMs - startedAtMs >= staleTimeoutMs;
}

const PROVIDER_ERROR_PATTERNS = [
  /\{"type"\s*:\s*"error"/,
  /\binvalid_request_error\b/,
  /\bmodel is not supported\b/i,
  /\brate_limit_error\b/,
  /\bauthentication_error\b/
];

function containsProviderError(content: string): boolean {
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(content));
}
