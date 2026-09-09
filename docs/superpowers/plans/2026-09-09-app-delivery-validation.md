# App delivery patch: installation and scheduled acceptance

## Installed and verified — 2026-09-09 04:53 UTC

- Hub code: 35c6b21a6e8a7e33033bbf187ca488a670a36cfe, pushed to origin/codex/fix-app-receipt-reconciliation.
- Roles code: 745d73307bb6abbf50f091e1205e7e3256d87543, pushed to origin/codex/external-handoff-watchdog.
- Applied only 27 explicit files to the existing live overlays. All 27 source hashes match the reviewed source; 14 changed compiled JavaScript artifacts match isolated builds. Both live builds passed using Node24.
- Preflight proved canonical role paused, no active worker/validator/PM, no active App queue reservation, and no Hub child executor. No worker was killed to obtain this window.
- Restarted only calling-hub (78481→24181), calling-web (71274→24194) and meridian-roles (78501→24206). Interface, monitor and unrelated services were preserved. Source backups: /tmp/meridian-delivery-install-rTUK6D/hub-before.tgz and roles-before.tgz.
- Existing main checkouts and unrelated dirty files were preserved; no PR merge, force push, main reset or queue deletion.
- Existing automation cyberent-meridian is ACTIVE, same target task 01a07f16-851a-7602-8774-7a1b20ac22b7, updated through native automation_update. Saved cadence is 2 minutes; expensive audits remain hourly via the separate durable lastAuditCompletedAt checkpoint. A saved schedule is not proof of a scheduled run.

## Orchestration evidence

BATCH-3-GATE/codex_1748 completed its exact native turn 01a08457-fdb2-7001-a43b-c5ceb91f1853 at 04:36:46 UTC. Queue request 7f2731de-c35d-47fa-aa3a-f52923340041 automatically completed at 04:37:01.281 UTC (~15 seconds). Validator codex_1749 independently accepted score1 before the maintenance window. Accepted integration ref: 70900f6a064387c99662823f3cbcf5e0579f1aab. This confirms the previous terminal-recovery patch still works, not that future delivery has passed acceptance.

The original role agent-dispatcher-83007909 was resumed. One canonical continue returned continued_parallel for N-SC-CORE and N-API-AUTH, with dispatcher codex_1727 retained. Live CLI + authenticated Hub status + actual browser renderer show 20 completed,57 pending,2 reservations and delivery counts queued2/running0:

| Worker | Owner | Durable request | Enqueued UTC |
| --- | --- | --- | --- |
| N-SC-CORE | codex_1728 | 8a643aa5-f1eb-4ae5-8c93-15ecb269143d | 04:51:28.132 |
| N-API-AUTH | codex_1729 | 759e9cbc-c82e-4f0a-82e1-40dadcb04465 | 04:51:28.168 |

At this checkpoint neither request has been manually claimed/submitted by the installer. The next actual scheduled resolver invocation must service both, using only their exact original queue records and native App protocol. Do not create duplicate requests or infer success from the reservation count. Read live state before acting; this table is a timestamped checkpoint.

## Verification

- Hub recursive discovery of91 test files:934/934 passed; production build passed.
- Roles focused implementation regressions:517/517; real HTTP worker/PM/global-PM tests3/3; typecheck and build passed.
- Independent spec and quality reviews completed for both repositories. Findings corrected with RED→GREEN regressions: legacy start replay, submitted phase mapping, ordinary CLI compatibility, global PM delivery, and newer worker-start versus older repair-start boundary.
- Broader Roles run excluding the known problematic A2A fixture:2128 passed/8 failed. Failures: mumu-phase1, mumu-phase2, validate-manifest, auto-provisioner, role-config body budget, scheduler-handlers, archiver, scheduler-engine. The body-budget failure was independently reproduced on the unmodified installed source before deployment. This is not a claim that the full suite is green.
- The all-files Roles run was stopped after repeated A2A fixture bootstrap_key_missing retries; it did not complete. No production credentials were supplied to those tests.
- Before completion, compare actual source/compiled hashes and runtime identity, not a health endpoint alone. Status on an already-completed historical owner can correctly fail after registry cleanup; new durable reservations are the delivery-contract acceptance targets.

## Scheduled acceptance — PENDING, do not mark passed yet

The current installer task being busy can defer a heartbeat. End the installer turn after handoff so the existing scheduled resolver can run. An App-unavailable or occupied host is not an instantaneous event-driven executor; the 2-minute cadence is not a guaranteed start-latency SLA.

On actual automatic wakeup:
1. Read the installed controller contract and run the compact controller check first. Service every independent ready request before deep PRD audit. This is authorized queue delivery, not new product scope.
2. Record the actual scheduled invocation time, exact request IDs and native create/send receipts, submittedAt/startedAt and native thread/turn IDs. Check the live Roles HTTP and real UI phase.
3. Observe real terminal receipts, independent validator acceptance and the next downstream/repair request. A same-worker repair needs its own exact new request/turn; never reuse a terminal request or refresh legacy start history.
4. Append the actual observed evidence here. First-downstream delivery and same-worker repair/re-entry are separate acceptance items; if no real repair exists, leave that item pending. Fixture tests do not count as scheduled production evidence.
5. For a real fault, /resolve --auto within the original canonical orchestration. Preserve79 rows,30 assertions, Growth and independent audits; do not force-complete or rerun accepted1736/1737/R-DESIGN-INTEGRATE/N-SC-FREEZE. Do not disable the controller while requests are outstanding.

The ordinary native App catalog omission and unavailable native permission-application/readback contract remain distinct client limitations. This patch does not claim to repair them or require repeated owner authorization. Product acceptance remains false; orchestration acceptance is not product release.
