# Interrupted worker terminal result repair

User-authorized resolver repair, continuing `codex/fix-app-receipt-reconciliation`.

## Contract

The interrupt command acknowledgement can succeed while the interrupted run itself failed. Return `status: error`, `run_state: completed` on the original run trace. Preserve exact thread identity, no stream retry, and retain submitted App reservations until the controller verifies the exact turn terminated. Do not add caller-specific behavior or bypass validators.

## Execution and verification

1. Reproduce the existing CLI regression with a failing status assertion (observed success instead of error).
2. Change only the typed `RunInterruptedError` result status, retaining terminal state and identity.
3. Cover pending App cancellation and submitted App cancellation with an outstanding reservation; check interrupt acknowledgement, blocked destructive lifecycle operations, single spawn, terminal queue, and original run result.
4. Run focused router/queue/executor/reconciler/restart tests, typecheck and full suite. Independently review the cumulative branch.
5. Commit and push the existing topic branch; do not merge main or overwrite unrelated live changes. Apply/restart only after all live reservations and active workers drain.

## Operational incident boundaries

The original R-DESIGN-INTEGRATE result belongs to codex_1726 and stays completed. The subsequent freeze row is a different worker. Native task creation may fail before a real UUID exists; a client-new-thread receipt is not proof of execution, and a submitted ambiguous request must never be blindly resent.

Review found a runtime mismatch between PATH Node and PM2-adjacent Node. Both build/restart now load the same env file and preflight the chosen executable against installed fs-ext before teardown, then export its actual path. An explicit invalid interpreter or missing/incompatible native module fails before stopping services.

A fresh native thread/start rejection exposed a separate queue gap: submitted creation failures had no terminal transition without inventing a UUID. Add a local-controller-only `reject-creation` transition with request-matched definitive non-start evidence, no thread/turn binding, retained receipts and consumed submission. Never use this for an uncertain or bound native task. Failed creation is orchestration failure, never accepted product work.
