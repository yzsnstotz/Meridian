# Meridian Codex App worker controller

Writable local Codex workers use the Codex App by default. This systematizes the PRE-FLIGHT handoff: Meridian owns scheduling, worker identity and validation; the App owns execution and native tools. A private durable queue connects them. This requires an active Codex App heartbeat controller on the same host. A closed/unavailable App leaves work queued; it never silently falls back to a different execution surface.

`MERIDIAN_CODEX_EXECUTION_SURFACE=cli` explicitly restores CLI execution. Read-only validators always retain CLI read-only enforcement. Managed credentials, a different CODEX_HOME, per-credential environment overrides and image attachments fail explicitly when unsupported. App workers use the local App account, environment and configured permissions. No credentials are copied into the queue or App state.

## Installed controller

- Repository: `/Users/yzliu/work/Meridian`
- Queue: `~/.meridian/codex-app-queue` (override: MERIDIAN_CODEX_APP_QUEUE_DIR)
- Controller identity: `codex-app-controller`
- Sidebar section: `Meridian workers`; resolve by native list_threads, create only if absent.
- Native App tools are required. Never replace them with a CLI app-server, internal state edits or UI automation.

The existing Cyberent F1 heartbeat also services this queue every minute; it performs the F1 orchestration check at most every fifteen minutes or on a meaningful new event. F1 completion stops its F1 duties, not the generic App controller. The heartbeat services the queue every minute. Each pass does useful bounded work and yields; it must not wait for one worker to finish before starting independent queued workers. User instructions and TaskSpec dependencies remain authoritative.

## Service one request

On this host the Hub runs Node 24 from `/Users/yzliu/.local/share/fnm/aliases/default/bin/node`; use that same executable for all queue CLI commands because fs-ext is compiled for the Hub runtime. Use `/Users/yzliu/.local/share/fnm/aliases/default/bin/node /Users/yzliu/work/Meridian/dist/agents/codex-app-queue.js list`. This omits prompt contents. `read ID` retrieves the full durable request. Do not echo secrets or full task prompts in public status.

1. For `pending`, atomically `claim ID codex-app-controller`. Only a successful claim permits one native submission. Keep the request ID unchanged across retries. Re-read immediately before submission; if cancellation was requested, do not launch work. Never re-claim a claimed request or resend after an uncertain native response.
2. Atomically `submit ID codex-app-controller` immediately before the native call. Only success authorizes that single call. Cancellation before this durable intent becomes terminal without a fictitious App turn; after it, uncertainty retains the reservation. Never repeat submit after an error or uncertain response. Prefix the exact queued task prompt with `[Meridian App handoff request: ID]` and the assigned working directory. Tell the worker to run all task commands in that assigned checkout, verify its branch, preserve unrelated work, retain the original report/status protocol, and use available native App functions when needed. The App's hosting worktree does not replace the TaskSpec-assigned checkout. Do not expand task authority.
3. If `threadId` exists, continue that exact saved thread with native `send_message_to_thread`. Previous Meridian CLI turns have already exited; if App reports an active writer, keep the request claimed and reconcile the actual owner. Never edit a transcript, permissions or database, kill an uncertain owner, or fork a replacement worker.
4. If `threadId` is absent, register and execute once using native `create_thread`. Call native `list_projects` first. Determine the matching saved repository via `git -C REQUEST_CWD rev-parse --git-common-dir`; use that project's returned ID and Git worktree environment, following native tool rules. For non-repository work use projectless. Pass the request's exact model and reasoning effort when provided. Title: `Meridian WORKER_ID`. This new App task is the worker's first session, not an additional implementation worker.
5. Persist the full native receipt privately: write `{ "receipt": "<JSON receipt string>", "progress": "<actual observed status>" }` to a mode-0600 temporary file, then `observe ID codex-app-controller FILE`. A pending `clientThreadId` is not a real thread ID and must never be sent to thread tools.
6. Resolve the actual thread and turn through the native receipt/read_thread. If pending creation or legacy exec-source readback omits them, use the bounded read-only helper:
   `python3 /Users/yzliu/work/Meridian/scripts/codex-app-observe.py --request-file ~/.meridian/codex-app-queue/ID.json --output /tmp/ID-app-observation.json`
   It matches the exact request marker in native user input/delegation and only that turn. It never edits Codex storage. Zero/multiple matches mean keep claimed and reconcile, never create another task. Validate the resolved UUID with native read_thread.
7. Persist `bind ID codex-app-controller THREAD_UUID` for new tasks and `started ID codex-app-controller TURN_ID`. Move the thread to `Meridian workers` with native move_thread_to_sidebar_section. Verify its actual entry with native list_threads. Do this for resumed legacy workers too; source labels alone do not establish sidebar visibility.
8. On subsequent passes, use native read_thread/wait_threads snapshots to observe active turns. Record real changed commentary/status with `observe`; do not invent periodic progress. The helper can extract the exact turn's latest commentary, final text and task_complete/turn_aborted event. Never use another turn's final or a title as evidence.
9. Once native App state and the exact turn event confirm terminal, write `{threadId,turnId,status,text}` to a private result file and `complete ID codex-app-controller FILE`. `status` must be completed, failed or interrupted; `text` is the real final result. A task_complete without final text needs reconciliation. Meridian then receives the real result and applies its normal report/validator rules. App completion is not product acceptance.

## Cancellation and recovery

SIGINT/SIGTERM request cancellation while keeping the executor and Hub reservation alive. Pending requests cancel immediately. Claimed/started requests remain `cancel_requested` until the exact App turn terminates. Native tools do not expose a force-interrupt operation: if a turn is still running, send one concise cooperative stop instruction to that same running thread, record its receipt, and wait for actual termination. Do not send a stop after the original turn already ended, as that would create a new turn. A claim cancelled before the durable submit intent becomes cancelled immediately and submit then refuses it. After submit intent, ambiguous submission remains reserved for reconciliation.

Kill/restart/reboot refuse active App worker reservations, including after a Hub restart. The queue uses a kernel-released POSIX flock and fsynced atomic private JSON replacement. A crash cannot leave a stale software lock or permit duplicate execution. Stable request IDs return durable terminal results on transport retry. Do not delete queue records to clear a blocker. Do not disable the controller while App requests remain active. Drain active CLI workers and validators before installing/restarting the live Hub.

## Evidence

Verified native App tool use and sidebar registration:
- Native worker `01a077f2-cf5e-7232-96d7-2534f94a9ea0`, turn `01a077f2-d068-7cd1-b102-ca7d682d8558`.
- Same-session legacy continuation `01a077ec-6d30-7cf2-8df3-ab6852d780e0`, turn `01a077ed-273a-7083-b859-45cadfa29970`.
- Native list_projects succeeded. The true final returned through the Meridian Codex stream adapter.

These are orchestration proofs, not Cyberent product/security acceptance. Smart-contract independent audits, remediation and exact-commit re-audit remain mandatory.
