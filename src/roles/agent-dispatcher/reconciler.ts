import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import type { A2AClient } from "../../a2a/client";
import type { HubMessage, HubResult, LifecycleStatus } from "../../types";
import { LifecycleStore } from "./lifecycle-store";

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

type HubThreadObservationKind = "running" | "idle" | "completed" | "failed" | "missing";

interface HubThreadObservation {
  kind: HubThreadObservationKind;
  rawStatus: string | null;
}

const RUNNING_STATUSES = new Set(["running", "waiting", "queued", "starting", "in_progress"]);
const IDLE_STATUSES = new Set(["idle", "stable"]);
const COMPLETED_STATUSES = new Set(["completed", "success"]);
const FAILED_STATUSES = new Set(["error", "failed", "timeout"]);
const MISSING_THREAD_PATTERNS = [
  /\bnot registered\b/i,
  /\bunknown thread\b/i,
  /\bnot found\b/i,
  /\bno thread is attached\b/i
];

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
    const transition = determineWorkerTransition(observation, outputsPresent, worker.hub_result, worker.started_at, nowMs, staleTimeoutMs);

    if (!transition) {
      report.unchanged.push(workerId);
      continue;
    }

    state.workers[workerId] = {
      ...worker,
      status: transition.to,
      last_seen_at: nowIso
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
  const hasInlineReport = hubResult ? containsInlineReport(hubResult.content) : false;

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

  return null;
}

function determineRecordedResultTransition(
  hubResult: HubResult | null,
  outputsPresent: boolean
): Pick<ReconciliationChange, "to" | "trigger"> | null {
  if (!hubResult) {
    return null;
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

    if (containsInlineReport(hubResult.content)) {
      return {
        to: "completed",
        trigger: "hub_result:inline_report"
      };
    }
  }

  return null;
}

async function queryHubThreadObservation(hubClient: A2AClient, threadId: string | null): Promise<HubThreadObservation> {
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
  return MISSING_THREAD_PATTERNS.some((pattern) => pattern.test(content));
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

const INLINE_REPORT_PATTERNS = [
  /completion\s+report/i,
  /##\s*Files\s+Changed/i,
  /##\s*Sub-task\s+Results/i,
  /##\s*AI\s+Auto-Test\s+Results/i,
  /\bStatus\b.*✅\s*Complete/i
];

function containsInlineReport(content: string): boolean {
  return INLINE_REPORT_PATTERNS.filter((pattern) => pattern.test(content)).length >= 2;
}
