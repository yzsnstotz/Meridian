# Native error-only terminal propagation

## Evidence and scope

The exact native turn `01a087de-52ab-71e0-9b5c-47494bf912d9` ended with `task_complete`, `last_agent_message: null`, and an error object at 2026-09-09T21:10:02.698Z. The observer ignored the error, its TypeScript schema rejected null, and the executor threw a transport exception after the durable request was manually completed as failed. Hub retried that already-failed request and omitted a recoverable terminal history entry. No new native submission occurred during those transport retries.

This repair is generic infrastructure only. Preserve the provider safety denial, original dispatcher, worker worktrees, product acceptance gates, and the active 60-minute automation. Do not retry, rephrase, switch provider/executor, or fabricate a worker success to clear the restriction.

## Design decision

Prefer the existing terminal stream contract over a new maintenance endpoint or caller-specific status patch: convert an authentic error terminal into a failed durable result, emit a non-recoverable terminal error through the executor/parser, preserve error status in Hub results/history across restart, and release only the exact finished run's registry state. Unknown/empty final evidence stays unresolved. Ordinary recoverable transport errors keep their existing retry behavior.

Alternatives rejected: marking a row complete loses truth; treating every exception as terminal loses live external ownership; adding a worker-ID exception breaks generic infrastructure law.

## TDD implementation task

1. Add failing Python observer and TypeScript reconciler tests for exact error-only `task_complete`, error precedence over final text, null/no-error and malformed error evidence, and cross-turn rejection. Implement generic error extraction without policy-message matching; never convert incomplete error evidence into success.
2. Add failing executor/parser/Hub integration tests. A failed durable App result must produce one terminal error, no agent-message success, no repeated native submission or transport retry. Preserve cancellation, normal success, real recoverable transport retries, and two unrelated caller identities.
3. Propagate terminal failure status through Hub result and canonical `final_reply` history; add optional status/run-state fields to persisted history and preserve them through serialization/hydration. Verify reload still recovers an error, not success. Restore idle only for the matching completed run and only if no active external reservation remains. For previously missed terminal errors, a supported status/history read may reconcile a durable failed result only when its worker, native thread/turn and latest exact submission trace agree, no current owner remains, and no final for that trace already exists. Retain the genuine terminal timestamp, never replay the request, and make repeated reads idempotent.
4. Run focused suites, Python tests, typecheck, build, then broad relevant regression tests. Review spec compliance and quality independently. No live model execution is needed for these regression fixtures.

## Delivery and acceptance

Reuse branch `codex/fix-app-receipt-reconciliation` and existing PR 170. Commit only scoped code/tests and this plan; preserve existing dirty audit documents and caches. Push origin without main merge or forced update. Install exact source/build changes with preimage hashes and backup into the dirty live checkout only after verifying the dispatcher is paused and no active native/Hub execution would be interrupted. Restart relevant services, verify installed hashes and live terminal observation. Never label the provider hold as resolved by this infrastructure patch. The existing 60-minute resolver remains active.

Live pre-fix control at 2026-09-09T21:36:14.830Z: public status returned `running` for `codex_1745`; history contained only the exact user submission and no final. Its durable queue result was already failed at 21:14:14.182Z. The queue preimage SHA256 is `e5f0858acc2b2abba3305acf9dfbe691ebcb4b11c219b2585e6d28c7eb494da2`. Post-deploy verification must recover that genuine failed receipt without modifying the queue or submitting any native turn.
