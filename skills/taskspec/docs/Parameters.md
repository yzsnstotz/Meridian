  What was added

  Two parameters in a new ## Parameters section (inserted after the intro, before the Upstream Contract section):

  --append <existing-taskspec-directory>

  - Appends new workers to an existing TaskSpec instead of creating fresh artifacts
  - Continues worker IDs from existing highest (e.g. existing R-01–R-09 → new starts at R-10)
  - Appends rows to existing dispatch table/plan, never modifies existing workers
  - Bumps minor version with changelog entry

  --assign-codex

  - Assigns all generated workers to Codex tiers (CODEX / CODEX-HIGH / CODEX-XHIGH) using the assign-codex rubric
  - Generates #### Required Context blocks for each worker inline during generation
  - Swaps the Worker Identity Declaration to the Codex three-tier version
  - Eliminates the need to run assign-codex as a separate step after taskspec

  Combined: --append <path> --assign-codex

  - New workers are Codex-assigned and appended to existing TaskSpec
  - Existing workers are not reassigned (use standalone assign-codex for that)

  --meridian

  - Generates artifacts that compose with the meridian-roles dispatcher runtime
    (/Users/yzliu/work/Meridian/Meridian-roles).
  - Workers MUST NOT write to dispatch_plan.md (lifecycle store owns row status;
    row pre-marked 🔄). Drops the Anti-Collision Protocol claim-stamp and the
    Step 5 mark-✅ writes from the dispatch command and worker template.
  - Every worker file ends with a mandatory `#### Reply Protocol` block that
    emits `<<<MERIDIAN-STATUS>>>` with worker_id / role: worker / outcome
    (complete | failed | blocked | hit_limit | needs_pm) / report_path / notes.
    This is the only authoritative status signal — narrative text is ignored.
  - Workers do not self-promote to ✅ via tests. Validation is delegated to
    meridian-roles' validator role; PM resolution is delegated to the
    pm-resolver role (workers signal `outcome: needs_pm` instead of appending
    pm_playbook §4 rows).
  - Reports must append a dated `## Attempt N` section when the file already
    exists (preserves worker / validator / PM history across retries).
  - Adds `Delivery Mode: GIT | NO-GIT` to Round Context. NO-GIT drops the
    branch / PR / merge cluster from Step 5; reports remain mandatory.
  - Scheduler-aware. When the round runs under meridian-roles' scheduler
    (recurring cycles), workers gain a Runtime field (`agent` vs
    `tool-process`); tool-process rows declare Tool Command + Progress File +
    Expected Outputs (`runs/<run-id>/<worker-id>.md` shape) so process matching
    and output recovery work; agent rows must use SCAN_RUN_ID from the runtime
    preamble verbatim (no `date`/`Date.now()` recomputation); no worker may
    have ID `DISPATCHER` (reserved for synthetic controller bookkeeping); the
    plan resets to ⬜ every cycle, so per-cycle reports live under
    `runs/<SCHEDULER_RUN_ID>/<WORKER_ID>.md`.

  Combined: --meridian --append [--assign-codex]

  - New workers honor every --meridian rule above (and Codex-tier assignment
    when --assign-codex is also active). Existing workers are NOT rewritten,
    but the dispatch_command.md IS rewritten because it is shared by every
    worker — the skill emits a warning so PM can audit pre-existing workers
    that still emit ✅ writes.

  Real-world scenarios

  Scenario 1 — Incremental fix rounds (--append):
  ▎ You ran test round T-03, got a fix PRD with 5 new issues. Your existing TaskSpec v2.4 already has R-01 through R-09 completed. Instead of creating a v2.5 TaskSpec from scratch, you run taskspec --append
  /Users/yzliu/work/Docs/clawso/taskspec/v2.4 — new workers R-10 through R-14 are added to the same dispatch plan, same dispatch command. One unified execution pipeline.

  Scenario 2 — Codex-first execution (--assign-codex):
  ▎ You have a new PRD and want to dispatch entirely to Codex worker sessions. Run taskspec --assign-codex — every worker gets a tier assignment and Required Context block during generation. No second pass with assign-codex needed.

  Scenario 3 — Both together (--append --assign-codex):
  ▎ Your existing TaskSpec v2.4 was executed by Opus. A new fix PRD arrives and you want to dispatch the new workers to Codex. Run taskspec --append /path/to/v2.4 --assign-codex — new Codex-assigned workers are appended. Existing Opus
  workers remain untouched.
