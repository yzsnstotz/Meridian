import assert from "node:assert/strict";
import { test } from "node:test";
import { appHandoffExecution } from "./codex-app-delivery";
import type { AppHandoffRequest } from "./codex-app-queue";

const at = "2026-09-09T01:00:00.000Z";
const native = "01a07727-ac38-7c23-8ef3-4bc90f594b9a";
const base: AppHandoffRequest = { id: "opaque-request", workerId: "unrelated-consumer", cwd: "/private",
  prompt: "never expose prompt", receipt: "never expose receipt", progress: "never expose progress",
  submissionAttempted: false, state: "pending", createdAt: at, updatedAt: at, history: [{ state: "pending", at }] };

test("delivery reflects queued, claimed, submitted, exact started and cancellation without private content", () => {
  for (const workerId of ["consumer-42", "opaque-other"]) {
    const r = { ...base, workerId };
    assert.equal(appHandoffExecution(r)?.delivery_phase, "queued");
    assert.equal(appHandoffExecution({ ...r, state: "claimed", threadId: native })?.delivery_phase, "claimed");
    assert.equal(appHandoffExecution({ ...r, state: "claimed", submissionAttempted: true, submittedAt: at })?.delivery_phase, "submitted");
    const started = { ...r, state: "started" as const, submissionAttempted: true, threadId: native, turnId: "exact-turn",
      submittedAt: at, startedAt: at, lastObservedAt: at };
    const execution = appHandoffExecution(started)!;
    assert.equal(execution.delivery_phase, "running");
    assert.equal(execution.native_turn_id, "exact-turn");
    assert.equal(execution.last_observed_at, at);
    assert.doesNotMatch(JSON.stringify(execution), /private|never expose|consumer/);
    assert.equal(appHandoffExecution({ ...started, state: "cancel_requested" })?.delivery_phase, "cancel_requested");
    for (const state of ["completed", "failed", "cancelled"] as const)
      assert.equal(appHandoffExecution({ ...started, state }), undefined);
  }
});

test("legacy records preserve only reconstructable timestamps and cannot invent native execution", () => {
  const legacy = { ...base, state: "started" as const, submissionAttempted: true,
    threadId: native, turnId: "legacy-turn", updatedAt: "2026-09-09T03:00:00.000Z", history: [{ state: "started" as const, at }] };
  const execution = appHandoffExecution(legacy)!;
  assert.equal(execution.started_at, at);
  assert.equal(execution.submitted_at, undefined);
  assert.equal(execution.last_observed_at, undefined, "queue bookkeeping is not native progress");
  assert.equal(appHandoffExecution({ ...legacy, turnId: undefined })?.delivery_phase, "submitted");
  assert.equal(appHandoffExecution({ ...base, createdAt: "bad date" })?.enqueued_at, undefined);
});
