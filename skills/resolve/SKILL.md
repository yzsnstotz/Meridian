---
name: resolve
description: Use when a $protect handoff (or the operator) reports a paused/blocked meridian dispatcher round that needs fixing — "resolve the handoff", "unblock the round", "fix the orchestration", "the dispatcher is stuck", "解阻", "修编排". Investigates to root cause, judges spot-fix vs orchestration-level series fix, asks the operator once with a sharp brief and a recommendation, then executes, resumes the dispatcher, and proves a row moved. NOT for guarding a healthy round (use $protect) and NOT for launching one (use $dispatch).
version: 1.0.0
---

# Resolve — Orchestration Blockage Resolver

`$resolve` is the **repair session** on the other side of a `$protect` handoff. Protect watches and proves a round is stuck; resolve makes it move again.

```
$dispatch <round-dir>            # launches the dispatcher
$protect <dispatcher-thread-id>  # guards it; pauses + writes a handoff when it can't proceed
$resolve <handoff-path>          # THIS SKILL — fixes it, resumes the dispatcher, hands back
```

`$resolve` holds exactly the write authority `$protect` gives up: the dispatch plan, the dispatch command, the worker unit files, the playbook, and — when that is genuinely the root cause — the code and environment underneath.

## Prime directive

**Restore the orchestration's normal proceeding rhythm, and prove it resumed.**

Not "close the handoff." Not "make the error go away." The job is done when a row that was stuck has visibly moved and the dispatcher is advancing under its own power again.

Two operating principles sit above every technique below:

1. **Root cause or nothing.** Never act on the protector's hypothesis. It is written `NON-BINDING` for a reason — it was authored by an agent that was deliberately not investigating. Verify independently, or declare `UNKNOWN` and go back to the operator. A confident wrong fix costs more than an honest unknown.
2. **Ask before you act.** Every mutation passes through one operator gate, with a recommendation and a brief that is *simple and sharp*. Investigation is free and needs no permission; changing the round does.

## Invocation

| Form | Behavior |
|---|---|
| `$resolve <absolute handoff path>` | Canonical. Resolve that handoff. |
| `$resolve <round-dir>` | Take the newest `status: open` handoff in `<round>/handoff/`. If several are open, list them and ask which. |
| `$resolve <dispatcher-thread-id>` | Read the role → plan path → round dir, then as above. |
| `$resolve` (bare) | Search recent round dirs for open handoffs. One → take it. Several or none → ask; never guess a round. |

Flags: `--dry-run` (investigate + brief, stop before the gate), `--spot` / `--series` (force the classification; still investigate, still ask), `--no-resume` (fix but leave the dispatcher paused — for staged multi-handoff repair).

## Phase 0 · Load the ground truth

1. Read the handoff end to end. Note `class`, `paused`, `severity`, and especially §5 **Facts confirmed vs unknown** — the unknown column is your work list.
2. Confirm the pause actually holds: `curl -sS http://127.0.0.1:7701/api/role/<TID> | head -40`. If the role is not `paused`, pause it before editing anything — you cannot safely edit plan artifacts under a live dispatcher.
3. Read the live state yourself; the handoff is a snapshot and may be stale: `meridian-tool dispatch-status --plan <PLAN>`.
4. Load repo canon before touching a repo under `/Users/yzliu/work/Docs/Projects/`: `$read-laws` (binding) and `$reference-learnings` (informing). A blockage that a previous round already solved is in there.
5. If this round has debug-loop memory (`/Users/yzliu/work/Docs/Projects/clawso/debug-loop/`), read `protect-experience.md` and `carry-forward.md ## Open` for a matching symptom.

## Phase 1 · Investigate to root cause

Investigate until you can state the root cause in one sentence with a command or file citation behind it.

Read, in this order — every path is in handoff §4:

1. The failing worker's report — `<round>/taskspec/reports/<WORKER_ID>.md`. The `MeridianStatusMarker` `error:` field and the validator's `last_feedback` are load-bearing.
2. The `dispatch_threads.json` entry — `hub_result.content` is the worker's own narration of what it believed it was doing.
3. The worker unit file `<WORKER_ID>.md` and the shared `dispatch_command.md` — compare **what the worker was told** against **what the repo actually contains**. Most C4 handoffs die right here.
4. `pm_playbook.md` §1 — a known symptom may already have a recorded resolution.
5. The repo itself. Reproduce the failure if it is reproducible. A blockage you cannot reproduce is a blockage you do not yet understand.

Then write down, for yourself, three lines:

```
ROOT CAUSE:  <one sentence, with the evidence that proves it>
WHY IT BLOCKS: <the causal link to the stalled row>
WHY IT WON'T SELF-HEAL: <what the orchestration's own recovery cannot reach>
```

If any of the three is a guess, keep investigating. If it stays a guess, stop — go to Phase 3 and bring the operator an `UNKNOWN`, not a plan.

## Phase 2 · Classify — spot issue or series issue

This single judgment decides the whole shape of the fix.

**SPOT ISSUE** — a single point of failure, contained. One row, one command, one missing fact, one wrong path, one absent precondition. Includes a **single-worker TaskSpec shortage**: this one unit was written without a fact the worker needed. Fix it directly, in place, and move on.

**SERIES ISSUE** — structural. The same shortage will hit other rows, or the plan's shape itself is what's blocking. Fixing one row leaves the round to stall again three rows later. This requires **adjusting the orchestration**, not patching a row.

| Signal | Reads as |
|---|---|
| Failure is unique to one worker's inputs | SPOT |
| A path/flag/precondition is wrong in exactly one unit file | SPOT |
| Environment or credential fault under one step | SPOT (but fix the environment, not the plan) |
| Same shortage is present in the text of ≥2 unit files | SERIES |
| The dependency graph blocks work that is actually ready | SERIES |
| The plan asks for something the repo cannot provide | SERIES |
| Workers keep re-scoping because rows overlap or contradict | SERIES |
| Row count/decomposition is generating more coordination than work | SERIES (over-design) |
| A previous `$resolve` already spot-fixed this same symptom on another row | SERIES — promote it |

**When in doubt, look at the other rows before deciding.** A spot fix applied to a series issue is how a round gets handed off four times.

## Phase 3 · Think before you fix — the responsive gate

Before proposing anything, answer these four. This is the part that separates a resolver from a patcher.

**Q1 · Is what the agents fell into actually what the ultimate goal wants?**
Read the round's PRD/TaskSpec intent, not just the failing row. Sometimes the blockage is the plan correctly refusing to do something the goal never asked for, and the right resolution is to **delete or descope the row**, not to make it succeed. A worker stuck building something nobody needs should be stopped, not unblocked.

**Q2 · Are there alternative solutions?**
The obvious fix is rarely the only one. Enumerate at least one real alternative — a different row to change, a cheaper mechanism, a reorder, a merge, a deletion — and know why you're not recommending it. If you cannot name an alternative, you have not understood the problem yet.

**Q3 · Is the orchestration over-designed here?**
Over-decomposition is the most common series issue in mature rounds: rows that gate each other for no reason, a wave boundary that serializes independent work, a validator row that duplicates what CI already proves, three workers where one would do. If the round is fighting its own structure, **simplify the structure**. Deleting a row is a legitimate, often superior fix.

**Q4 · What is the minimum change that restores rhythm?**
Prefer, in order: unblock without editing → edit one command/unit → adjust deps → add/merge/delete rows → change the plan's shape. Do not touch approved architecture, acceptance criteria, authority ownership, or public compatibility to make a round move. Those are owner decisions, and they escalate rather than resolve.

## Phase 4 · Ask the operator — one gate, one sharp brief

**No mutation happens before this gate.** Exactly one ask. Simple and sharp — the operator should be able to decide in fifteen seconds. Use `AskUserQuestion` with the recommendation as the first option.

The brief is capped at ~10 lines. This shape, nothing more:

```text
BLOCK      <what stopped, one line>
ROOT CAUSE <one line + the evidence that proves it>
CLASS      spot | series   (why, ≤8 words)
RECOMMEND  <exactly what I'd do>
ALT        A) <alternative + trade-off>   B) <alternative + trade-off>
TOUCHES    <files / rows that change>
RISK       <what could go wrong, one line>
RESUME     <the row that moves next if this works>
```

Rules for the brief:

- **Do not re-narrate the handoff.** The operator can open it. Say what you found that protect didn't.
- **No hedging paragraphs, no options-survey.** Recommend one thing.
- If the root cause is `UNKNOWN`, say so as the headline and ask for the specific fact you're missing — never present a guess as a recommendation.
- If Q1 says the row shouldn't exist, or Q3 says the round is over-designed, **lead with that**. "Delete R-05 and R-06; R-04 already covers it" is a better brief than a clever patch.
- If the fix would cross into owner-decision territory (architecture, acceptance criteria, external mutation, a `--gates` gate), do not propose it — surface it as an owner decision and stop.

Then wait. Execute only what the operator approved, and only that.

## Phase 5 · Execute

### Spot fix

Fix the actual thing, in the smallest correct place:

- Missing/wrong instruction → edit `dispatch_command.md` (shared) or the worker unit file `<WORKER_ID>.md` (single row).
- Missing precondition the worker can't create → create it, or add the step that does, idempotently.
- Environmental (C5) → repair the environment: restart the service, clear the lock, refresh the credential, free the port. Then verify with the command that failed.
- Genuine code defect blocking the round → fix it if it is small and clearly in scope; otherwise it belongs to a worker row, not to you.

Then record the symptom → resolution in `pm_playbook.md` §1 so the dispatcher, validator, and pm-resolver all catch it next time, in this round and future ones.

### Series fix — adjust the orchestration

Use the full toolkit: **add / adjust / edit / delete**.

| Means | Use when | Mechanics |
|---|---|---|
| **Add** | Work the plan needs but never allocated (a setup row, a gate, a missing unit) | New row in `dispatch_plan.md` + a matching `<WORKER_ID>.md`; wire its deps both directions |
| **Adjust** | Right work, wrong ordering/deps/model/scope boundary | Edit deps or the row's scope; keep every dependency reachable |
| **Edit** | Right rows, wrong instructions — the shortage is in the text | Rewrite the unit files / `dispatch_command.md` for every affected row, not just the one that failed |
| **Delete** | The row is redundant, over-designed, or chasing something the goal doesn't want | Remove the row, re-point its dependents, and record why in the amendment |

Consistency rules — a broken plan is worse than a blocked one:

1. `dispatch_plan.md` rows and `<WORKER_ID>.md` files stay one-to-one. No orphan file, no row without a unit.
2. Never orphan a dependency. After any add/delete, walk every `Depends On` and confirm each named worker still exists and is reachable.
3. Do not renumber existing workers. Append new ids (`R-07a`) rather than shifting a numbering the reports and threads already reference.
4. Do not rewrite rows that are already `✅`. History stands; fix forward.
5. Apply the fix to **every** row carrying the same shortage — that is what makes it a series fix instead of another spot fix.

Record the amendment in the handoff under `## Orchestration Amendment`: every row added/edited/deleted, before → after, and the one-line reason.

### Recovering the stuck worker

Once the cause is fixed, pick the lifecycle action deliberately:

- `resume-worker --plan <PLAN> --worker <ID> --action retry` — the normal path; the fix is now in the instructions the worker will re-read.
- `resume-worker --action force-complete --force true` — **only** when the work provably landed out-of-band, with the readback recorded in the amendment.
- `--action skip` — **almost never.** A skipped row tells every future reader the work was unimportant. If the work truly isn't wanted, *delete* the row with a recorded reason instead.
- A worker thread genuinely hung → `meridian-tool kill --thread_id <id>` then retry, as one unit.

## Phase 6 · Proceed the dispatcher — the mandatory close

A fix that doesn't restart the round is not a fix.

```bash
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js \
  resume-dispatcher --dispatcher <TID>
# scheduler-driven rounds also need:
node .../meridian-tool.js dispatch-schedule-resume --scheduler <scheduler-id>
node .../meridian-tool.js continue-dispatcher --dispatcher <TID>
```

Then **prove it moved**: read `dispatch-status` twice, separated in time, and confirm a row actually transitioned — `⬜ → 🔄`, or the stuck row leaving its stuck state. `{"status":"continued"}` is a claim, not evidence.

If nothing moves, the root cause was wrong. **Go back to Phase 1** — do not stack a second fix on an unverified first one. If the second pass also fails to move it, stop and bring the operator a `UNKNOWN` brief; do not keep trying.

Unless `--no-resume` was passed, `$resolve` does not end with the round still paused.

## Phase 7 · Write back and hand control back

1. Fill handoff **§10 Resolution log**: root cause, classification, what the operator approved, what changed (paths), the resume commands run, and the observed transition that proved it. Set frontmatter `status: resolved`, add `resolved_utc` and `resolver: $resolve`.
2. Add the `## Orchestration Amendment` block for any series change.
3. Append the symptom → resolution to `pm_playbook.md` §1.
4. Debug-loop rounds: upgrade `protect-experience.md` with the confirmed mapping; if something real was found but deliberately deferred, add a `CF-NNN` note to `carry-forward.md ## Open`. Dedup — refine an existing entry rather than adding a twin.
5. Tell the operator in **≤5 lines**: root cause · class · what changed · the row now moving · handoff marked resolved.
6. Hand back to `$protect`. If a protect session is still armed, its watcher will pick up the resumed round as a normal event. If not, tell the operator to re-arm: `$protect <TID>`.

## Boundaries — what `$resolve` may not do

- **Cannot guess.** No fix on an unverified root cause. `UNKNOWN` goes back to the operator.
- **Cannot skip the ask gate.** Investigation is free; mutation is not. One gate, always, before the first edit.
- **Cannot reduce acceptance criteria, scope, or test coverage** to make a row pass. That is fabricating success.
- **Cannot `force_complete` past a real gate.** In `--gates` programs this is absolute: force-complete is state-repair only, permitted solely when the gate already passed with recorded evidence, independently confirmed, with nothing missing. A handoff does not launder a gate bypass.
- **Cannot change approved architecture, authority ownership, public compatibility, or the target set** — those escalate to the owner, they don't resolve.
- **Cannot merge PRs, push to protected branches, delete branches, or rewrite history.** Delivery is the operator's call.
- **Cannot rewrite completed (`✅`) rows or their reports.** Fix forward.
- **Cannot `git stash` discovered orphan WIP.** Surface it — see `feedback_no_orphan_wip_across_sessions`.
- **Cannot leave the round paused** without `--no-resume` and an explicit line telling the operator why.

## Failure modes

| Failure | Action |
|---|---|
| Handoff's hypothesis is wrong | Expected. Discard §7 and investigate from §4's artifacts. Note the divergence in §10 so protect's classifier improves. |
| Root cause won't confirm | Do not fix. Bring an `UNKNOWN` brief naming the exact missing fact. |
| Fix applied, nothing moves | Back to Phase 1 once. Second failure → stop, escalate to operator. |
| Blockage is really an owner decision | Don't resolve it. Emit the decision request and stop; in `--gates` rounds use the Owner Resolution Packet format. |
| Multiple open handoffs on one round | Resolve the one blocking the earliest row first; re-read the others afterward — one root cause often closes several. |
| Same handoff class returns after resolution | Your fix was spot, the issue was series. Re-classify at Phase 2 and fix the whole family. |
| Operator rejects the recommendation | Execute their choice, or if it conflicts with a boundary above, say so in one sentence and ask once more. |
| Plan edited but round already resumed by someone else | Stop, re-pause, re-read `dispatch-status`, and reconcile before continuing — concurrent edits to a live plan corrupt lifecycle state. |

## Quick-start crib sheet

```
You: $resolve /path/to/<round>/handoff/HANDOFF-20260804-1130-c4-goal-stuck-r05.md
Agent:
  0. Read handoff + verify pause holds + read live dispatch-status + $read-laws
  1. Investigate to root cause from reports / threads / unit files / repo
  2. Classify spot vs series (check the OTHER rows before deciding)
  3. Q1 goal? Q2 alternatives? Q3 over-designed? Q4 minimum change?
  4. ONE sharp brief + recommendation → operator gate → wait
  5. Execute exactly what was approved (spot fix, or add/adjust/edit/delete)
  6. resume-dispatcher → continue-dispatcher → PROVE a row moved
  7. Fill §10 + amendment + pm_playbook, ≤5-line report, hand back to $protect
```

## Composition

- `$protect <TID>` → handoff → `$resolve <handoff>` → `$protect <TID>` — the standard loop.
- `$resolve <round-dir>` — operator noticed the stall themselves and there's an open handoff waiting.
- `$resolve <TID> --dry-run` — investigate and brief only; useful when the operator wants the diagnosis before committing a session to the repair.
- `$resolve ... --no-resume` — part of a staged repair where several handoffs must land before the round restarts.

## References

- `$protect` — the watcher that authors the handoffs this skill consumes, and the authority boundary this skill inherits.
- `$dispatch` — canonical round layout (`prd/ investigate/ taskspec/ test/`, plus `handoff/`), and how rounds are launched.
- `$taskspec` — the generator whose shortages produce most C4 handoffs; series fixes should mirror its unit-file conventions.
- `$read-laws` / `$reference-learnings` — binding repo canon and prior findings; read before touching a `Projects/<repo>` tree.
- `meridian-tool dispatch-status | resume-dispatcher | continue-dispatcher | resume-worker | update-status | kill | pm-resolve | dispatch-schedule-resume` — the control surface.
- `POST /api/agent-dispatcher/<TID>/{pause,resume,continue}` — HTTP equivalents; route table in `Meridian-roles/src/server/role-handlers.ts`.
- `feedback_just_do_obvious_git_workflow` (operator memory) — don't ask permission for obvious mechanical follow-ups *inside* an already-approved fix; the Phase 4 gate covers the decision, not every keystroke.
