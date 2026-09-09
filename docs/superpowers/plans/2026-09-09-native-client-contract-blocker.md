# Native delegated-task visibility and permission contract

Status: **native-client integration blocked; not fixed by the Meridian transport patch**.
Observed 2026-09-09. This report corrects the earlier explanation that all missing
workers were legacy exec-source sessions. No native binary, settings, transcript,
or state database was modified during this investigation.

## User-visible failures

1. Tasks created through the native App run successfully and have sidebar section
   membership, but are omitted from the ordinary task list.
2. A Hub execution-policy request is not a native permission grant. Delegated
   creation can use the coordinator's selected task permissions rather than Hub
   configuration; the public create/send tools cannot bind the requested policy.

## Exact installed artifact

- Desktop package: openai-codex-electron 26.901.51231.
- Bundled CLI: 0.153.4.
- app.asar SHA-256: 64fc2f27d2dddfa968acfacbe5e4e0328071bdc406351ff4a7d18f0b4692c83d.
- codex binary SHA-256: a30ec314bbd0e3721632234d07db7c99855db3b9f1e32dbe8c791947f07e7629.
- Native asset inspected read-only: webview/assets/app-initial-cadb12d4a15e.js.

## Visibility: mechanism and observations

Three current native task identities were independently checked using
list_threads, read_thread/wait_threads, section membership and read-only SQLite.
All had source=vscode, thread_source=agent_created_thread, archived=0,
nonempty native name, empty preview/legacy title/first_user_message, and actual
executed turns. All three appeared in the section's itemKeys but none appeared
in the flat list. Across the local nonarchived native delegated-task cohort,
27 of 27 had empty first_user_message; the three inspected current tasks also
had preview length zero. The coordinator has source=vscode too, but nonempty
preview and does appear. Thus default source-kind filtering does not explain
these current native workers.

Installed native list tool calls kXi -> iMi -> sMi, which requests ordinary
thread/list with useStateDbOnly=true. The installed binary contains the query
predicate AND threads.preview <> ''. Naming changes name, not preview.
Delegated creation DXi -> QLi -> $Li uses threadSource=agent_created_thread and
native delegation/tool-output input. The original delegation is real, not an
empty task, but does not populate the listing preview.

Read-only discriminating query (substitute exact verified task IDs):
```sql
SELECT id, source, thread_source, archived,
       length(preview) AS preview_length,
       length(name) AS native_name_length,
       preview <> '' AS passes_ordinary_list_predicate
FROM threads
WHERE id IN ('exact-coordinator-id', 'exact-native-worker-id');
```

Observed: coordinator 210/26/1; workers 0/23/0, 0/20/0, 0/19/0.
These are preview length / name length / predicate result. No fake user messages
or internal metadata writes were used to change the result.

The publicly inspectable source at openai/codex commit
808b3411fdd0dd05d7a9f1c221a5bc87934943ac corroborates the mechanism:
[state/runtime/threads.rs](https://github.com/openai/codex/blob/808b3411fdd0dd05d7a9f1c221a5bc87934943ac/codex-rs/state/src/runtime/threads.rs#L1417)
excludes empty preview from ordinary lists, while
[state/extract.rs](https://github.com/openai/codex/blob/808b3411fdd0dd05d7a9f1c221a5bc87934943ac/codex-rs/state/src/extract.rs#L144)
does not derive metadata from response items. This public commit is supporting
source evidence, NOT an assertion that it is the installed binary's commit.
Its section-specific list exception also does not repair the App tool's ordinary
list request.

## Permission: confirmed facts versus unresolved cause

- Current two worker repair turns and the PM creation turn all record
  danger-full-access, disabled profile and approval policy never. They are not
  currently blocked on filesystem permission.
- Older affected native creation explicitly logged the custom profile rather
  than server default; after the actual native setting changed, subsequent
  turns logged :danger-full-access and executed the previously refused commands.
- Installed DXi passes no permission override from the public create schema.
  QLi/$Li derives sourcePermissionSelection through oRi, reading qyr/current
  task permission state. iRi prefers applicable source selection over defaults.
- Public create_thread/send_message_to_thread schemas expose neither a requested
  permission profile nor an effective-profile acknowledgement. They cannot
  implement Hub-managed native permission provisioning as presently exposed.
- Whether the older source selection was a stale renderer cache is still
  unproven. Do not relabel a source-selection observation as a reproduced cache
  synchronization bug, or claim current inheritance itself is broken.
- Meridian commit 3fb36808dd6ce8b461ff01308f3dd5e1c1308f27 preserves requested
  autoApprove/sandboxMode through router, executor and queue. It does not apply
  native permissions; installing/restarting it cannot fix these client gaps.

Official contracts:
[App Server listing](https://learn.chatgpt.com/docs/app-server#threadlist--pagination--filters)
and [subagent permission inheritance](https://learn.chatgpt.com/docs/agent-configuration/subagents).
Low-level App Server capabilities are not capabilities exposed by the current
native App tools. Starting another CLI/App Server is not an equivalent repair.

## Required native-client repair and acceptance

Visibility must be fixed where native delegated creation and catalog persistence
meet: persist a truthful preview of the actual delegation, or admit confirmed
user-facing delegated tasks using a typed visibility contract. Preserve actual
delegation provenance; do not manufacture user messages, rewrite source to user,
or make empty/prewarmed/unrelated internal tasks visible indiscriminately.
Backfill previously affected tasks through the native service's supported
migration path, not ad hoc SQL.

The native permission interface must accept an authorized requested selection,
resolve it against supported profiles and trusted owner policy, apply it before
the first product turn, and return the effective selection and settings revision.
Refresh source settings from authoritative native state when inheritance is
intended. A mismatch must not launch privileged work or be described as missing
owner consent. Existing tasks retain identity; no CLI fallback or blanket grant.

Acceptance must include:
- New local, worktree and projectless delegated tasks are visible in ordinary
  lists and their actual custom section, before and after App restart.
- Historical affected tasks become visible without fake activity, duplicate
  tasks, transcript changes or widening visibility of internal/prewarmed tasks.
- Explicitly changed source selection immediately before delegation is honored;
  effective policy is read back for the exact resulting turn.
- Both authorized full-access and restricted cases preserve intended boundaries;
  explicit false and missing policy remain distinct; validators stay read-only.
- Same-task continuation preserves identity and applies the verified policy
  without duplicate sends, then performs the originally requested scoped work.
- Current actual App UI reproduction must pass. Predicate/unit tests, section
  itemKeys, compiler success and transport roundtrip are not that acceptance.

## Current disposition

Meridian controller guidance is corrected to distinguish empty-preview exclusion,
legacy-source exclusion, actual permission observations and unavailable native
capabilities. This prevents repeating the wrong diagnosis but does not fix the
native App. No runtime fix, native deployment, new public issue, or upstream PR
is claimed by this report. The remaining fix requires a supported client API or
a reviewed/buildable change to the native client, not additional owner grants to
each worker. Existing canonical orchestration and independent validation continue.
