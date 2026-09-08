# External handoff ownership watchdog repair

> Execute with subagent-driven-development, test-driven-development and independent spec/code review. Root retains live orchestration and shipment control.

## Goal and evidence

PM codex_1733 waited in the durable App queue without native submission, then Meridian-roles demoted it after 30 minutes even though Hub still held its execution reservation. The hourly native controller had not yet woken. Kill was correctly refused; the lifecycle demotion had already happened. This can reopen the retry gate while an external owner remains live. Product worker codex_1732 had separately ended with a genuine permission/dependency blocker; that is not a timeout defect.

## Decision under owner resolve --auto

Repair shared orchestration ownership, not product cards, controller cadence, Codex permissions, or timeout constants. Longer timeouts merely delay the same ownership error. Caller-name checks would violate the generic-infrastructure law. Use explicit typed external-handoff state from the Hub's authoritative reservation and consume it before stale-PM demotion. Preserve exact terminal receipt reconciliation, CLI stale detection, and validation gates. A closed App is waiting, not evidence of a failed worker.

## Task 1: Typed status contract and stale-owner protection

Hub checkout: /Users/yzliu/work/Meridian/.worktrees/app-receipt-reconciliation (existing PR170 lineage).
Roles checkout: /Users/yzliu/work/Meridian/Meridian-roles/.worktrees/external-handoff-watchdog (codex/external-handoff-watchdog).

1. Run relevant existing tests as baseline. Add red regression tests for two arbitrary worker identities, proving a pending/claimed/started/cancel-requested durable external owner is not PM-demoted or killed merely for old last_seen_at. Prove legacy unreserved no-progress PM demotion still occurs. Invalid/terminal metadata must not suppress valid recovery.
2. Hub status must expose a small, typed, provider-neutral external execution ownership object from actual nonterminal durable queue/active reservation state. Do not expose prompts, final text, receipts, credentials or arbitrary worker content. Cover terminal exclusion, active-run before enqueue if necessary, durable ownership across Hub restart, and status content compatibility with attachment summaries. Use the existing queue implementation; no second queue or identity-string branching.
3. Roles reconciliation must parse/validate this metadata. PM watchdog must preserve authentic external ownership before any no-progress demotion; do not fake last_seen_at, mark complete, weaken all stale detection or infer state from messages. Inspect adjacent worker/validator paths and test any equivalent affected branch. Existing worker receipt ownership guard already protects unreceived worker execution; retain it.
4. Add bounded diagnostic logging so waiting ownership is observable. Cancellation/terminal delivery continues through existing exact-turn protocols. No extra automatic task creation, no native App internal writes.
5. Run focused suites, build/typecheck and proportional full suites. Record red/green proof, inspect diff and self-review. Leave explicit scoped changes for root shipment; do not restart or mutate live services.

## Task 2: Independent acceptance and controlled installation

1. Separate spec-compliance then quality review of both sides of the typed contract; address findings and rerun affected tests.
2. Commit/push only tested paths to each verified origin topic branch. Keep PRs open, no automatic merge or release. Preserve unrelated parent dirty overlay and runtime artifacts.
3. Install only matching-base/known-overlay files and rebuild with Node24. Restart affected services only when every App reservation, PM executor and CLI worker/validator is inactive. If active, defer restart and retain explicit installation hold.
4. Verify live Hub metadata and canonical ownership before claiming runtime repair. Update the original hourly heartbeat and recovery record with exact request/task/turn state. Product acceptance remains independent.
