# Meridian Codex App worker controller

Writable local Codex workers use the Codex App by default. This systematizes the PRE-FLIGHT handoff: Meridian owns scheduling, worker identity and validation; the App owns execution and native tools. A private durable queue connects them. This requires an active Codex App heartbeat controller on the same host. A closed/unavailable App leaves work queued; it never silently falls back to a different execution surface.

`MERIDIAN_CODEX_EXECUTION_SURFACE=cli` explicitly restores CLI execution. Read-only validators always retain CLI read-only enforcement. Managed credentials, a different CODEX_HOME, per-credential environment overrides and image attachments fail explicitly when unsupported. App workers use the local App account, environment and configured permissions. No credentials are copied into the queue or App state.

## Installed controller

- Repository: `/Users/yzliu/work/Meridian`
- Queue: `~/.meridian/codex-app-queue` (override: MERIDIAN_CODEX_APP_QUEUE_DIR)
- Controller identity: `codex-app-controller`
- Sidebar section: `Meridian workers`; resolve by native list_threads, create only if absent.
- Native App tools are required. Never replace them with a CLI app-server, internal state edits or UI automation.
- Sandboxed App controllers may perform queue transitions through the Hub's authenticated `POST /api/codex-app-queue/ID` bridge. The body uses the same `claim`, `submit`, `bind`, `started`, `observe`, and `complete` actions and controller identity described below. Responses omit prompts, native receipts, and final text. This bridge calls the same locked `AppHandoffQueue` methods; it is not a second queue implementation and does not authorize a native submission by itself.

The native heartbeat services this queue at its configured cadence; verify the actual saved automation and do not infer activation from a rendered card. An empty App queue is not evidence that orchestration is idle or finished: read-only validators finish outside this queue. Check worker, validator and PM ownership before ending each pass. A validated completion with eligible downstream work requests one canonical continuation; a real blocker follows the authorized resolver path. A capsule held only as `awaiting_fill` needs that continuation to perform its fill. Never overwrite a capsule from the controller, bypass validation, ignore an explicit pause, or repeat a continuation against an active owner.

Separate the delivery driver from expensive investigation. On this host, use the existing native heartbeat at a short supported cadence (target two minutes); keep the deep resolver audit hourly. Verify the saved interval and actual scheduled invocation after changing it. Do not create a second controller or claim that a short interval guarantees delivery while the App is unavailable or this task is occupied. After any action, inspect its actual result and service newly queued App requests. Keep each pass bounded and yield; do not wait for one worker to finish before handling independent queued workers. Quiet termination is appropriate only after both queue and dispatcher checks found no action. F1 completion stops its F1 duties, not the generic App controller. User instructions and TaskSpec dependencies remain authoritative.

Run `node dist/agents/codex-app-controller.js check CONTROLLER` first (using the pinned runtime below). It returns compact request IDs, ownership and native-only duties, and persists `lastCheckAt` separately from `lastAuditCompletedAt`. Service every independent ready request before a due deep audit. Interleave short queue checks during a long audit, and check newly eligible downstream/repair work after validation. Only after actually completing the full audit run `node dist/agents/codex-app-controller.js audit-complete CONTROLLER`; a check is not an audit completion. These private, locked checkpoints live in the queue's `.controllers` subdirectory and survive restart. Neither command submits work, changes request ownership nor refreshes worker progress. A corrupt checkpoint is an explicit error requiring repair, never an implicit successful scan/audit. Requests owned by another controller must be reconciled with that owner, not claimed again.

## Repair duties are independent of audit cadence

A confirmed unresolved blocker enters the scoped `resolve --auto` repair path
even when `audit_due` is false. Read the installed resolve skill in full before
diagnosing; a known hold is not required to become a new fault to qualify.
The heartbeat and a Meridian PM resolver share one canonical repair owner, not
two controllers. PM execution ending does not establish that its issue is resolved.

Check canonical `dispatch-status` resolution duties on every delivery pass.
For each blocked attempt, require a durable owner, next executable action,
actual progress evidence and a bounded next-check/deadline. An unowned or overdue
duty is actionable. Follow an active repair owner without duplicate PM dispatch.
A real external wait additionally needs an accountable external party, a
request/evidence reference and an observable release condition. Re-evaluate at
expiry; do not endlessly extend a deadline on unchanged evidence.

`lastCheckAt` and `lastAuditCompletedAt` are inspection clocks, not repair
progress. Neither an audit nor repeated identical observations refreshes actual
progress or clears a duty. If the installed Roles version lacks these fields,
record that integration gap and use a scoped decision ledger, not an empty-duty
success. Preserve unrelated active owners and human escalation gates.

Do not repeat an unchanged failing execution. This forbids validator retry
storms; it does not forbid repairing the execution environment through supported,
authorized mechanisms. Never bypass a denial, weaken independent acceptance, or
treat producer self-tests as a validator receipt. A missing capability that truly
requires external action must be named and assigned, not silently left for the
next hourly audit. Quiet notifications are independent from useful repair work.

### Public delivery evidence

Hub `status` and authenticated `GET /api/status?thread_id=OWNER` expose additive, provider-neutral `execution` metadata. The `kind`, `state` and exact `request_id` retain reservation semantics. `delivery_phase` distinguishes queued, claimed, submitted, native running and cancellation; thread binding alone is not execution. Optional enqueue, submit, start and real changed observation timestamps, plus native thread/turn IDs, support diagnostics without exposing prompts, receipts or results. Legacy timestamps remain unknown unless reconstructable from the actual transition history. Observing the same progress again must not reset its freshness. A terminal request is omitted and cannot hide or resurrect a subsequent request for the same owner. Roles scheduling reservations must remain intact while its display shows the delivery phase separately.

## Service one request

On this host the Hub runs Node 24 from `/Users/yzliu/.local/share/fnm/aliases/default/bin/node`; use that same executable for all queue CLI commands because fs-ext is compiled for the Hub runtime. Use `/Users/yzliu/.local/share/fnm/aliases/default/bin/node /Users/yzliu/work/Meridian/dist/agents/codex-app-queue.js list`. This omits prompt contents. `read ID` retrieves the full durable request. If the controller sandbox cannot open the queue lock, use the authenticated Hub bridge rather than editing queue JSON or weakening the sandbox. Do not echo secrets or full task prompts in public status.

1. For `pending`, atomically `claim ID codex-app-controller`. Only a successful claim permits one native submission. Keep the request ID unchanged across retries. Re-read immediately before submission; if cancellation was requested, do not launch work. Never re-claim a claimed request or resend after an uncertain native response.
2. Atomically `submit ID codex-app-controller` immediately before the native call. Only success authorizes that single call. Cancellation before this durable intent becomes terminal without a fictitious App turn; after it, uncertainty retains the reservation. Never repeat submit after an error or uncertain response. Prefix the exact queued task prompt with `[Meridian App handoff request: ID]` and the assigned working directory. Tell the worker to run all task commands in that assigned checkout, verify its branch, preserve unrelated work, retain the original report/status protocol, and use available native App functions when needed. The App's hosting worktree does not replace the TaskSpec-assigned checkout. Do not expand task authority.
3. If `threadId` exists, continue that exact saved thread with native `send_message_to_thread`. Previous Meridian CLI turns have already exited; if App reports an active writer, keep the request claimed and reconcile the actual owner. Never edit a transcript, permissions or database, kill an uncertain owner, or fork a replacement worker.
4. If `threadId` is absent, register and execute once using native `create_thread`. Call native `list_projects` first. Determine the matching saved repository via `git -C REQUEST_CWD rev-parse --git-common-dir`; use that project's returned ID and Git worktree environment, following native tool rules. For non-repository work use projectless. Pass the request's exact model and reasoning effort when provided. Title: `Meridian WORKER_ID`. This new App task is the worker's first session, not an additional implementation worker.
5. Persist the full native receipt privately: write `{ "receipt": "<JSON receipt string>", "progress": "<actual observed status>" }` to a mode-0600 temporary file, then `observe ID codex-app-controller FILE`. A pending `clientThreadId` is not a real thread ID and must never be sent to thread tools.
6. Resolve the actual thread and turn through the native receipt/read_thread. If pending creation or legacy exec-source readback omits them, use the bounded read-only helper:
   `python3 /Users/yzliu/work/Meridian/scripts/codex-app-observe.py --request-file ~/.meridian/codex-app-queue/ID.json --output /tmp/ID-app-observation.json`
   It matches the exact request marker in native user input or native create_thread/send_message_to_thread delegation and only that turn. If native read_thread returns no items, the helper can recover the exact saved turn and original final from its read-only transcript; confirm native terminal status independently before handback. It never edits Codex storage. Zero/multiple matches mean keep claimed and reconcile, never create another task. Validate the resolved UUID with native read_thread.
   Unbound discovery also checks native tasks whose metadata source is `unknown`, within the same total 100-candidate limit. Such a candidate requires an actual `codex_app/create_thread` or `codex_app/send_message_to_thread` delegation containing the exact request marker after that turn starts and before it ends; a normal user message or quoted delegation is insufficient.
7. Persist `bind ID codex-app-controller THREAD_UUID` for new tasks and `started ID codex-app-controller TURN_ID`. Move the thread to `Meridian workers` with native move_thread_to_sidebar_section. Verify both section membership and the actual entry in native list_threads; membership alone is not visibility. Missing native tasks must not automatically be diagnosed as legacy-source filtering: current vscode/agent_created_thread tasks can be excluded because the native catalog preview is empty. Use exact-ID native read/wait and the read-only observer to distinguish this catalog defect from a stalled worker. Continue the same task; native navigate_to_codex_page can open it but is not a listing repair. Never edit Codex source/permission storage, fabricate user messages, or create a duplicate worker to force visibility. Newly registered native workers remain the default.
8. On subsequent passes, use native read_thread/wait_threads snapshots to observe active turns. Record real changed commentary/status with `observe`; do not invent periodic progress. The helper can extract the exact turn's latest commentary, final text and task_complete/turn_aborted event. Never use another turn's final or a title as evidence.
9. Once native App state and the exact turn event confirm terminal, write `{threadId,turnId,status,text}` to a private result file and `complete ID codex-app-controller FILE`. `status` must be completed, failed or interrupted; `text` is the real final result. A task_complete without final text needs reconciliation. Meridian then receives the real result and applies its normal report/validator rules. App completion is not product acceptance.

## Effective task environment

Durable requests may include `executionPolicy`, containing the Hub's original
optional `autoApprove` and `sandboxMode` values. This is **requested intent**,
not effective permissions, an authorization grant, or proof of native support.
False and missing values remain distinct; old requests without the field remain
readable. A same-ID retry with changed policy is a request-content conflict.
An executor retry of a legacy request does not retrofit newly available policy
metadata; its missing policy remains unknown and its original result/ownership
is preserved. New logical requests carry the registered policy.
The App executor preserves this object through its process arguments and queue;
it does not convert `autoApprove` to Full Access or silently select another
executor. Read-only validators retain their existing enforced CLI route.

The current public native create/send tools expose no permission-setting
parameter. Controllers must not claim that this metadata applies a profile.
Compare the requested policy with actual environment evidence for the exact
native turn; a missing/incompatible effective environment is an explicit
integration blocker, not missing owner consent. Preserve ownership and the
actual worker result. Do not invent an unsupported tool argument, edit Codex
state, or retry through a more privileged executor to satisfy this request.
Automatic native profile provisioning remains unsupported until the native
interface supplies a supported capability; this transport repair does not
claim to implement it.

The App host account, the project config default, and the controller's current
permission profile do not prove the worker's effective permissions. A newly
created native task can retain a different saved task profile. For a reported
environment blocker, compare the exact worker turn's actual permission context
and scoped failing operation before repeating long verification. Do not call a
child-task denial missing owner authorization, or claim that editing a project
default repaired native task inheritance.

If the worker's scoped Git metadata or required dependency access is denied,
preserve its checkout and report the exact refusal promptly. Do not change
Codex permissions/config/database, bypass the denial through another executor,
or rerun an unchanged failure each heartbeat. Distinguish requested Hub policy,
source-task selection and exact native effective policy. Do not prescribe
per-worker owner permission changes as the normal provisioning mechanism:
the unsupported native application contract is an integration blocker, not a
new owner authorization requirement. If an actual supported native environment
change is observed, prefer the canonical `meridian-tool run` against its retained
Hub worker with the original command, model and validation settings; the new
queue request must retain its native session ID and use one same-task send.
Verify no active owner before this continuation, and verify the new turn's
effective environment and real outcome afterward. Never reuse a terminal queue
request, force-complete a row, or substitute worker evidence for independent
acceptance.

## Cancellation and recovery

If native **thread creation is definitively rejected before a thread exists**, the original trusted controller may use `reject-creation ID CONTROLLER REJECTION_FILE`. The private file contains `{requestId, outcome: "not_started", error, evidence}`. Retain the exact native create receipt and correlated native `thread/start` error in the evidence. This only accepts submitted, unbound `claimed`/`cancel_requested` creations, records a failed handoff without inventing a UUID or final answer, and never re-enables submission of the old request. A pending client ID, missing listing, timeout, elapsed time, absent marker, or uncertain send is NOT rejection evidence. Bound tasks must use the exact terminal-turn protocol. The local CLI is the only rejection entrypoint; the HTTP bridge deliberately does not expose it. Resolve the startup cause before a new canonical retry.

An interrupted Hub run returns `status: error`, `run_state: completed` on its original trace. The separate interrupt command acknowledgement may still be successful. Terminal transport is not successful product completion.

SIGINT/SIGTERM request cancellation while keeping the executor and Hub reservation alive. Pending requests cancel immediately. Claimed/started requests remain `cancel_requested` until the exact App turn terminates. Native tools do not expose a force-interrupt operation: if a turn is still running, send one concise cooperative stop instruction to that same running thread, record its receipt, and wait for actual termination. Do not send a stop after the original turn already ended, as that would create a new turn. A claim cancelled before the durable submit intent becomes cancelled immediately and submit then refuses it. After submit intent, ambiguous submission remains reserved for reconciliation.

The Hub executor also performs a bounded terminal-recovery check for requests that are already `started` or `cancel_requested`. It uses the same read-only exact-marker observer, requires the durable request's exact native thread and turn, and accepts only a recorded terminal event with nonempty final text. The result still passes through the controller-bound queue transition and the normal Meridian result/validator path. It never derives completion from a title, report, worker marker or missing process. A running turn, identity mismatch, absent final text or observer ambiguity remains reserved for native-controller reconciliation.

This fallback does not claim, submit, bind or create App work. `pending` and `claimed` requests still require the native App controller, so a closed or unavailable App cannot silently start work through the Hub.

Kill/restart/reboot refuse active App worker reservations, including after a Hub restart. The queue uses a kernel-released POSIX flock and fsynced atomic private JSON replacement. A crash cannot leave a stale software lock or permit duplicate execution. Stable request IDs return durable terminal results on transport retry. Do not delete queue records to clear a blocker. Do not disable the controller while App requests remain active. Drain active CLI workers and validators before installing/restarting the live Hub.

## Evidence

Verified native App tool use and sidebar registration:
- Native worker `01a077f2-cf5e-7232-96d7-2534f94a9ea0`, turn `01a077f2-d068-7cd1-b102-ca7d682d8558`.
- Same-session legacy continuation `01a077ec-6d30-7cf2-8df3-ab6852d780e0`, turn `01a077ed-273a-7083-b859-45cadfa29970`.
- Native list_projects succeeded. The true final returned through the Meridian Codex stream adapter.

These are orchestration proofs, not Cyberent product/security acceptance. Smart-contract independent audits, remediation and exact-commit re-audit remain mandatory.

Installed default roundtrip (2026-09-07): Hub request `109ab453-9b89-4566-b818-bb6926e908f0` → native App thread `01a0780f-c9ab-72e0-b9a2-6eeb724385b6`, turn `01a0780f-ca7b-76f0-a322-8849db3e91d4` → queue completed → Hub conversation history recorded `APP_DEFAULT_ROUNDTRIP_OK` at 2026-09-06T18:52:08.421Z. Native list_projects succeeded and the sidebar section lists the thread. The short-timeout CLI HTTP caller timed out while the task continued; no duplicate send was made. Use durable Hub trace/history for asynchronous delivery confirmation.

First real F1 PM uses request `c965ad17-6924-4a4b-916d-dcffbe05a9b4`, native thread `01a07811-e2ff-7842-bf70-aec5de4df0cf`, turn `01a07811-e407-7be2-a852-fcda7e5949e7`. Native App tool access succeeded and actual assigned PM work began.
