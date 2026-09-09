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

## First actual scheduled resolver invocation — 2026-09-09 04:57:46.059 UTC

This is observed scheduled execution, not a manual schedule test. Queue delivery occurred before the due deep audit. Both original requests were claimed and submitted once; no duplicate native tasks or forced lifecycle transitions were used.

| Owner / row | Native thread | Exact turn | Submitted UTC | Native turn started UTC | Queue start acknowledged UTC |
| --- | --- | --- | --- | --- | --- |
| codex_1728 / N-SC-CORE | 01a0848c-0c2b-7833-8e28-4fbf9cf22263 | 01a0848c-0e34-71b2-a5ba-0a79dfb8c32a | 05:02:44.198 | 05:02:46 | 05:03:22.665 |
| codex_1729 / N-API-AUTH | 01a0848c-0c2b-7833-8e28-4fa53c122238 | 01a0848c-0e9f-7a90-90d2-ac052f137b73 | 05:02:44.495 | 05:02:46 | 05:03:23.072 |

- Exact native read/wait confirmed actual in-progress turns, correct assigned TaskSpec checkouts and real tool execution. Live canonical CLI, authenticated Hub status and actual Roles browser rendering changed from Queued to Running and displayed both thread/turn pairs.
- Native create receipts were saved privately, including pending client IDs 5ab78bd7-68a6-44d5-b888-1b82c0675227 and 6310e377-9651-41ab-9844-236e24bc3a38. Pending client IDs were never used as actual thread IDs.
- Enqueue-to-native-start was approximately 11m18s: about 6m18s before the scheduled invocation and about 5m before native submission during controller preparation. This does not pass a 2-minute delivery-latency SLA. PM delivery below is a separate measured case.
- Native ordinary list_threads(limit=50) still returned no entries for these exact tasks although section Meridian workers contains both item keys. Exact-ID read succeeds and preview remains empty. Membership does not establish ordinary catalog visibility; the native catalog limitation is not fixed by this patch.
- Source hash recheck: all 11 source files changed in Hub code commit35c6b21 and all 4 source files changed in Roles commit745d733 match the installed reviewed worktrees. This is an additional subset check, not a replacement for the recorded initial27-source/14-compiled verification.

### Real terminal and PM continuation

N-SC-CORE completed its exact native turn at **05:13:36 UTC** with actual outcome needs_pm. Without a resolver complete command, the Hub recovery path completed request8a643aa5-f1eb-4ae5-8c93-15ecb269143d at **05:13:42.682 UTC** (~6.7seconds) and Roles received the exact final at05:13:42.699, setting the worker lifecycle to blocked. It did not remain a stale running worker and it was not misclassified as product-complete.

The scheduled resolver then called the canonical pm-resolve once for N-SC-CORE. PM codex_1730 was created at05:14:28 and queued request2207099c-b225-467f-8b44-624f84189f4a at05:14:29.066. The controller delivered that request once:
- Native PM task01a08497-7924-7491-a594-05ced6b87213, exact turn01a08497-7aae-7321-87cd-01191f872dcc.
- Native turn started05:15:15 UTC (~46seconds from enqueue); queue start acknowledged05:15:45.428.
- Exact native read/wait confirmed PM execution and real report/lifecycle inspection.
- Actual Roles renderer shows owner pm_resolver/codex_1730 Running with the new request/thread/turn. The underlying N-SC-CORE worker remains blocked. Thus a Running row now identifies an active PM, not a resurrected completed worker.
- The PM is to route the demonstrated harness defects through the original producer and independent exact-ref acceptance, also checking the separately reproduced N-API-AUTH database-role defect after that worker terminates. No unchanged worker retry, duplicate controller, direct producer edit or weakened product gate was performed by this resolver.

Acceptance status: **scheduled queued-to-running and terminal-needs_pm-to-running-PM observed**. Independent validator success → next batch and an actual same-worker repair/re-entry remain **pending**. This first scheduled production run found real product prerequisite defects, not a native Codex permission denial. See [the hourly audit record](2026-09-09-scheduled-resolver-audit.md); 79rows/30assertions and25/25 orchestration counterfactuals pass, while the last product baseline remains0green/30red.

### Second terminal and coordinated maintenance hold — 05:18 UTC

N-API-AUTH also completed its exact native turn at05:17:03Z; the Hub automatically completed its original request at05:17:14.083Z (~11seconds), preserving the real blocked marker. Its reproducible NAA-DB-01 test commit ec9650428ed5c8404c85da04f3250dd6f0e630b0 and report were passed to the same running PM, not a second resolver. At that PM's coordination request, the root paused only canonical new dispatch through POST /api/agent-dispatcher/agent-dispatcher-83007909/pause (ok:true,paused), preserving native turns. The PM owns the bounded shared-plan amendment and subsequent canonical resume/continue; the root's existing scheduled resolver retains App queue delivery. This maintenance hold is intentional and is not an unreported orchestration stall or an owner-authorization wait.

## Real producer-repair re-entry — observed through 05:35 scheduled check

The configured PM completed its original request2207099c-b225-467f-8b44-624f84189f4a at05:27:36.414Z through the normal queue terminal path. Its bounded pm-consumer-prerequisite-repair.md amendment reopened the original producer rows and BATCH-3-GATE for newly reproduced H-CORE-01/02/03 and NAA-DB-01. This is new producer-owned repair scope, not replay of the previously accepted1736/1737 attempts. Original reports and commits remain historical evidence. The consumers wait on fresh independent producer and integration acceptance.

The PM handback triggered the controller's05:25:53 check (not a new timed invocation). By then canonical runtime had queued both distinct producer requests, including R-DB-FREEZE after the PM's earlier still_blocked response. The root did not issue a second continuation. Each request was claimed/submitted once, with a new native task because its durable request had no existing threadId:

| Row / owner | Request | Enqueued UTC | Submitted UTC | Native thread / exact turn | Native start UTC | Queue start UTC |
| --- | --- | --- | --- | --- | --- | --- |
| N-TEST-HARNESS / codex_1731 | 00533b26-927f-4e32-8adb-b3dde11f9bb9 | 05:24:57.208 | 05:26:42.619 | 01a084a1-fde0-7b73-850c-7d33718ad8e2 / 01a084a1-fffc-7b20-afb1-6e4df6e95e02 | 05:26:44 | 05:27:17.732 |
| R-DB-FREEZE / codex_1732 | c4d85545-ea72-440b-87b1-e5f13e609ed6 | 05:25:29.453 | 05:26:42.861 | 01a084a1-fde0-7b73-850c-7d16f52c7051 / 01a084a2-001e-7860-98f2-a73c03c741b2 | 05:26:44 | 05:27:18.160 |

Native enqueue-to-start was approximately107seconds and75seconds respectively. The actual Roles renderer showed both workers Running with these exact identities, while BATCH-3-GATE and both consumers showed Retry pending with explicit unmet dependencies. A transient unknown in one canonical read was not treated as a terminal event: authenticated Hub status and the subsequent canonical read both returned the same running owner; no resend/restart occurred.

Actual scheduled invocations at05:31:45.223Z and05:35:15.227Z independently confirmed both exact native turns remain in progress, both assigned checkouts/accepted branches are retained, canonical role is active, no validator/PM is active, and there are no additional pending App deliveries. Latest canonical summary is79 rows:17completed,60pending,2running; execution queued0/running2/unknown0. Only genuinely changed native commentary was recorded through observe. audit_due=false retains the completed hourly audit timestamp05:16:45.755Z rather than recording a light check as a new audit.

Acceptance: row-level producer repair re-entry and subsequent scheduled observation are now evidenced. A same-Hub-owner validator fix-cycle/send, independent repair acceptance, repaired BATCH-3-GATE and consumer re-entry remain pending until those exact events occur. Ordinary native catalog entries are still absent despite section membership; no catalog repair, complete scheduled E2E or product acceptance is claimed.


## Scheduled repair terminal → independent validator — 06:05 UTC

The actual scheduled invocation at05:59:45.284Z observed N-TEST-HARNESS/codex_1731 complete its exact native turn01a084a1-fffc-7b20-afb1-6e4df6e95e02 at05:59:07Z. Without a resolver complete command, its original request00533b26-927f-4e32-8adb-b3dde11f9bb9 automatically became completed at05:59:19.187Z (~12seconds). The worker emitted the real complete marker and pushed repair commitac4f645264b4aae8f215adaffe333e9d85888e55; the resolver independently read the same exact origin branch ref.

Canonical lifecycle now reports N-TEST-HARNESS awaiting_validation, owned by independent validatorcodex_1733. Authenticated Hub status confirms that validator running in stateless_call CLI mode; it is not an App request awaiting delivery and was not replaced or restarted. The producer reports38/38 harness controls,36/36 model checks and3/3 Safe diagnostics; these remain producer self-test evidence, not independent acceptance. The absent-product Foundry cases remain intentionally RED.

At06:05Z, R-DB-FREEZE/codex_1732 remains in its original native turn with genuine new progress: local commitdd8f1fa was created and the worker is rerunning full DB acceptance against that committed SHA before push/readback. Its earlier118/118 result was pre-commit self-test evidence only. The controller recorded the changed commentary at06:05:03.181Z; it did not manufacture progress from an unchanged poll.

Current canonical state:79rows,17completed,60pending,2active reservations (one producer and one independent validator),0failed/0stale. BATCH-3-GATE explicitly waits for both producers, and N-SC-CORE/N-API-AUTH wait for BATCH-3-GATE. No additional App delivery or PM is pending. The hourly audit checkpoint remains05:16:45.755Z; this light check did not advance it.

Acceptance update: real producer-repair terminal receipt → independent validator takeover is observed. Independent repair acceptance, repaired integration, consumer re-entry and a same-Hub-owner validator fix-cycle/send remain unproven. The ordinary native App catalog omission remains unresolved. No full scheduled E2E or product release is claimed.


### Independent repair acceptance — 06:08 scheduled check

The actual06:08:15.317Z scheduled invocation found N-TEST-HARNESS completed with validation_provenance=validated. The canonical append-only report records independent validatorcodex_1733, score1 at06:07:28.447Z, exact refac4f645264b4aae8f215adaffe333e9d85888e55. Its real Safe diagnostics ran through Chisel; the validator explicitly retained cache/temp-write limitations and did not claim the full producer Foundry run independently reproduced. Authenticated lookup of this already-removed validator now returns not registered, consistent with completed canonical ownership, not an active-owner stall.

R-DB-FREEZE remains in its original native turn; its new commentary reports committed-SHA DB acceptance and push, and root independently read origin atdd8f1fa08a6bc54395e9734270d8e36d942d3fbc. Only this changed commentary was observed, at06:09:02.251Z. The canonical summary is18completed/60pending/1running/0failed/0stale; BATCH-3-GATE now has only R-DB-FREEZE unmet. No repeated continue, duplicate validator or false audit-complete was issued. Independent harness repair acceptance is now observed; DB acceptance, repaired integration and consumer re-entry remain pending.


### Database repair terminal and validation takeover — 06:12 scheduled invocation

The actual06:12:45.335Z scheduled invocation independently observed R-DB-FREEZE/codex_1732 terminal completion of its exact native turn01a084a2-001e-7860-98f2-a73c03c741b2 at06:10:12Z. The original requestc4d85545-ea72-440b-87b1-e5f13e609ed6 automatically became completed at06:10:24.357Z (~12seconds), retaining the real complete marker. The resolver did not issue complete or retry.

Canonical lifecycle now reports awaiting_validation with CLI validatorcodex_1734. Authenticated Hub status independently confirms that exact owner running in stateless_call mode. The producer's exact commit remainsdd8f1fa08a6bc54395e9734270d8e36d942d3fbc, with reported118/118 DB checks and additional App/Chain/coverage gates. These are producer results pending independent validation. The canonical role remains active with dispatchercodex_1727, no active global/worker PM, no App deliveries awaiting service and no eligible downstream while the database validator owns this row. Empty App queue does not mean the round is finished or idle.

Both actual producer-repair terminals have now returned automatically and triggered independent validation; the harness repair is independently accepted. Database acceptance, new BATCH-3-GATE request/acceptance, consumer re-entry and a real same-Hub-owner validation fix-cycle remain pending. This check leaves the hourly audit checkpoint unchanged.

## Scheduled independent acceptance → automatic integration delivery — 06:16 invocation

Actual scheduled invocation2026-09-09T06:16:45.346Z found R-DB-FREEZE independently accepted by CLI validatorcodex_1734 at06:16:41.931Z, score1, exact dd8f1fa08a6bc54395e9734270d8e36d942d3fbc. Combined with harnessac4f645264b4aae8f215adaffe333e9d85888e55 acceptance at06:07:28.447Z, this unblocked original BATCH-3-GATE. The dispatcher automatically queued its new ownercodex_1735 at06:17:29.422Z; root checked ownership and did not issue another continue.

The controller claimed/submitted the one new request77dbbe19-1375-4585-9666-1f1c8401e8bc exactly once at06:18:31.093Z. Native task01a084d1-6bf5-7d53-beeb-2842427f6962 / exact turn01a084d1-6e9c-7dc1-a68e-74500c84ee09 started06:18:32Z, approximately63seconds after enqueue; queue acknowledged started06:19:31.201Z. The request contained no existing native thread, so this is one authorized new delivery, not a resend of previously accepted1736 or an unchanged attempt. Its assigned integration checkout and existing accepted ancestry are preserved.

At06:26 the actual Roles renderer, authenticated Hub status and native wait snapshot all show this exact integration task running. Canonical state is19completed/59pending/1running/0failed/0stale across79rows; all completed rows have validated provenance. Both consumers explicitly wait on BATCH-3-GATE. Native task membership in Meridian workers is verified, but ordinary catalog listing still omits the entry; this limitation remains open.

At06:28 the same native turn reports accepted producer refs/ownership/remote ancestry verified and unaccepted consumer ec965042 absent; it is merging only the two new producer descendants before full controls. Root persisted genuinely changed commentary through observe, not a synthetic heartbeat. Database validator acceptance carries its disclosed read-only Docker limitation and relies on native producer118/118 evidence; the current integration task must independently run the full integrated runtime checks.

Acceptance advanced: actual scheduled producer completion → automatic terminal receipt → independent repair acceptance → automatic next request → native integration execution is now observed. Integration acceptance, consumer re-entry, a real same-Hub-owner validation fix-cycle and the native App catalog limitation are not closed. Full product remains unaccepted; last goal baseline0green/30red is retained. See the [second hourly audit](2026-09-09-scheduled-resolver-audit.md) for fresh source reads, gates, source identity and PM2 evidence.
