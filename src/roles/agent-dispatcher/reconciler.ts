import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import type { DispatchWorkerState, HubMessage, HubResult, LifecycleStatus } from "../../types";
import {
  LifecycleStore,
  hubResultContainsBlockSignal,
  hubResultContainsFailureSignal,
  hubResultContainsHitLimit,
  hubResultContainsInlineReport,
  isExplicitCompletionContent,
  isNonCompletionContent,
  shouldRouteCompletedToAwaitingValidation
} from "./lifecycle-store";
import {
  isWorkerToolProcessRunning,
  listActiveProcessCommands,
  loadPlanRowsByWorker,
  resolveDispatchPlanPathFromThreadsPath
} from "./active-tool-process";
import { isMissingThreadEvidence } from "./missing-thread";
import { parseMeridianStatusMarker } from "./meridian-status-marker";
import {
  computeBasenameVariants,
  findExistingOutputArtifactPaths,
  outputArtifactHasPassingDecision,
  outputArtifactHasPassingWorkerMarker,
  outputArtifactsContain,
  outputsExist as outputArtifactsExist,
  sliceContentFromStartedAt
} from "./output-artifacts";

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
  statSync: fs.statSync,
  readdirSync: fs.readdirSync,
  readFileSync: fs.readFileSync
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
  const planRows = loadPlanRowsByWorker(resolveDispatchPlanPathFromThreadsPath(lifecycleStore.filePath));
  const activeProcessCommands = listActiveProcessCommands();

  await reconcileDispatcher(lifecycleStore, state, hubClient, report);

  const RECONCILABLE_STATUSES = new Set<string>(["running", "abandoned"]);

  for (const [workerId, worker] of Object.entries(state.workers)) {
    if (!RECONCILABLE_STATUSES.has(worker.status)) {
      report.unchanged.push(workerId);
      continue;
    }

    const outputsPresent = outputsExist(worker.expected_outputs, worker.started_at);
    const workerToolProcessRunning = isWorkerToolProcessRunning(
      planRows.get(workerId),
      readWorkerScanRunId(worker.command_preamble),
      activeProcessCommands
    );
    const recordedResultTransition = isValidationReworkAwaitingFreshResult(worker, worker.hub_result)
      ? null
      : determineRecordedResultTransition(
        workerId,
        worker.hub_result,
        outputsPresent,
        worker.expected_outputs,
        worker.started_at
      );
    if (recordedResultTransition && shouldApplyWorkerTransition(recordedResultTransition, workerToolProcessRunning)) {
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
    const shouldRecoverHubResult =
      !worker.hub_result
      && (
        (observation.kind === "running" && (outputsPresent || isStale(worker.started_at, nowMs, staleTimeoutMs)))
        || (observation.kind === "idle" && outputsPresent)
        || (!outputsPresent && observation.kind !== "running")
      );
    const recoveredHubResult =
      shouldRecoverHubResult
        ? await recoverHubResultFromHistory(hubClient, worker.thread_id, worker.trace_id, worker.started_at)
        : null;
    const effectiveHubResult = recoveredHubResult ?? worker.hub_result;
    const recoveredTransition = isValidationReworkAwaitingFreshResult(worker, effectiveHubResult)
      ? null
      : determineRecordedResultTransition(
        workerId,
        effectiveHubResult,
        outputsPresent,
        worker.expected_outputs,
        worker.started_at
      );
    if (recoveredTransition && shouldApplyWorkerTransition(recoveredTransition, workerToolProcessRunning)) {
      const terminalTimestamp = effectiveHubResult?.timestamp ?? nowIso;
      const interceptedStatus = applyValidationIntercept(worker, recoveredTransition.to);
      state.workers[workerId] = {
        ...worker,
        trace_id: effectiveHubResult?.trace_id || worker.trace_id,
        last_seen_at: terminalTimestamp,
        status: interceptedStatus,
        hub_result: effectiveHubResult
      };
      const trigger = interceptedStatus === recoveredTransition.to
        ? recoveredTransition.trigger
        : `${recoveredTransition.trigger}:validation_intercept`;
      lifecycleStore.logTransition(workerId, worker.status, interceptedStatus, trigger);
      report.changed.push({
        workerId,
        from: worker.status,
        to: interceptedStatus,
        trigger
      });
      continue;
    }

    const transition = determineWorkerTransition(
      workerId,
      observation,
      outputsPresent,
      effectiveHubResult,
      worker.expected_outputs,
      worker.started_at,
      nowMs,
      staleTimeoutMs,
      workerToolProcessRunning
    );

    if (
      !transition
      || transition.to === worker.status
      || shouldDeferValidationReworkTransition(worker, effectiveHubResult, transition)
      || !shouldApplyWorkerTransition(transition, workerToolProcessRunning)
    ) {
      report.unchanged.push(workerId);
      continue;
    }

    const transitionHubResult = effectiveHubResult ?? synthesizeOutputArtifactHubResult(
      workerId,
      worker,
      transition,
      nowIso
    );
    const interceptedStatus = applyValidationIntercept(worker, transition.to);
    state.workers[workerId] = {
      ...worker,
      trace_id: transitionHubResult?.trace_id || worker.trace_id,
      status: interceptedStatus,
      last_seen_at: transitionHubResult?.timestamp ?? nowIso,
      hub_result: transitionHubResult
    };
    const trigger = interceptedStatus === transition.to
      ? transition.trigger
      : `${transition.trigger}:validation_intercept`;
    lifecycleStore.logTransition(workerId, worker.status, interceptedStatus, trigger);
    report.changed.push({
      workerId,
      from: worker.status,
      to: interceptedStatus,
      trigger
    });
  }

  // Recover missing hub_results for workers that were marked completed by
  // onRestart (via plan evidence such as a merged PR) before the run tool
  // could record the hub_result. Without this pass, the hub_result is
  // permanently lost because the main loop above only processes "running"
  // and "abandoned" workers.
  // Skip workers that were just transitioned in the main loop — their null
  // hub_result is expected (they completed via output/observation evidence).
  const justReconciledWorkerIds = new Set(report.changed.map((change) => change.workerId));
  for (const [workerId, worker] of Object.entries(state.workers)) {
    if (worker.status !== "completed" || worker.hub_result !== null || justReconciledWorkerIds.has(workerId)) {
      continue;
    }

    const recoveredHubResult = await recoverHubResultFromHistory(
      hubClient,
      worker.thread_id,
      worker.trace_id,
      worker.started_at
    );
    if (recoveredHubResult) {
      state.workers[workerId] = {
        ...worker,
        hub_result: recoveredHubResult,
        trace_id: recoveredHubResult.trace_id || worker.trace_id,
        last_seen_at: recoveredHubResult.timestamp ?? worker.last_seen_at
      };
      report.changed.push({
        workerId,
        from: "completed",
        to: "completed",
        trigger: "hub_result_recovery:completed_without_result"
      });
    }
  }

  for (const [workerId, worker] of Object.entries(state.workers)) {
    if (
      (worker.status !== "blocked" && worker.status !== "failed")
      || worker.hub_result !== null
      || justReconciledWorkerIds.has(workerId)
    ) {
      continue;
    }

    const recoveredHubResult = synthesizeOutputArtifactHubResult(
      workerId,
      worker,
      {
        to: worker.status,
        trigger: worker.status === "blocked"
          ? "output_artifact:block_signal"
          : "output_artifact:failure_signal"
      },
      nowIso
    );
    if (recoveredHubResult) {
      state.workers[workerId] = {
        ...worker,
        hub_result: recoveredHubResult,
        trace_id: recoveredHubResult.trace_id || worker.trace_id,
        last_seen_at: recoveredHubResult.timestamp ?? worker.last_seen_at
      };
      report.changed.push({
        workerId,
        from: worker.status,
        to: worker.status,
        trigger: `hub_result_recovery:${worker.status}_without_result`
      });
    }
  }

  // A blocked/failed worker can recover even when its `hub_result` is non-null
  // but stale: PM resolution + validator feedback drive the worker through a
  // fresh attempt that writes a clean `<<<MERIDIAN-STATUS>>> outcome: complete`
  // marker to the report file, but the run-tool callback never delivers the
  // new hub_result (transient IPC/transport drop — same fingerprint as
  // PR #191's C-01). The earlier recovery loops do not catch this:
  //   • The main loop scopes to RECONCILABLE_STATUSES = {running, abandoned}.
  //   • The artifact-synthesis loop above is gated on `hub_result === null`.
  // Without this sweep, the worker stays parked at `blocked` indefinitely
  // even though the on-disk artifact unambiguously shows completion.
  const staleHubResultOverrides = new Map<string, { hubResult: HubResult; staleTimestamp: string | null }>();
  for (const [workerId, worker] of Object.entries(state.workers)) {
    if (
      (worker.status !== "blocked" && worker.status !== "failed")
      || worker.hub_result === null
      || justReconciledWorkerIds.has(workerId)
    ) {
      continue;
    }

    const artifact = readFirstOutputArtifact(worker.expected_outputs, worker.started_at);
    if (!artifact) {
      continue;
    }

    const slice = sliceContentFromStartedAt(artifact.content, worker.started_at);
    if (!outputArtifactHasPassingWorkerMarker(slice, workerId)) {
      continue;
    }

    // Confirm the artifact slice is genuinely newer than the stale hub_result
    // we already have. If every timestamp in the slice predates or matches the
    // stale hub_result, we have nothing new to recover and would re-trigger
    // the recovery on every reconciler tick.
    const staleHubTimestamp = worker.hub_result.timestamp ?? null;
    const staleHubMs = staleHubTimestamp ? Date.parse(staleHubTimestamp) : NaN;
    if (!Number.isNaN(staleHubMs) && !sliceHasTimestampNewerThan(slice, staleHubMs)) {
      continue;
    }

    const synthesized: HubResult = {
      trace_id: worker.trace_id ?? randomUUID(),
      thread_id: worker.thread_id,
      source: "output_artifact",
      status: "success",
      run_state: "completed",
      content: [
        `Recovered ${workerId} result from output artifact: ${artifact.path}`,
        "",
        artifact.content
      ].join("\n"),
      attachments: [
        {
          path: artifact.path,
          filename: path.basename(artifact.path),
          mime_type: "text/markdown"
        }
      ],
      timestamp: nowIso
    };
    const nextStatus: LifecycleStatus = worker.validation ? "awaiting_validation" : "completed";
    const trigger = `output_artifact:passing_worker_marker:postdates_stale_hub_result`;
    const fromStatus = worker.status;
    state.workers[workerId] = {
      ...worker,
      trace_id: synthesized.trace_id,
      status: nextStatus,
      last_seen_at: nowIso,
      hub_result: synthesized
    };
    staleHubResultOverrides.set(workerId, { hubResult: synthesized, staleTimestamp: staleHubTimestamp });
    lifecycleStore.logTransition(workerId, fromStatus, nextStatus, trigger);
    report.changed.push({
      workerId,
      from: fromStatus,
      to: nextStatus,
      trigger
    });
  }

  // Re-read the fresh state before saving to avoid overwriting concurrent writes
  // from the run tool (fire-and-forget worker completions that landed between our
  // initial load and now). We merge only the reconciler's status transitions into
  // the fresh state, preserving any hub_result that was written concurrently.
  const freshState = lifecycleStore.load();
  freshState.last_reconciled_at = nowIso;

  for (const change of report.changed) {
    if (change.workerId === DISPATCHER_ENTRY_ID) {
      freshState.dispatcher = state.dispatcher;
      continue;
    }

    const reconciledWorker = state.workers[change.workerId];
    if (!reconciledWorker) {
      continue;
    }

    const freshWorker = freshState.workers[change.workerId];
    // For the stale-hub-result-override path, the synthesized hub_result must
    // win against the freshState's stale one — but only if freshState still
    // shows the same stale timestamp (i.e. no concurrent run-tool write
    // landed). If freshState now has a different hub_result, the run tool
    // delivered a real reply between our load and merge; that one wins.
    const override = staleHubResultOverrides.get(change.workerId);
    const freshShowsSameStaleResult =
      override
      && (freshWorker?.hub_result?.timestamp ?? null) === override.staleTimestamp;
    const mergedHubResult = freshShowsSameStaleResult
      ? override!.hubResult
      : freshWorker?.hub_result ?? reconciledWorker.hub_result ?? null;
    freshState.workers[change.workerId] = {
      ...(freshWorker ?? reconciledWorker),
      status: reconciledWorker.status,
      last_seen_at: reconciledWorker.last_seen_at,
      trace_id: reconciledWorker.trace_id || freshWorker?.trace_id || null,
      // Prefer the fresh hub_result (written by the run tool concurrently) over the
      // reconciler's stale view. Fall back to the reconciler's recovered result if
      // no concurrent write occurred. The stale-override path above intentionally
      // replaces a known-stale fresh hub_result with the synthesized one.
      hub_result: mergedHubResult
    };
  }

  lifecycleStore.save(freshState);
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
  workerId: string,
  observation: HubThreadObservation,
  outputsPresent: boolean,
  hubResult: HubResult | null,
  expectedOutputs: string[],
  startedAt: string,
  nowMs: number,
  staleTimeoutMs: number,
  workerToolProcessRunning: boolean
): Pick<ReconciliationChange, "to" | "trigger"> | null {
  const hasInlineReport = hubResult ? hubResultContainsInlineReport(hubResult) : false;
  const requiresExpectedOutput = expectedOutputs.length > 0;
  const hasWorkerInlineReport = hasInlineReport && hubResult !== null && hubResultReferencesWorker(hubResult, workerId);

  // When hub_result is null the run-tool relay timed out before receiving a
  // terminal response — the worker may still be actively executing. An "idle"
  // thread observation is unreliable in this case: the hub can briefly report
  // "idle" between tool calls while the agent is still working. Only trust a
  // definitive "completed" observation when there is no hub_result; "idle" is
  // only strong enough evidence when a hub_result already confirmed the run
  // finished.
  const trustIdleAsTerminal = hubResult !== null;

  if (hubResult && hubResultContainsFailureSignal(hubResult)) {
    if (hubResultContainsBlockSignal(hubResult)) {
      return {
        to: "blocked",
        trigger: "hub_result:block_signal"
      };
    }

    return {
      to: "failed",
      trigger: "hub_result:failure_signal"
    };
  }

  // Worker output contains BLOCKED or PAUSE markers — the worker explicitly
  // signalled that its task cannot proceed. Do not auto-complete regardless of
  // thread observation, outputs, or inline reports.
  if (hubResult && isNonCompletionContent(hubResult.content)) {
    return null;
  }

  if (observation.kind === "failed") {
    return {
      to: "failed",
      trigger: `hub_status:${observation.rawStatus ?? "failed"}`
    };
  }

  if (workerToolProcessRunning) {
    return null;
  }

  if (outputsPresent && outputArtifactsContainBlockSignal(expectedOutputs, startedAt, workerId)) {
    return {
      to: "blocked",
      trigger: "output_artifact:block_signal"
    };
  }

  if (outputsPresent && outputArtifactsContainFailureSignal(expectedOutputs, startedAt, workerId)) {
    return {
      to: "failed",
      trigger: "output_artifact:failure_signal"
    };
  }

  if (
    outputsPresent
    && !hubResult
    && (observation.kind === "running" || observation.kind === "idle")
    && isStale(startedAt, nowMs, staleTimeoutMs)
    && outputArtifactsContainCompletionSignal(expectedOutputs, workerId, startedAt)
  ) {
    return {
      to: "completed",
      trigger: "output_artifact:completion_signal:stale"
    };
  }

  if (observation.kind === "completed" && outputsPresent) {
    return {
      to: "completed",
      trigger: `hub_status:${observation.rawStatus ?? observation.kind}:outputs_present`
    };
  }

  if (observation.kind === "idle" && trustIdleAsTerminal && outputsPresent) {
    return {
      to: "completed",
      trigger: `hub_status:${observation.rawStatus ?? observation.kind}:outputs_present`
    };
  }

  if (observation.kind === "completed" && hasInlineReport && (!requiresExpectedOutput || hasWorkerInlineReport)) {
    return {
      to: "completed",
      trigger: `hub_status:${observation.rawStatus ?? observation.kind}:inline_report`
    };
  }

  if (observation.kind === "idle" && trustIdleAsTerminal && hasInlineReport && (!requiresExpectedOutput || hasWorkerInlineReport)) {
    return {
      to: "completed",
      trigger: `hub_status:${observation.rawStatus ?? observation.kind}:inline_report`
    };
  }

  // Lightweight tasks (e.g. PRE-FLIGHT) may complete without producing output
  // files or inline reports. When the hub confirms the thread is terminal and
  // we already have a success hub_result, trust that as completed.
  if (
    (observation.kind === "completed" || (observation.kind === "idle" && trustIdleAsTerminal))
    && hubResult?.status === "success"
    && (!hubResult.run_state || hubResult.run_state === "completed")
    && (!requiresExpectedOutput || hubResultReferencesWorker(hubResult, workerId))
  ) {
    return {
      to: "completed",
      trigger: `hub_status:${observation.rawStatus ?? observation.kind}:success_result`
    };
  }

  if (observation.kind === "missing") {
    if (outputsPresent) {
      return {
        to: "completed",
        trigger: "thread_missing:outputs_present"
      };
    }

    if (hasInlineReport && (!requiresExpectedOutput || hasWorkerInlineReport)) {
      return {
        to: "completed",
        trigger: "thread_missing:inline_report"
      };
    }

    // Thread is gone but the hub confirmed success before the thread
    // disappeared (e.g. killed during restart or cleanup). Trust the hub's
    // success signal — the work was done. Without this, the worker stays
    // "running" until stale timeout, then becomes "abandoned" and gets
    // re-dispatched in an infinite loop.
    if (
      hubResult?.status === "success"
      && (!hubResult.run_state || hubResult.run_state === "completed")
      && (!requiresExpectedOutput || hubResultReferencesWorker(hubResult, workerId))
    ) {
      return {
        to: "completed",
        trigger: "thread_missing:success_result"
      };
    }

    // Thread is confirmed gone by the hub with no evidence of completion.
    // Abandon immediately — the 30-minute stale timeout only makes sense
    // when we cannot determine the thread's state (e.g. hub unreachable).
    // When the hub explicitly says "not found", waiting is pointless and
    // blocks the dispatcher from retrying the worker.
    return {
      to: "abandoned",
      trigger: "thread_missing:no_evidence"
    };
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

function synthesizeOutputArtifactHubResult(
  workerId: string,
  worker: DispatchWorkerState,
  transition: Pick<ReconciliationChange, "to" | "trigger">,
  nowIso: string
): HubResult | null {
  if (transition.trigger !== "output_artifact:block_signal" && transition.trigger !== "output_artifact:failure_signal") {
    return null;
  }

  const artifact = readFirstOutputArtifact(worker.expected_outputs, worker.started_at);
  if (!artifact) {
    return null;
  }
  const hasExpectedSignal = transition.trigger === "output_artifact:block_signal"
    ? hubResultContainsBlockSignal({ content: artifact.content })
    : hubResultContainsFailureSignal({ content: artifact.content });
  if (!hasExpectedSignal) {
    return null;
  }

  return {
    trace_id: worker.trace_id ?? randomUUID(),
    thread_id: worker.thread_id,
    source: "output_artifact",
    status: transition.to === "failed" ? "error" : "success",
    run_state: "completed",
    content: [
      `Recovered ${workerId} result from output artifact: ${artifact.path}`,
      "",
      artifact.content
    ].join("\n"),
    attachments: [
      {
        path: artifact.path,
        filename: path.basename(artifact.path),
        mime_type: "text/markdown"
      }
    ],
    timestamp: nowIso
  };
}

// Returns true when the provided text contains at least one ISO 8601 timestamp
// strictly newer than `referenceMs`. Used to confirm that a recovered artifact
// slice represents a fresh attempt and not the same content the stale
// hub_result already reflected.
function sliceHasTimestampNewerThan(slice: string, referenceMs: number): boolean {
  if (Number.isNaN(referenceMs)) {
    return true;
  }
  const isoPattern = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\b/g;
  let match: RegExpExecArray | null;
  while ((match = isoPattern.exec(slice)) !== null) {
    const ts = Date.parse(match[1]!);
    if (!Number.isNaN(ts) && ts > referenceMs) {
      return true;
    }
  }
  return false;
}

function readFirstOutputArtifact(
  expectedOutputs: string[],
  startedAt: string
): { path: string; content: string } | null {
  for (const outputPath of expectedOutputs) {
    const artifactPath = findExistingOutputArtifactPaths(outputPath, startedAt, reconciliationFs)[0];
    if (!artifactPath) {
      continue;
    }

    try {
      return {
        path: artifactPath,
        content: reconciliationFs.readFileSync(artifactPath, "utf8")
      };
    } catch {
      continue;
    }
  }

  return null;
}

// Terminal lifecycle statuses that must not be assigned while the worker's
// underlying tool process is still alive. Hub-side state (failed / missing /
// idle-stale) can lie when the agentapi has been unregistered or its SSE has
// flapped, but the codex/claude/gemini CLI subprocess is still running and
// emitting output. Marking the worker terminal in that window causes the
// watchdog to spawn a duplicate worker thread on top of a still-live process.
const PROCESS_GUARDED_TERMINAL_STATUSES = new Set<LifecycleStatus>([
  "completed",
  "failed",
  "abandoned",
  "blocked"
]);

function shouldApplyWorkerTransition(
  transition: Pick<ReconciliationChange, "to" | "trigger">,
  workerToolProcessRunning: boolean
): boolean {
  if (!workerToolProcessRunning) {
    return true;
  }
  return !PROCESS_GUARDED_TERMINAL_STATUSES.has(transition.to);
}

// Mirrors the awaiting_validation intercept that lifecycle-store.recordWorkerResult
// applies when a hub_result lands directly. Without this, reconciler-driven
// completions (via output-artifact / hub-status / inline-report evidence) skip
// validation entirely: the worker jumps to "completed" and the validator
// orchestrator never spawns. Observed on V-03-A 2026-05-07.
function applyValidationIntercept(
  worker: DispatchWorkerState,
  nextStatus: LifecycleStatus
): LifecycleStatus {
  if (nextStatus === "completed" && shouldRouteCompletedToAwaitingValidation(worker)) {
    return "awaiting_validation";
  }
  return nextStatus;
}

function shouldDeferValidationReworkTransition(
  worker: DispatchWorkerState,
  hubResult: HubResult | null,
  transition: Pick<ReconciliationChange, "to" | "trigger">
): boolean {
  return transition.to === "completed" && isValidationReworkAwaitingFreshResult(worker, hubResult);
}

function isValidationReworkAwaitingFreshResult(
  worker: DispatchWorkerState,
  hubResult: HubResult | null
): boolean {
  if (!worker.validation || worker.status !== "running") {
    return false;
  }

  if (!hasValidationFeedbackCycle(worker.validation)) {
    return false;
  }

  if (!hubResult?.timestamp) {
    return true;
  }

  const resultMs = Date.parse(hubResult.timestamp);
  const lastSeenMs = Date.parse(worker.last_seen_at);
  if (!Number.isFinite(resultMs) || !Number.isFinite(lastSeenMs)) {
    return true;
  }

  return resultMs < lastSeenMs;
}

function hasValidationFeedbackCycle(validation: NonNullable<DispatchWorkerState["validation"]>): boolean {
  return validation.current_cycle > 0
    || typeof validation.last_score === "number"
    || typeof validation.last_feedback === "string"
    || validation.history.length > 0;
}

function readWorkerScanRunId(commandPreamble: string | null | undefined): string | null {
  const match = commandPreamble?.match(/(?:^|\n)\s*SCAN_RUN_ID:\s*([^\s]+)/);
  return match?.[1] ?? null;
}

function determineRecordedResultTransition(
  workerId: string,
  hubResult: HubResult | null,
  outputsPresent: boolean,
  expectedOutputs: string[],
  startedAt: string
): Pick<ReconciliationChange, "to" | "trigger"> | null {
  if (!hubResult) {
    return null;
  }

  if (outputsPresent && outputArtifactsContainBlockSignal(expectedOutputs, startedAt, workerId)) {
    return {
      to: "blocked",
      trigger: "output_artifact:block_signal"
    };
  }

  if (outputsPresent && outputArtifactsContainFailureSignal(expectedOutputs, startedAt, workerId)) {
    return {
      to: "failed",
      trigger: "output_artifact:failure_signal"
    };
  }

  if (hubResult.status === "timeout" || hubResult.run_state === "timeout") {
    // A timeout hub_result may be a synthetic marker from the run tool when the
    // HTTP relay timed out, NOT proof that the worker itself failed. If the
    // expected outputs are present the worker completed successfully despite
    // the relay timeout — honour the actual evidence over the stale marker.
    if (outputsPresent) {
      return {
        to: "completed",
        trigger: "hub_result:timeout:outputs_present"
      };
    }

    return {
      to: "failed",
      trigger: "hub_result:timeout"
    };
  }

  const markerTransition = determineWorkerMarkerTransition(
    workerId,
    hubResult,
    outputsPresent,
    expectedOutputs,
    startedAt
  );
  if (markerTransition) {
    return markerTransition;
  }

  if (hubResultContainsHitLimit(hubResult)) {
    return {
      to: "failed",
      trigger: "hub_result:hit_limit"
    };
  }

  if (hubResultContainsBlockSignal(hubResult)) {
    return {
      to: "blocked",
      trigger: "hub_result:block_signal"
    };
  }

  if (hubResultContainsFailureSignal(hubResult)) {
    return {
      to: "failed",
      trigger: "hub_result:failure_signal"
    };
  }

  // Worker output contains PAUSE markers — the worker explicitly signalled
  // that its task cannot proceed yet. Do not transition to "completed"
  // regardless of other evidence (outputs, inline reports, success status).
  if (isNonCompletionContent(hubResult.content)) {
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

    if (expectedOutputs.length > 0) {
      if (reportedOutputsExist(hubResult, expectedOutputs, startedAt)) {
        return {
          to: "completed",
          trigger: "hub_result:reported_outputs_present"
        };
      }

      if (hubResultContainsInlineReport(hubResult) && hubResultReferencesWorker(hubResult, workerId)) {
        return {
          to: "completed",
          trigger: "hub_result:inline_report"
        };
      }

      if (isExplicitCompletionContent(hubResult.content) && hubResultReferencesWorker(hubResult, workerId)) {
        return {
          to: "completed",
          trigger: "hub_result:explicit_completion_content"
        };
      }

      return null;
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

  // Trust explicit completion markers (✅ + "complete") even when run_state
  // is "still_running" — the worker finished its task but the thread is alive.
  if (hubResult.status === "success" && isExplicitCompletionContent(hubResult.content)) {
    if (expectedOutputs.length > 0 && !hubResultReferencesWorker(hubResult, workerId)) {
      return null;
    }

    return {
      to: "completed",
      trigger: "hub_result:explicit_completion_content"
    };
  }

  return null;
}

function determineWorkerMarkerTransition(
  workerId: string,
  hubResult: HubResult,
  outputsPresent: boolean,
  expectedOutputs: string[],
  startedAt: string
): Pick<ReconciliationChange, "to" | "trigger"> | null {
  const marker = parseMeridianStatusMarker(combineHubResultText(hubResult));
  if (!marker || marker.role !== "worker" || marker.worker_id !== workerId) {
    return null;
  }

  switch (marker.outcome) {
    case "complete":
      if (
        outputsPresent
        || expectedOutputs.length === 0
        || reportedOutputsExist(hubResult, expectedOutputs, startedAt)
        || (
          typeof marker.report_path === "string"
          && outputArtifactsExist([marker.report_path], startedAt, reconciliationFs)
          && reportedOutputMatchesExpected(marker.report_path, expectedOutputs)
        )
      ) {
        return {
          to: "completed",
          trigger: "hub_result:marker_complete"
        };
      }
      return null;
    case "failed":
    case "hit_limit":
      return {
        to: "failed",
        trigger: `hub_result:marker_${marker.outcome}`
      };
    case "blocked":
    case "needs_pm":
      return {
        to: "blocked",
        trigger: `hub_result:marker_${marker.outcome}`
      };
  }
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
  traceId: string | null,
  startedAt: string | null
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
  const finalReplyEntry = findLatestFinalReplyEntry(historyEntries, traceId, startedAt);
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
  traceId: string | null,
  startedAt: string | null
): ConversationHistoryEntry | null {
  const normalizedTraceId = normalizeOptionalTraceId(traceId);
  const startedAtMs = parseIsoTimestampMs(startedAt);
  let attemptFallback: ConversationHistoryEntry | null = null;

  for (let index = historyEntries.length - 1; index >= 0; index -= 1) {
    const entry = historyEntries[index];
    if (!entry || entry.event_kind !== "final_reply") {
      continue;
    }

    const rawContent = normalizeHistoryText(entry.raw_content);
    const detailsText = normalizeHistoryText(entry.details_text);
    const content = normalizeHistoryText(entry.content);
    if (!rawContent && !detailsText && !content) {
      continue;
    }

    const entryTraceId = normalizeOptionalTraceId(entry.trace_id);
    if (normalizedTraceId) {
      if (entryTraceId === normalizedTraceId) {
        return entry;
      }

      if (!attemptFallback && occurredAtOrAfterAttemptStart(entry.timestamp, startedAtMs)) {
        attemptFallback = entry;
      }
      continue;
    }

    if (!startedAtMs || occurredAtOrAfterAttemptStart(entry.timestamp, startedAtMs)) {
      return entry;
    }
  }

  return attemptFallback;
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

function normalizeOptionalTraceId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIsoTimestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function occurredAtOrAfterAttemptStart(entryTimestamp: string | undefined, startedAtMs: number | null): boolean {
  if (startedAtMs === null) {
    return true;
  }

  if (typeof entryTimestamp !== "string" || entryTimestamp.trim().length === 0) {
    return false;
  }

  const entryTimestampMs = Date.parse(entryTimestamp);
  return Number.isFinite(entryTimestampMs) && entryTimestampMs >= startedAtMs;
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

function outputsExist(paths: string[], startedAt?: string): boolean {
  return outputArtifactsExist(paths, startedAt, reconciliationFs);
}

function outputArtifactsContainFailureSignal(
  paths: string[],
  startedAt?: string,
  workerId?: string
): boolean {
  return outputArtifactsContain(
    paths,
    (content) => {
      const currentAttemptContent = sliceContentFromStartedAt(content, startedAt);
      if (workerId && outputArtifactHasPassingWorkerMarker(currentAttemptContent, workerId)) {
        return false;
      }
      return !outputArtifactHasPassingDecision(currentAttemptContent)
        && hubResultContainsFailureSignal({ content: currentAttemptContent });
    },
    startedAt,
    reconciliationFs
  );
}

function outputArtifactsContainBlockSignal(
  paths: string[],
  startedAt?: string,
  workerId?: string
): boolean {
  return outputArtifactsContain(
    paths,
    (content) => {
      const currentAttemptContent = sliceContentFromStartedAt(content, startedAt);
      if (workerId && outputArtifactHasPassingWorkerMarker(currentAttemptContent, workerId)) {
        return false;
      }
      return !outputArtifactHasPassingDecision(currentAttemptContent)
        && hubResultContainsBlockSignal({ content: currentAttemptContent });
    },
    startedAt,
    reconciliationFs
  );
}

function outputArtifactsContainCompletionSignal(paths: string[], workerId: string, startedAt?: string): boolean {
  return outputArtifactsContain(
    paths,
    (content) => outputArtifactHasCompletionSignal(sliceContentFromStartedAt(content, startedAt), workerId),
    startedAt,
    reconciliationFs
  );
}

function outputArtifactHasCompletionSignal(content: string, workerId: string): boolean {
  if (outputArtifactReferencesWorker(content, workerId) && outputArtifactHasPassingDecision(content)) {
    return true;
  }

  return outputArtifactReferencesWorker(content, workerId)
    && /^#\s+.*\bCompletion Report\b/im.test(content)
    && validationSectionHasPassingEvidence(content)
    && !isNonCompletionContent(content)
    && !hubResultContainsBlockSignal({ content });
}

function validationSectionHasPassingEvidence(content: string): boolean {
  const section = extractMarkdownSection(content, "Validation") ?? content;
  return (/\bPASS\b/.test(section) || /✅/.test(section))
    && !/(?:^|\n)\s*(?:[-*]\s*)?.*\bFAIL\b/i.test(section);
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const headingPattern = new RegExp(`^#{2,6}\\s+${escapeRegExp(heading)}\\s*$`, "i");
  let startIndex = -1;
  let headingLevel = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const match = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    if (startIndex === -1 && headingPattern.test(line)) {
      startIndex = index + 1;
      headingLevel = match[1]?.length ?? 0;
      continue;
    }

    if (startIndex !== -1 && (match[1]?.length ?? 0) <= headingLevel) {
      return lines.slice(startIndex, index).join("\n");
    }
  }

  return startIndex === -1 ? null : lines.slice(startIndex).join("\n");
}

function outputArtifactReferencesWorker(content: string, workerId: string): boolean {
  const normalizedWorkerId = workerId.trim();
  if (normalizedWorkerId.length === 0) {
    return false;
  }

  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(normalizedWorkerId)}($|[^A-Za-z0-9_-])`, "i")
    .test(content);
}

function reportedOutputsExist(hubResult: HubResult, expectedOutputs: string[] = [], startedAt?: string): boolean {
  return extractReportedOutputPaths(hubResult).some((filePath) => {
    if (!reportedOutputMatchesExpected(filePath, expectedOutputs)) {
      return false;
    }

    if (!isCompletionArtifactPath(filePath)) {
      return false;
    }

    return outputArtifactsExist([filePath], startedAt, reconciliationFs);
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

function reportedOutputMatchesExpected(reportedPath: string, expectedOutputs: string[]): boolean {
  if (expectedOutputs.length === 0) {
    return true;
  }

  const reportedBasename = path.basename(reportedPath).toLowerCase();
  return expectedOutputs.some((expectedOutput) => {
    const expectedBasename = path.basename(expectedOutput).toLowerCase();
    return computeBasenameVariants(expectedBasename)
      .map((variant) => variant.toLowerCase())
      .includes(reportedBasename);
  });
}

function hubResultReferencesWorker(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">,
  workerId: string
): boolean {
  const normalizedWorkerId = workerId.trim();
  if (normalizedWorkerId.length === 0) {
    return false;
  }

  const combinedContent = [
    hubResult.content,
    hubResult.summary_text,
    hubResult.details_text
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
  if (combinedContent.length === 0) {
    return false;
  }

  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(normalizedWorkerId)}($|[^A-Za-z0-9_-])`, "i")
    .test(combinedContent);
}

function combineHubResultText(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">
): string {
  return [
    hubResult.content,
    hubResult.summary_text,
    hubResult.details_text
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
