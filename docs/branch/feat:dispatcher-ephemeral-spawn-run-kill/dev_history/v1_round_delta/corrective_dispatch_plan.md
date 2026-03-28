# DELTA-CHECK — Corrective Dispatch Proposal

- Trigger: `delta_check_report.md` contains unresolved `⚠️ Drift` findings.
- Status: blocked pending branch-cleanup approval; no corrective code changes were applied in this pass.

## Proposed Corrective Workers

| Worker | Model | Delta Type | Scope | Reason |
|---|---|---|---|---|
| D-01 | CODEX | DRIFT | Restore `src/roles/definitions/dispatcher.ts` to the baseline branch state. | Required to satisfy the R-01 and N-09 untouched-file constraints. |
| D-02 | CODEX-XHIGH | REWORK | Implement end-to-end `user_reply_channels` propagation so notify can reach every selected channel, or narrow the contract with explicit PM approval. | Required to satisfy PM Flag #1 and N-10 acceptance end-to-end. |
| D-03 | CODEX-HIGH | DRIFT | Remove or split the unrelated branch diff in `.gitignore`, `README.md`, `skills/**/*`, `tests/e2e/*`, legacy docs, and prior-branch artifacts. | Required because these files are outside the current TaskSpec and block clean PR alignment. |

## Blocking Note

`D-03` touches pre-existing branch history outside this dispatch scope. That cleanup should not be auto-reverted without an explicit user/PM decision.
