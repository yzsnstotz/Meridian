import { ExternalExecutionOwnershipSchema, type ExternalExecutionOwnership } from "../types";
import type { AppHandoffRequest } from "./codex-app-queue";

/** Public ownership evidence only; never project private queue content. */
export function appHandoffExecution(record: AppHandoffRequest): ExternalExecutionOwnership | undefined {
  const core = ExternalExecutionOwnershipSchema.safeParse({
    kind: "external_handoff", state: record.state, request_id: record.id
  });
  if (!core.success) return undefined;
  const execution = core.data;
  const bound = Boolean(record.threadId && record.turnId);
  execution.delivery_phase = record.state === "cancel_requested" ? "cancel_requested"
    : record.state === "started" && bound ? "running"
    : record.submissionAttempted ? "submitted"
    : record.state === "pending" ? "queued" : "claimed";
  const iso = (value?: string): string | undefined =>
    value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  execution.enqueued_at = iso(record.createdAt);
  execution.submitted_at = iso(record.submittedAt);
  execution.started_at = iso(record.startedAt ?? record.history.find(item => item.state === "started")?.at);
  execution.last_observed_at = iso(record.lastObservedAt);
  if (record.threadId) execution.native_thread_id = record.threadId;
  if (record.turnId) execution.native_turn_id = record.turnId;
  return ExternalExecutionOwnershipSchema.parse(execution);
}
