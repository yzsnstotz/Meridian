# App delivery progression implementation plan

> **For agentic workers:** Use subagent-driven-development for the isolated Roles work and two-stage review. Parent owns Hub/controller changes, scheduling, delivery and safe installation.

**Goal:** New downstream and same-worker repair requests automatically reach the native App without waiting for a deep resolver audit, while users see their actual delivery phase and existing ownership protections remain intact.

**Architecture:** Retain the existing durable queue, one native controller, and exact terminal reconciler. Add additive provider-neutral delivery metadata to Hub status, consume it in Roles status/UI, and provide durable controller-duty checkpoints so a short native heartbeat services delivery first while full audits remain hourly. Do not invent an event-wake API, alternate executor, permission setter, or new dispatcher.

**Tech stack:** TypeScript, Zod, Node24, node:test, Vitest; native Codex heartbeat tools.

## Approved scope and evidence

Owner approved implementation, origin push, safe Meridian restart and scheduled-resolver validation after the prior three-part proposal. Existing incident timeline is /Users/yzliu/work/docs/cyberent/branch/cyberent-f1-2026-09-06/investigate/2026-09-08-resolver-takeover/2026-09-09-app-queue-delivery-gap.md.1736 returned in13seconds and passed validation; the next1748 request waited44minutes for native delivery. Earlier d1c0caf terminal/ownership repair remains required and is not the delivery-driver fix.

Read contract: docs/codex-app-worker-handoff.md in full; current queue/executor/router and Roles dispatch-status paths. Applied law: generic-infra-no-caller-identity-branching, all32lines read. Consumers include both new workers and validation rework, and independent PM tasks. No Cyberent product intent, row, dependency, assertion or acceptance changes are authorized by this implementation plan. No native Codex state/binary edits. App catalog/profile limitations remain distinct.

## Task1 — truthful Hub delivery metadata

Files: src/types.ts, src/agents/codex-app-queue.ts and tests, new src/agents/codex-app-delivery.ts and tests, src/hub/router.ts and tests.

- [ ] Add failing tests for pending→queued, claimed/unsubmitted→claimed, claimed/submitted→submitted, exact started→running, cancellation retention, old terminal then new pending, and secret omission. Use two unrelated worker identifiers.
- [ ] Add optional durable submittedAt and startedAt timestamps; set once on real transition, never on observe. Legacy timestamps remain unknown when not reconstructable. Expose this additive status shape:

```ts
type DeliveryPhase = 'queued' | 'claimed' | 'submitted' | 'running' | 'cancel_requested';
// execution.kind/state/request_id remain unchanged and continue reserving capacity.
type Delivery = {
  delivery_phase: DeliveryPhase;
  enqueued_at?: string;
  submitted_at?: string;
  started_at?: string;
  last_observed_at?: string;
  native_thread_id?: string;
  native_turn_id?: string;
};
```

- [ ] Map current nonterminal queue ownership to this metadata. Do not equate lifecycle trace_id with queue request_id. No prompt, receipt, final or credential is public metadata. Thread binding alone is not running. Before durable queue creation use queued with unknown timestamps.
- [ ] Run `node --test --import tsx src/agents/codex-app-queue.test.ts src/agents/codex-app-delivery.test.ts src/hub/router.test.ts` using pinned Node24; observe RED before implementation and GREEN afterward. Full Hub suite/build follows integration.

## Task2 — Roles/UI projection without weakening ownership

Worktree: /Users/yzliu/work/Meridian/Meridian-roles/.worktrees/external-handoff-watchdog, existing branch codex/external-handoff-watchdog.
Files: src/roles/agent-dispatcher/reconciler.ts typed parser as necessary; src/tool-gateway/tools/dispatch-status.ts and tests; src/server/role-handlers.ts; actual src/web/public dispatcher renderer and its tests.

- [ ] Add failing tests for old lifecycle running with live Hub queued/submitted metadata, true native running with a recent real observation, a PM owner, lookup failure, and legacy metadata. Preserve canonical lifecycle/slot/validator behavior and current accepted rows.
- [ ] Resolve delivery via existing MeridianApiClient status, not direct queue filesystem access. Use active_owner_thread_id, not a stale worker id when validator/PM owns the row. Bound lookups and failure handling. Hub unavailability must not produce a delivered/running claim or release ownership.
- [ ] Add execution phase/request/native identity/timing and delivery-overdue diagnostic to status and HTTP row projection. Render waiting for App delivery separately from Running. Existing lifecycle_status stays authoritative for scheduling; summary.running can remain reserved count with an explicit separate execution count/label if needed. Use actual observed timestamps rather than fabricating worker heartbeat updates.
- [ ] Rename the premature validator_feedback_delivered transition reason to a reservation/submission reason; do not replace the safe running ownership state with pending.
- [ ] Tests execute the real rendering helper and status path for at least two opaque identities, no id-prefix branches. Run focused Vitest regressions and typecheck/build. Commit exact owned paths only; no push/restart from subagent.

## Task3 — bounded controller duties and native schedule

Files: new src/agents/codex-app-controller.ts and tests, docs/codex-app-worker-handoff.md.

- [ ] Test controller scan returns compact pending/submission/terminal-reconciliation actions with no prompt/receipt/final text; it cannot claim/submit on its own. Test hourly audit checkpoint persists across process restart, malformed state fails visibly, and a concurrent check does not fabricate an audit completion.
- [ ] Store controller state outside queue .json record enumeration, private mode0600 with atomic fsync and lock. Commands `check CONTROLLER` and `audit-complete CONTROLLER` distinguish actual scan liveness from completed deep audit; only the latter moves lastAuditCompletedAt. A scan never updates worker progress or queue ownership.
- [ ] Document queue-first duties, native-only calls, exact claim→submit→receipt→bind→started→complete, handling every independent ready request, and deep audit after urgent delivery only when due. No automatic uncertain resend; no duplicate controller.
- [ ] Update existing cyberent-meridian heartbeat, not create another: use a short supported cadence (initial target2minutes), preserve target task, quiet unchanged behavior and existing scope/security gates. Verify native update saved successfully; if cadence rejected inspect supported options rather than claiming activation. Hourly deep audit is determined by durable checkpoint.

## Task4 — review, origin push, install and scheduled acceptance

- [ ] Independent spec review first, quality review second. Fix any concrete finding and rerun the relevant tests. Full Hub suite/build, focused Roles suites plus build and documented pre-existing full-suite failures.
- [ ] Push only existing topic branches to origin; read remote SHAs back. Do not merge PRs, force-push, change main, or include unrelated dirty overlays.
- [ ] Capture exact installed/live diff, runtime process identities and all active owners. Allow current gate/validator/PM to finish. Pause only canonical dispatch scheduling for the short installation window; do not terminate a worker to make a window. Pending reservations cannot be deleted or ignored.
- [ ] Apply only reviewed topic source deltas to matching live bases using apply_patch, preserving unrelated changes; build pinned Node24, compare source and compiled artifact hashes, restart only affected services with existing runtime configuration. Verify replacement PIDs/listeners, Hub native execution metadata and Roles HTTP/rendered status. Resume original dispatcher.
- [ ] Existing scheduled resolver must observe real completion→independent validation→new downstream/repair request→native start without a manual send. Record request/turn ids, enqueue/start/terminal/validation times, scheduler invocation and lag. No ready request means this E2E acceptance remains pending, not passed. Run duplicate/ambiguous/cancel/restart tests in isolated fixtures, never on live workers.

## Residue and limits

No new dispatcher, alternate queue, CLI fallback, or native permission/catalog workaround. Long-term event wake remains outside this bounded patch until a supported consumer exists. Main and topic checkouts differ through intentional prior overlays; deployment must compare explicit paths rather than overwrite entire trees. The old terminal repair, policy-intent transport and new delivery projection are distinct claims and require separate evidence.

## Implementation evidence (2026-09-09 04:36 UTC)

Hub Tasks1/3 code is implemented. Initial timestamp/status tests failed as expected, then passed; HTTP bridge and controller duty tests also had observed RED before implementation. Spec review found legacy same-turn timestamp replay and missing concurrent coverage; the added legacy regression reproduced the defect, then passed after preserving original or unknown timestamps without fake history. Independent spec re-review18/18 and quality review13 unique focused cases passed. Recursive discovery of all91 Hub test files passed934/934; pinned Node24 production build passed. `npm test` alone covers only825 cases due to its shallower shell glob, so the recursive run is the acceptance evidence. Tests use isolated queues, not production requests.

Origin push, live installation, Roles completion and real scheduled-resolver E2E are still pending at this checkpoint. No service restart or scheduled acceptance is implied by these code/test results.
