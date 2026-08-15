---
name: protect
description: Use when guarding a long-running meridian dispatcher round — after $dispatch, in parallel with $dispatch, or whenever the user asks to "watch", "guard", "shepherd", "babysit", "守护", "观测" a round. Establishes an event-driven watcher (NOT a polling loop), sustains the orchestration through benign stalls, and — when the round provably cannot proceed, cannot self-heal, loops, or is stuck chasing its goal — PAUSES the dispatcher and writes a resolver handoff instead of fixing anything itself. Fixing is $resolve's job.
version: 2.0.0
---

# Protect — Round Watcher & Handoff Author

`$protect` is the **agent-side guard** that runs alongside a meridian agent-dispatcher and keeps the round making progress without polling. It composes with `$dispatch` upstream and `$resolve` downstream:

```
$dispatch <round-dir>            # launches the dispatcher
$protect <dispatcher-thread-id>  # guards it; pauses + hands off when it can't proceed
$resolve <handoff-path>          # a separate session fixes what $protect handed off
```

The three skills are independent. `$protect` doesn't launch a dispatcher; it expects one is already running. Use it after `$dispatch`, or any time you have an `agent-dispatcher-<id>` thread you want escorted to completion.

## Prime directive

**`$protect`'s sole goal is to sustain the orchestration.**

Its field of concern is everything that keeps the round moving:

- **Orchestration-system issues** — dispatcher idling with eligible work, lifecycle state drift, watcher death, plan/thread desync, validator or pm-resolver routing failure.
- **Non-orchestration issues that block or interrupt the orchestration** — service unreachable, expired credentials, held ports/locks, full disks, dead upstream APIs, a repo state the workers can't build on. Not protect's system, but protect's problem, because the round stops.

**`$protect` does not fix either kind.** It confirms the blockage, **pauses the orchestration**, and **writes a handoff** for a dedicated `$resolve` session. The write authority protect gives up — editing plans, commands, worker units, playbooks, or source — is exactly the authority `$resolve` holds.

The division is deliberate. A watcher that fixes is a watcher that stops watching, and a fix invented mid-observation is a fix with no investigation behind it. Protect observes, proves, pauses, documents. Resolve investigates and repairs.

## Philosophy — what `$protect` is NOT

1. **NOT a fixer.** No editing `dispatch_command.md`, `pm_playbook.md`, worker unit files, the dispatch plan, config, or source. No `resume-worker --action retry` as a repair. No `update-status`. If it needs a fix, it needs a handoff.

2. **NOT a `/loop` job.** Do not use `ScheduleWakeup` to poll the dispatcher every N minutes. That burns Anthropic prompt cache every wake and is the wrong tool — `ScheduleWakeup` is for `/loop` dynamic mode where the user asked for time-paced iteration.

3. **NOT a busy-wait.** Do not write `while true; sleep 60; check_status; done` in Bash. That ties up the agent's foreground forever, blocks any other interaction, and costs cache.

4. **NOT a `Bash run_in_background` polling script either.** Background bash is fine for one-shot tasks; for state observation, the harness's `Monitor` tool is purpose-built — each notification is an event, the agent isn't paying cache between events.

5. **NOT preemptive.** While a worker is mid-flight (lifecycle `running` or `awaiting_validation`), DO NOT call `continue-dispatcher`. The dispatcher is single-tick-serial; redundant kicks return `still_blocked` at best and confuse the lifecycle state at worst.

6. **NOT trigger-happy with the pause.** A pause + handoff costs the operator a whole session. It is justified only after the confirmation protocol in Doctrine §4 passes on **two independent observations**. Impatience is the most expensive failure mode this skill has.

7. **NOT a CCB surface.** Meridian orchestration is not a CCB surface. Do not run `ccb-ping`, do not run `ccb-mounted`, do not inspect `.ccb/`, and do not use CCB provider/session state to diagnose, unblock, or protect a Meridian dispatcher. Transport and auth failures in a Meridian round are diagnosed only through Meridian-roles APIs/tools, dispatch lifecycle artifacts, the Hub/agent process logs referenced by Meridian, and the configured `agent_type`/`mode` in the dispatcher role.

## Doctrine

### 1. Establish an event-driven watcher

Use the harness's `Monitor` tool. Its contract: each stdout line from the launched command becomes a notification event, and the agent is re-invoked only when an event arrives or the configured timeout fires. Between events the agent pays no cache.

The shell pattern is a `while`-loop with a `meridian-tool dispatch-status` call inside, that emits a one-line state snapshot only when the state has changed since the last emission. The loop runs for ~3600s and then exits, letting the harness fire a timeout notification so `$protect` can decide to re-arm (round still in flight) or exit (round terminal).

Concrete invocation, with substitutions:

```bash
TID=<dispatcher-thread-id>
PLAN=<absolute path to dispatch_plan.md>
DEADLINE=$(( $(date +%s) + 3600 ))

prev=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  state=$(node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js \
            dispatch-status --plan "$PLAN" 2>/dev/null \
          | head -1)
  if [ "$state" != "$prev" ]; then
    echo "$state"
    prev="$state"
  fi
  sleep 30
done
echo "WATCHER_TIMEOUT_REACHED"
```

Launch it under `Monitor`:

```
Monitor:
  command: <the bash one-liner above, single-quoted properly>
  description: "<round-id> dispatcher worker transitions"
  timeout: 3600
```

The agent gets a notification for every `STATE:` line and for `WATCHER_TIMEOUT_REACHED`. No proactive polling.

Keep a running **observation ledger** in the session (worker, lifecycle, error signature, timestamp) for every event. Doctrine §4's confirmation tests are all "did I see this twice?" tests — they are unanswerable without the ledger.

### 2. Re-arm on timeout

When `WATCHER_TIMEOUT_REACHED` arrives, check round state. If terminal (all workers ✅/⛔/⚠️/skipped, dispatcher `completed` or `plan_complete`), exit `$protect`. If not terminal, launch another `Monitor` with the same command. The harness will batch the second arming the same way as the first; there's no penalty for re-arming.

Threshold: re-arm up to 3 times (~3 hours total). After that, run the Doctrine §4 confirmation protocol: a round that has been in-flight >3h without a terminal transition is a candidate blockage, not automatically one. If §4 passes → pause + handoff. If §4 fails (real work is visibly progressing), tell the operator once — *"Round in-flight >3h, workers still advancing; extending watch"* — and keep re-arming.

A legitimate **owner pause** (a `HUMAN`/`PM` row awaiting a decision) is a resting state, not a stall, and never consumes the re-arm cap.

### 3. Sustainment actions — the only things `$protect` may do on its own

These are not fixes. They are the moves the orchestration would make for itself if it noticed; protect does them so the round doesn't stall on benign gaps.

| Sustainment action | When | Limit |
|---|---|---|
| Re-arm the watcher | `WATCHER_TIMEOUT_REACHED`, round non-terminal | 3× (§2) |
| Re-launch a dead watcher | `Monitor` exits non-zero before timeout | once; second death → handoff |
| `continue-dispatcher` kick | dispatcher idle with dependency-eligible work (below) | once per observed `running:0` state |
| One transient retry | `meridian-tool` returns "service unreachable" | wait 30s, retry once |
| Read anything | always | — |

Meridian-roles' `continue-dispatcher` does NOT always auto-launch the next worker after one reaches terminal. Symptom: a worker goes `🔄 → 🔍 → ✅`, then the dispatch_status snapshot shows `running: 0` and the next dependency-eligible row stays `⬜`. This is benign-but-stalled.

When you observe in an event:
- A worker just transitioned to ✅ or ⛔, AND
- `running: 0` in the same snapshot, AND
- At least one `⬜` row whose `Depends On` workers are all ✅,

Then `continue-dispatcher` once:

```bash
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js \
  continue-dispatcher --dispatcher <TID>
```

Possible responses:
- `{"status":"continued", "worker": "<next-worker>"}` — kick worked; next event will be that worker entering `🔄`. Done.
- `{"status":"still_blocked"}` — read the message. If it cites a worker already `running`, the watcher missed a transition (race between dispatch-status poll and lifecycle update); ignore, the next event will catch up. If it cites a `⏳ PENDING` PM playbook question, that is a C1 candidate — go to §4.
- HTTP timeout — meridian-roles internal is busy launching the next worker. Don't retry; the next event from the watcher will show it.

Do NOT kick more than once per observed `running:0` state. If `running:0` persists across two consecutive events after a kick, C1 is confirmed — go to §4.

### 4. Confirm the blockage before touching anything

**Nothing below happens on one observation.** Every test requires **two independent watcher events** (or two explicit tool readbacks separated in time) showing the same condition. A single bad snapshot is a race, not a blockage.

Before running any test, rule out the three states that look stuck but aren't:

- A `HUMAN`/`PM` row awaiting an owner decision → resting state. Wait.
- A worker inside its validator fix-cycle budget (`🔁`, cycles remaining under `max_fix_cycles`) → the orchestration is self-healing. Wait.
- A worker `running` with visible forward motion in its report or thread narration → working, not stuck. Wait.

Then test for these five confirmation classes. Fire the handoff when **any one** is confirmed.

**C1 · Cannot proceed on its own.**
`running: 0` AND at least one dependency-eligible `⬜` row, AND either (a) a `continue-dispatcher` kick returned non-`continued`, or (b) it returned `continued` but no row entered `🔄` across the next two events. Also fires when `still_blocked` cites a `⏳ PENDING` playbook question with no PM row to answer it.
*Evidence to capture:* both snapshots, the kick's full response, the eligible-row list with their satisfied deps.

**C2 · Cannot self-heal.**
The orchestration's own recovery budget is spent: validator `max_fix_cycles` exhausted (`❌`), or `pm-resolve` ran and the state did not change, or the engine's own retry re-produced a byte-identical `error:` signature.
*Evidence:* the worker report's `error:` + validator `last_feedback` from both cycles, the fix-cycle count, the pm-resolver outcome.

**C3 · Fell into a loop.**
Same `(worker, lifecycle, error-signature)` triple observed ≥3 times; or a `🔁 → 🔍 → 🔁` ping-pong across ≥2 full cycles with no diff in `last_feedback`; or `still_blocked` naming the same worker on ≥2 consecutive kicks.
*Evidence:* the observation-ledger rows proving the repetition, with timestamps.

**C4 · Stuck by goal pursuit.**
The worker is alive and burning tokens but cannot converge, because what it was told to achieve doesn't match what's there: the TaskSpec names a file/API/target that doesn't exist, the acceptance criteria are unreachable as written, or the worker's narration shows it re-scoping in circles. This is the **TaskSpec-shortage** signature and the most valuable handoff protect writes — the round will never finish on its own, no matter how long you wait.
*Evidence:* the declared Done criteria, the worker's narration showing the contradiction, and what the repo actually contains.

**C5 · Non-orchestration blocker.**
The orchestration is healthy but the world under it isn't: meridian-roles unreachable after the one retry, port/lock held, credentials expired, disk full, upstream API down, remote rejecting pushes, build toolchain broken.
*Evidence:* the exact failing command and its full output, plus proof the orchestration itself is otherwise sane.

If none confirms, **do not pause**. Keep watching and stay quiet.

### 5. Pause first — always before the handoff

Order is not negotiable: **confirm → pause → verify paused → write handoff.** A handoff written against a still-moving round is stale before the resolver opens it, and the resolver will be editing plan artifacts under a live dispatcher.

```bash
curl -sS -X POST http://127.0.0.1:7701/api/agent-dispatcher/<TID>/pause
```

Then verify the hold actually took, by re-reading the role:

```bash
curl -sS http://127.0.0.1:7701/api/role/<TID> | head -40
```

Expect status `paused`. A paused role MUST NOT launch from any HTTP path — `continue`/`start-hub-session` are gated on it — so once paused, the plan artifacts are safe to edit.

If the round is scheduler-driven, also pause the scheduler so the next cycle doesn't relaunch around you:

```bash
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js \
  dispatch-schedule-pause --scheduler <scheduler-id>
```

**Do not kill running worker threads.** A worker mid-flight belongs to the resolver's decision, not protect's. Record its thread id in the handoff and leave it alone.

If the pause call fails, retry once; if it still fails, that is itself C5 — say so at the top of the handoff and mark `paused: false` so the resolver knows it is working against a live round.

### 6. Generate the handoff

Write it to the round's `handoff/` sub-folder — a fifth peer of the canonical `prd/ investigate/ taskspec/ test/` layout:

```
<round>/handoff/HANDOFF-<UTCyyyymmdd-HHMM>-<class>-<slug>.md
```

`<class>` is one of `c1-cannot-proceed`, `c2-no-self-heal`, `c3-loop`, `c4-goal-stuck`, `c5-environment`. Create the directory if absent. This is round-scoped and distinct from the project-level `/Users/yzliu/work/Docs/Projects/<repo>/handoff/` knowledge handoffs — do not write orchestration handoffs there.

The document must let a cold resolver session act without re-deriving anything protect already knows:

```markdown
---
handoff_id: <UTCyyyymmdd-HHMM>-<slug>
round: <round-id>
round_dir: <absolute path>
dispatcher: agent-dispatcher-<id>
plan: <absolute path to dispatch_plan.md>
scheduler: <scheduler-id or none>
class: c1 | c2 | c3 | c4 | c5
severity: blocks-round | blocks-worker
created_utc: <ISO8601>
paused: true | false
status: open
author: $protect
---

## 1 · What stopped
One paragraph. What the round was doing, what it stopped doing, and since when.

## 2 · Confirmation evidence
Which class fired, and the two independent observations that confirmed it —
timestamps, snapshots, exact tool responses. Include the ruled-out states
(fix cycles remaining? owner pause? forward motion?) and why each was ruled out.

## 3 · Current orchestration state
Full `dispatch-status` snapshot. Per-row table: worker · lifecycle · symbol ·
depends-on · thread id. Mark which rows are terminal, eligible, blocked, in-flight.

## 4 · Artifacts to read
Absolute paths only: worker report(s) `<round>/taskspec/reports/<WORKER_ID>.md`,
the `dispatch_threads.json` entry, `dispatch_command.md`, `pm_playbook.md`,
the worker unit file, relevant Hub/agent logs.

## 5 · Facts confirmed · Facts unknown
Two explicit lists. Everything protect verified with a command and readback goes
left; everything it did not goes right. Do not launder a guess into the left column.

## 6 · Blast radius & safe state
Branches, worktrees, HEADs, dirty state, open PRs, migrations, external mutations
already performed. What is safe to touch and what is not.

## 7 · Protector hypothesis (NON-BINDING)
Best read of the root cause plus candidate resolution paths with trade-offs.
Explicitly labelled a hypothesis — the resolver must verify independently and is
free to discard this section entirely.

## 8 · Exact resume instruction
The precise commands to un-pause and re-enter, and which row should move next.

## 9 · Verification
What "resolved" looks like observably — the specific row transition that proves it.

## 10 · Resolution log
(left empty — `$resolve` fills this in)
```

### 7. Hand off, then stay armed and quiet

After writing the handoff, emit **one** operator message: what stopped, the class, the handoff path, and the literal invocation line:

```
$resolve <absolute handoff path>
```

Then keep the watcher armed but silent. Do not kick a paused dispatcher. Do not re-diagnose. When the resolver resumes the round, the next state change arrives as a normal event and full doctrine applies again.

**Escalation:** if the same root cause produces a second handoff after a `$resolve` pass, do not write a third. Stop and tell the operator that resolve-protect is cycling on `<root cause>` — that is a human decision, not another document.

## Terminal closeout

Terminal closeout is post-success housekeeping on a round that finished, not a fix — it is permitted, and it is the one place `$protect` mutates repo/ledger state. When the round reaches terminal, **chain straight into it — do NOT stop and wait for the operator**:

1. Read `reports/INTEGRATE.md` for the umbrella PR ref.
2. Run `close-round --round <round> --artifact <slug> --integrate-pr '<PR ref>'`.
3. Advance any ledger clusters whose `dispatched_round` matches this round to `fixed`.
4. Close any orphan `investigated` issues whose clusters are already `fixed` in the ledger.
5. Sweep the series directory: move closed/not_a_bug issue `.md` + sidecar dirs to `closed/`; leave only `new`/`suspected_bug`/`accepted_bug` at root.
6. Delete stale local + remote `bug-fix-<round>/*` branches **whose PR is already merged** — merged-only, never an open PR's branch.
7. Write `runs/YYYY-MM-DD-NN.md`, including any handoffs raised and their resolution status.
8. THEN emit the final summary (one message: PR, closed count, ledger state, cleanup actions, handoffs raised).

Merging and releasing are never protect's call — closeout records delivery, it does not approve it.

## Debug mode (`--debug`) — protect + compound the debug-loop memory

`$protect <dispatcher-thread-id> --debug` runs the **full doctrine above unchanged**, and additionally turns every clawso **debug-loop** (bug-fix) round into compounding institutional memory, so each `--debug` run is smarter than the last. Use it for any debug-loop round. The two knowledge files (the "runbook" the operator means) live in `/Users/yzliu/work/Docs/Projects/clawso/debug-loop/`:

- `carry-forward.md` — **issues to FIX** (actionable, deferred): `CF-NNN` notes a later run/agent can pick up and fix.
- `protect-experience.md` — **experience to LEARN** (symptom → resolution playbook): what worked, what to avoid, recurring failure modes.

These are protect's own memory. Writing them is **not** self-fixing — a `CF` note records a fix for someone else to make, it never makes one.

The cycle is **read → recognize → protect → consolidate**, every run:

1. **Read first.** Before diagnosing anything, read `protect-experience.md` and `carry-forward.md` `## Open`. When a live symptom matches a known row, that match is **confirmation evidence** — it short-circuits Doctrine §4 to a known class and goes into handoff §7 as a cited precedent. It does **not** license protect to apply the known fix itself; a known resolution still travels through `$resolve`. Recognition is protect's job; application is not.
2. **Verify the pre-dispatch issue matrix.** If this `$protect --debug` agent is involved before dispatcher launch, its first operator-visible output must list every current issue's handling plan: problem description, problem source, cluster, planned worker/branch, and solution strategy. Tool manifest problems (`tool.json`, `ui.json`, `tool-importer/listings/*/manifest*`, per-tool generated manifests, manifest schemas/scripts) must be isolated in a separate **Tool Manifest Issues** table. Missing or mixed matrix = do not approve/continue to dispatch. If the dispatcher is already running and the matrix is absent, reconstruct a read-only matrix from the TaskSpec, ledger, source issue files, and reports before intervening, then record the gap in `runs/YYYY-MM-DD-NN.md` or `carry-forward.md`.
3. **Protect (identical doctrine).** Monitor watcher, sustainment kicks, confirm-pause-handoff — exactly as the base skill. `--debug` adds only memory I/O and the pre-dispatch matrix gate, never new intervention authority.
4. **Consolidate — on each handoff and at terminal:**
   - A real bug or loop gap not closed this round → append a **`CF-NNN`** note to `carry-forward.md` `## Open` (id, **Trigger**, **Action** with file paths, **Reason deferred**, **Verify**) so a later agent can CHOOSE to fix it.
   - A symptom→confirmation-class mapping that proved out, or a gotcha → append/upgrade a row in `protect-experience.md` so a later run recognizes it faster.
   - **Dedup**: if a matching entry exists, refine/increment it — never add a second note for the same root cause.
5. **Record** the `CF-NNN` ids reviewed/added, experience rows touched, and handoff ids raised in the round's `runs/YYYY-MM-DD-NN.md`.

## Gate mode (`--gates`) — protect a single-TaskSpec program with owner-authority gates

`$protect <dispatcher-thread-id> --gates` runs the **full base doctrine above unchanged**, and additionally enforces an explicit **G-gate state machine** on top of a long-lived single TaskSpec that carries owner-authority gates (e.g. the `foundation-closure-full-remainder` handoff's `G0…G7`/`G6E`). Use it whenever the TaskSpec encodes named gates that must halt the whole round for an **owner decision** — not just per-worker blockers. It composes with `--quiet`.

### How gates map onto meridian primitives (no engine change required)

A "gate" is a real dispatch-plan row; `--gates` reads its Model and status and applies the right protocol:

| Gate kind | Encode as | meridian behavior | `--gates` duty |
|---|---|---|---|
| **Owner-approval gate** (e.g. `G4` protected cutover, `G6E` external/target) | a `HUMAN` (or `PM`) row | dispatcher **pauses** natively — `service-continuation.ts`/`prompt-builder.ts`: "Only `HUMAN`/`PM` rows → pause" | enter `AWAITING_OWNER_APPROVAL`, emit the Owner Resolution Packet, **wait** for the owner's Gate-ID decision; do NOT advance |
| **Technical gate** (e.g. `G0/G1/G2/G3/G5/G6/G7`) | a validator/`BATCH-GATE` row | `❌`/`⛔` blocks downstream deps | evaluate PASS/FAIL/UNKNOWN/PARTIAL; on non-PASS → `HALT_FOR_OWNER` |

### The gate state machine

Every gate resolves to exactly one of `PASS | FAIL | UNKNOWN | PARTIAL | AWAITING_OWNER_APPROVAL | HALT_FOR_OWNER`.

- **PASS** → let the dispatcher unlock the named downstream rows (normal continuation).
- **AWAITING_OWNER_APPROVAL** (a `HUMAN` gate row): the dispatcher already paused. Do **not** execute the gated mutation/cutover. Emit the Owner Resolution Packet and wait for an owner message that **names the Gate ID**. On approval → resolve the row (`update-status … human_resolution` / the row's own completion) and `continue-dispatcher` — the **same TaskSpec** resumes at the next row. On rejection/hold → leave paused; surface exactly what's blocked.
- **FAIL / UNKNOWN / PARTIAL** (a technical gate): `HALT_FOR_OWNER`. Stop advancing globally at the wave boundary, quiesce dependent writers, **preserve branches/worktrees/logs/DB snapshots/cursors/evidence**, emit the packet, and wait for an explicit owner resolution referencing the Gate ID. Protector may **not** reclassify `UNKNOWN` as pass, reduce acceptance criteria, or route around the gate.

Resolving a gate row on an explicit owner decision — and only on one — is the single mutation `--gates` adds. It is the owner's action executed by protect's hands, not protect's own judgment.

### No repair between gates either

Earlier versions of this skill let `--gates` perform bounded auto-repair inside a failing row's declared scope. That is now `$resolve`'s job. When a non-gate row fails between gates, run the base Doctrine §4 protocol: confirm, pause, write the handoff, and tell the operator. The handoff records the gate context (which gate the round is between, what remains locked) so the resolver's edits stay inside the gate's scope.

### The one hard rule `--gates` keeps: no `force_complete` past a real gate

`force_complete` (or any `update-status`/retry/scope-reduction that advances a gated row) is permitted **only** when ALL of these hold: (1) the technical gate already passed with recorded commands/readbacks; (2) an independent reviewer confirmed the evidence; (3) only the orchestration control-plane status is stale; (4) no checklist criterion, test, review, target readback, or authorization is missing; (5) it is recorded as state-repair, not gate-bypass. It is **forbidden** for a real failure, unknown fact, missing authorization/target, unresolved divergence, or incomplete ledger. If in doubt, `HALT_FOR_OWNER`. This rule binds `$resolve` too — a handoff cannot launder a gate bypass.

Any of these forces an immediate owner stop rather than a resolver handoff, because only the owner can decide them: plan/source fact conflict; proposed architecture/authority change; deletion/replacement of an existing interface; unexplained shadow divergence; force-push/history rewrite; migration-version collision; missing source/target/publication permission; unavailable/mismatched legacy artifact; unrunnable real target; unprovable protected-guardian OS boundary; residual product identity in production control flow; lossy/unprovable rollback; or any critical fact `UNKNOWN`.

### Owner Resolution Packet (every owner stop emits exactly one)

Plain Markdown, no vague "please resolve":

```text
Gate ID · Gate objective · Status (FAIL/UNKNOWN/PARTIAL/AWAITING_OWNER_APPROVAL)
Exact failed or missing criterion
Confirmed facts · Unknown facts
Files / code locations · Commands + full result summary
Current branch / HEAD / worktrees / dirty-state inventory
Commits, PRs, migration IDs, target IDs, cursors, leases, pins
Whether any external or protected mutation already occurred
Blast radius + current safe state
Available resolution paths + consequences/rollback of each
Protector recommendation · Exact owner decision required · Exact row/session to resume after resolution
```

When a gate stop also needs engineering work before the owner can decide, emit the Packet **and** write a §6 handoff, cross-referencing each other.

### Watcher tuning for long programs

These programs run for days across multiple owner pauses. Keep the base `Monitor` watcher, but: (1) treat a `HUMAN`-row pause as a **stable resting state**, not a stall — do not "kick" it and do not run §4 against it; re-arm the watcher and stay quiet until the owner replies or a technical row transitions; (2) the dispatcher may be intentionally **stopped between sessions** — state is on disk; on the next `$protect --gates` invocation, read `dispatch-status` first, check `<round>/handoff/` for open handoffs, and resume from the current gate rather than assuming a fresh round; (3) never let the 3×re-arm cap end the program at a legitimate owner-pause — a pause awaiting owner input is not a hang.

## Worker state vocabulary

| Lifecycle | Plan symbol | Meaning |
|---|---|---|
| `pending` | `⬜` | Not yet launched; waiting on deps or capacity |
| `running` | `🔄` | Worker session active |
| `awaiting_validation` | `🔍` | Worker emitted `complete`; validator is reviewing |
| `fix_requested` | `🔁` | Validator returned `score=0`; worker session re-engaged for fix cycle |
| `completed` | `✅` | Validator approved |
| `failed` | `❌` | Validator rejected after max fix cycles, or worker emitted `failed` |
| `blocked` | `⛔` | Worker emitted `blocked` or `needs_pm` |
| `skipped` | `⛔ SKIPPED` | Operator/PM marked as skipped |
| `human_resolution` set | (any) | Operator marked the worker resolved by hand |

A round is **terminal** when every row is in one of `✅` / `⛔ SKIPPED` / `❌`-with-`human_resolution` / `⚠️ ABANDONED`. Specifically: `isDispatchPlanComplete` in meridian-roles' `role-handlers.ts` accepts ✅ rows whose lifecycle is `completed` and the carve-out for human-resolved.

## Output discipline

While `$protect` is running, the agent talks to the operator only at meaningful inflection points:

- Round-start: one sentence confirming the watcher armed + the worker shape.
- Worker terminal transitions: one short line ("R-01 ✅, R-02 🔄").
- Sustainment kick: one line ("dispatcher idle with R-03 eligible → kicked").
- Handoff raised: one short block — what stopped, class, handoff path, the `$resolve <path>` line.
- Watcher re-arm: one line saying "re-armed N/3".
- Terminal: run the closeout chain above, then one final summary message.

Do NOT echo every event. Do NOT narrate `STATE: ...` lines verbatim — translate them into the column-style status summary the operator actually scans for. Do NOT paste the handoff body into the chat; the operator opens the file.

## Failure modes (and what to do)

| Failure | Action |
|---|---|
| Watcher process dies (Monitor exits non-zero before timeout) | Re-launch once (sustainment). If it dies again → C5 handoff. |
| `meridian-tool` returns "service unreachable" | Wait 30s and retry once. If still failing → C5 handoff naming the meridian-roles tmux session in `reference_meridian_roles_bootstrap_key`. |
| Dispatcher status stays `paused` for >2 events with no handoff open | Someone else paused it. Ask the operator before resuming — never auto-resume a pause you didn't take. |
| Same worker fails twice with the same `error:` | C2/C3 → pause + handoff. Do not retry it a third time. |
| Validator's `max_fix_cycles` exhausted on a worker | C2. If pm-resolver is configured, give it one routing attempt and watch; if state doesn't change → handoff. |
| Worker burning time against unreachable acceptance criteria | C4 → pause + handoff. This is the TaskSpec-shortage case; it will never resolve on its own. |
| Round-terminal but PRs not merged | List open PRs containing the taskspec id; if any are still OPEN, the INTEGRATE row didn't actually merge — surface to the operator before declaring done. |
| A `$resolve` pass returns and the same blockage recurs | Do not write a second handoff for the same root cause. Escalate to the operator. |

## What `$protect` is not allowed to do

- **Cannot fix anything.** No source edits, no config edits, no dependency/env repair, no orchestration changes. Blockages become handoffs.
- **Cannot edit orchestration artifacts** — `dispatch_plan.md`, `dispatch_command.md`, `pm_playbook.md`, worker unit files (`<WORKER_ID>.md`), TaskSpec index. All of these are `$resolve`'s write surface now.
- **Cannot `resume-worker`, `update-status`, or force-complete** as a repair. The one exception is `--gates` resolving a `HUMAN` gate row on an explicit owner decision that names the Gate ID.
- **Cannot mark workers `done` without operator approval.** Force-complete-equivalent actions need explicit out-of-band context from the operator.
- **Cannot delete branches, close PRs, or push to remotes** — except merged-PR branch cleanup during terminal closeout.
- **Cannot kill the dispatcher's running Codex/Claude worker sessions.** Record the thread id in the handoff; killing is the resolver's call.
- **Cannot resume a pause it did not take**, and cannot resume its own pause until the handoff is resolved.

## Quick-start crib sheet

```
You: $protect agent-dispatcher-d42e7103
Agent:
  1. Read /api/role/<TID> for current state + dispatch_plan_path
  2. Check <round>/handoff/ for open handoffs before assuming a fresh watch
  3. Launch Monitor with the state-change watcher; start the observation ledger
  4. Wait for events; for each:
     - terminal + running:0 + eligible row → kick continue-dispatcher (Doctrine §3)
     - anomaly → run the §4 confirmation protocol; needs 2 observations
     - confirmed → pause (§5) → verify paused → write handoff (§6) → emit $resolve line (§7)
     - WATCHER_TIMEOUT → re-arm or run §4 per Doctrine §2
     - all-terminal → closeout chain → final summary
  5. Stay quiet between events
```

## Composition

- `$dispatch` → `$protect <TID>` → `$resolve <handoff>` → back to `$protect` — the full loop.
- `$protect <TID>` alone — when the operator already has a running dispatcher (perhaps from a previous session) and wants it shepherded to completion.
- `$protect <TID> --quiet` — same behavior, suppress all output except handoffs and the terminal summary.
- `$protect <TID> --debug` — protect a clawso debug-loop round AND read/apply + grow the debug-loop memory (`carry-forward.md` issues-to-fix, `protect-experience.md` experience-to-learn). See "Debug mode".
- `$protect <TID> --gates` — protect a long-lived single-TaskSpec program whose plan encodes named owner-authority gates (`G0…G7`/`G6E`). See "Gate mode". Composable with `--quiet`.

## References

- `$resolve` — the counterpart skill that consumes protect's handoffs and holds the write authority protect gives up.
- Monitor tool — harness-native event stream over a long-running command.
- `meridian-tool dispatch-status --plan <path>` — one-shot state snapshot of a dispatch_plan.
- `meridian-tool continue-dispatcher --dispatcher <TID>` — single-tick kick.
- `POST /api/agent-dispatcher/<TID>/pause` — take the operator hold; a paused role cannot launch from any HTTP path.
- `POST /api/agent-dispatcher/<TID>/resume` (or `meridian-tool resume-dispatcher --dispatcher <TID>`) — release it. `$resolve` calls this, not `$protect`.
- `meridian-tool dispatch-schedule-pause --scheduler <id>` — stop the next scheduler cycle from relaunching around a pause.
- `meridian-tool pm-resolve --dispatcher <TID> ...` — the engine's own abnormal-state router; part of self-healing, so give it its chance before C2.
- HTTP route table at `Meridian-roles/src/server/role-handlers.ts`.
- `feedback_no_orphan_wip_across_sessions` (operator memory) — never `git stash` discovered orphan WIP; surface it.
- Origin incident: round `skills-ux-2026-06-04`, dispatcher `agent-dispatcher-d42e7103`, 2026-06-03/04. The operator manually ran every doctrine step in that round. v1.x canonicalized the playbook; v2.0 splits fixing out into `$resolve` so the watcher never stops watching.
```
