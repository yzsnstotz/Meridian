import * as fs from "node:fs";
import path from "node:path";

import type { ValidatorThresholdType } from "../../types";
import { VALIDATOR_MARKER_OUTCOMES } from "./meridian-status-marker";

// The Context Capsule is the curated, row-scoped brief the worker already
// receives: Objective / Upstream Inputs / Required Decisions / Applicable Laws
// / Files Owned / Explicitly Forbidden / Required Deletions / Acceptance
// Commands / Known Blockers. It is exactly the validator's checklist, and the
// validator was the only side of the pair not getting it — it got a *path* to
// the dispatch plan and "go find your row", so every validator re-read the
// whole plan document to locate one row: 664 lines / 23,500 chars on the live
// unification-layer-decoupling-2026-08-06 round, across 32 validator sessions
// totalling 2.87h.
//
// Derived from `dispatchPlanPath` rather than added as a config field. Same
// precedent as `dispatch_threads.json` (see resolveDispatchThreadPath): the
// capsule directory is a fixed sibling of the plan, so deriving it keeps one
// source of truth and needs no migration of every persisted dispatcher config.
// A config field would also have to be back-filled on rounds that predate it,
// which is precisely the case the null fallback already handles for free.
const VALIDATOR_CONTEXT_CAPSULE_DIRNAME = "context";

// Defensive bound on what gets inlined. Do NOT read this as "capsules are
// ~2.6KB" — measured across the 75 capsules of the live
// unification-layer-decoupling-2026-08-06 round: median 2,438 chars, p90 3,564,
// max 7,200 (W1-01). 12,000 leaves ~1.7x headroom over the observed max while
// still hard-bounding a pathological generator output, so in practice nothing
// truncates and the cap only earns its keep on an anomaly. When it does fire,
// the validator is told the capsule was cut and where to read the rest —
// silently judging a partial scope is the failure mode worth preventing.
export const VALIDATOR_CONTEXT_CAPSULE_MAX_CHARS = 12_000;

export interface ValidatorContextCapsule {
  path: string;
  content: string;
  truncated: boolean;
  originalChars: number;
}

export interface ValidatorPromptContext {
  workerId: string;
  taskBranch: string;
  baseBranch: string;
  taskspecPath: string | null;
  dispatchPlanPath: string;
  cycle: number;
  maxFixCycles: number;
  previousFeedback: string | null;
  thresholdType?: ValidatorThresholdType;
  /**
   * Inlined Context Capsule for this row, or null when the round has none.
   * Null must produce a byte-identical prompt to the pre-capsule builder —
   * older rounds and rows without a capsule still validate exactly as before.
   */
  contextCapsule?: ValidatorContextCapsule | null;
  /**
   * The row's `expected_outputs` from the lifecycle store — always absolute.
   *
   * Without this the validator infers the report path from the capsule's
   * `## Files Owned`, which lists it relative (`reports/<id>.md`), and resolves
   * it against its own cwd: the worker's git worktree, where no `reports/`
   * directory exists or should. Observed on agent-dispatcher-abd83457: C-02
   * carried "report is still missing" as a blocking finding through all five
   * validation cycles while the 94 KB report sat at its canonical path, and
   * the row died at max_cycles with its actual code work already accepted.
   */
  expectedOutputs?: readonly string[];
}

export function resolveValidatorContextCapsulePath(
  dispatchPlanPath: string,
  workerId: string
): string {
  // Exact worker id, no normalisation: capsule filenames preserve the plan's
  // own casing, including lowercase variant suffixes (C-04a-context.md), and
  // the directory also holds non-capsule files (the generator script and its
  // tests), so an exact filename is what keeps this from matching them.
  return path.join(
    path.dirname(dispatchPlanPath),
    VALIDATOR_CONTEXT_CAPSULE_DIRNAME,
    `${workerId.trim()}-context.md`
  );
}

export interface LoadValidatorContextCapsuleOptions {
  maxChars?: number;
  readFile?: (filePath: string) => string;
  log?: Pick<typeof console, "warn">;
}

/**
 * Best-effort read of the row's Context Capsule. Returns null for every failure
 * mode — missing file, unreadable file, empty file — because a validation must
 * never be blocked or crashed by a missing brief. Null routes the caller back
 * to the exact pre-capsule prompt.
 *
 * Synchronous on purpose, matching `LifecycleStore.load()`, which already does
 * a `readFileSync` of `dispatch_threads.json` — the capsule's sibling in the
 * same directory — on every tick of this same code path. Beyond consistency it
 * is load-bearing: an awaited `fs/promises` read costs a threadpool round trip,
 * i.e. a whole extra macrotask, and `executeValidationCycle` fires
 * `meridianApi.run` from a background continuation whose spawn/run timing the
 * server contract depends on ("returns immediately after starting validation").
 * Adding a macrotask there delayed the run call past the point callers observe
 * it. A ~3KB local read (measured p90 across 75 live capsules) is not worth a
 * scheduling change on that path.
 */
export function loadValidatorContextCapsule(
  dispatchPlanPath: string,
  workerId: string,
  options: LoadValidatorContextCapsuleOptions = {}
): ValidatorContextCapsule | null {
  const capsulePath = resolveValidatorContextCapsulePath(dispatchPlanPath, workerId);
  const maxChars = options.maxChars && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : VALIDATOR_CONTEXT_CAPSULE_MAX_CHARS;
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));

  let raw: string;
  try {
    raw = readFile(capsulePath);
  } catch (error) {
    // ENOENT is the ordinary case on any round generated before capsules, and
    // on rows the generator skipped — not worth a log line every cycle. Only
    // surface the surprising failures (permissions, directory-in-place, I/O).
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      options.log?.warn("Validator context capsule unreadable; falling back to plan-read prompt", {
        worker_id: workerId,
        capsule_path: capsulePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  }

  const content = raw.trim();
  if (content.length === 0) {
    // An empty capsule cannot be "the authoritative scope for this row"; it
    // would just delete the plan-read instruction and give nothing back.
    return null;
  }

  if (content.length <= maxChars) {
    return { path: capsulePath, content, truncated: false, originalChars: content.length };
  }

  // Cut on a line boundary so the inlined fragment never ends mid-sentence,
  // mid-fence, or (with CJK capsules) mid-character.
  const hardCut = content.slice(0, maxChars);
  const lastNewline = hardCut.lastIndexOf("\n");
  const truncated = lastNewline > 0 ? hardCut.slice(0, lastNewline) : hardCut;

  return {
    path: capsulePath,
    content: truncated,
    truncated: true,
    originalChars: content.length
  };
}

export function buildDefaultValidatorPrompt(context: ValidatorPromptContext): string {
  const {
    workerId,
    taskBranch,
    baseBranch,
    taskspecPath,
    dispatchPlanPath,
    cycle,
    maxFixCycles,
    previousFeedback,
    thresholdType = "score",
    contextCapsule = null
  } = context;

  // Every capsule-derived fragment collapses to "" when there is no capsule,
  // so the absent case renders byte-for-byte identically to the pre-capsule
  // prompt. Rounds generated before capsules existed must not shift at all.
  const capsuleTruncationNotice = contextCapsule?.truncated
    ? `

[TRUNCATED — capsule is ${contextCapsule.originalChars} characters, inlined the first ${contextCapsule.content.length}. Read the full capsule at \`${contextCapsule.path}\` before judging scope; do NOT treat the fragment above as the complete scope.]`
    : "";
  const contextCapsuleSection = contextCapsule
    ? `
# Context Capsule — authoritative scope for ${workerId}
Same curated brief the worker received, and the authoritative scope for THIS row. Judge against it directly: \`## Acceptance Commands\` are the acceptance checks; \`## Explicitly Forbidden\` and \`## Files Owned\` define scope violations.

${contextCapsule.content}${capsuleTruncationNotice}
`
    : "";

  const previousFeedbackSection = previousFeedback
    ? `
## Previous Feedback (Cycle ${cycle - 1})
The following feedback was provided in the previous validation cycle. Verify that each issue has been addressed:

${previousFeedback}
`
    : "";

  const previousFeedbackCheck = previousFeedback
    ? "   - Previous feedback: Were all previously flagged issues resolved?"
    : "";
  const isBinaryThreshold = thresholdType === "binary";
  const roleAssessment = isBinaryThreshold
    ? "a binary pass/fail verdict"
    : "a structured quality assessment with a confidence score";
  const noGitPassingInstruction = isBinaryThreshold
    ? "return a positive verdict and mention the metadata observation as non-blocking feedback."
    : "assign a passing score and mention the metadata observation as non-blocking feedback.";
  const evaluationGuidelines = isBinaryThreshold
    ? `# Binary Verdict Guidelines
- **positive true**: All task requirements and acceptance checks are satisfied, with no blocking correctness, completeness, quality, test, or branch-delivery issue.
- **positive false**: Any blocking issue remains, including unmet requirements, incorrect behavior, missing required tests, broken acceptance checks, or unresolved previous feedback.`
    : `# Scoring Guidelines
- **0.9 – 1.0**: Perfect or near-perfect — all requirements met, clean code, tests present
- **0.7 – 0.8**: Minor issues — small gaps in tests or style, but functionally complete
- **0.5 – 0.6**: Moderate issues — missing edge cases, incomplete tests, or partial implementation
- **0.3 – 0.4**: Significant gaps — major requirements unmet or bugs present
- **0.0 – 0.2**: Fundamentally incomplete or wrong approach`;

  // The saving is in the DOWNGRADE, not in adding the capsule: inlining the
  // brief while still telling the validator to read the whole plan makes the
  // prompt strictly larger. With a capsule present the plan is demoted from
  // "read it to find your row" to "consult only for cross-row facts" — and the
  // one cross-row fact the protocol genuinely needs is named explicitly, so the
  // Delegatable Acceptance Detection contract below (which requires confirming
  // the named target is an emitted plan row) still has its source.
  const dispatchPlanStepNumber = taskspecPath ? "4" : "3";
  const dispatchPlanStep = contextCapsule
    ? `${dispatchPlanStepNumber}. Do NOT re-read the dispatch plan to reconstruct this row's scope — the Context Capsule above states it. Consult \`${dispatchPlanPath}\` ONLY for cross-row context, e.g. confirming a worker named in \`delegatable:\` is an emitted row.`
    : `${dispatchPlanStepNumber}. Read the dispatch plan at \`${dispatchPlanPath}\` to understand task context and the worker's assigned task (look for worker ID: ${workerId}).`;

  const replyProtocol = `# Reply Protocol
Your final reply MUST end with exactly one status block, plain text, NOT inside a code fence:

<<<MERIDIAN-STATUS>>>
worker_id: ${workerId}
role: validator
outcome: ${VALIDATOR_MARKER_OUTCOMES.join(" | ")}
cycle: ${cycle}
score: <0.0 to 1.0>
feedback: |
  <multiline feedback — describe what passed and what (if anything) needs fixing.
   Reference file paths, function names, line numbers when possible. The
   feedback is sent verbatim to the worker for remediation when outcome
   is fix_requested.>
delegatable: |
  <OPTIONAL multi-line. Use ONLY when outcome=fix_requested and the unmet
   acceptance criterion is already explicitly delegated to another worker by
   the worker's own spec (e.g. its \`#### Applicable Laws\` section cites
   "acceptance is the V-01 desktop run"). One entry per line:
     ref=<file:line-or-section> target=<other-worker-id> reason=<short>
   Example:
     ref=R-04.md:155 target=V-01 reason=Applied Laws delegates desktop run
   When you emit a single delegatable entry whose target is an emitted plan
   row AND no blocking entry is set below, the dispatcher will auto-append
   a PM Clarification to the worker's report and force-complete WITHOUT
   spawning a PM resolver. Be precise — wrong target or wrong ref will
   either auto-block the override or auto-clarify an unsafe completion.>
blocking: |
  <OPTIONAL multi-line. Use ONLY when outcome=fix_requested AND there is at
   least one criterion that is NOT delegable and MUST be fixed by the worker
   itself before pass. One free-text criterion per line. The presence of any
   blocking line disables the auto-clarify fast path even if delegatable is
   set; the PM resolver runs as usual.>
<<<END>>>

This block is the ONLY authoritative signal for your verdict. Pick exactly one \`outcome\`:
- \`pass\` — implementation meets the requirements; no rework needed. The worker is finalized.
- \`fix_requested\` — implementation has fixable issues. The worker will be sent your feedback and asked to retry. Use this when issues are remediable.
- \`fail\` — implementation is fundamentally wrong, unrecoverable within this round, or violates a hard constraint. The worker is marked failed and PM resolution is invoked.

For binary-threshold tasks (score is irrelevant), still emit the \`score\` field — use \`1.0\` for \`pass\`, \`0.0\` for \`fail\`, \`0.5\` for \`fix_requested\`. \`cycle\` is the current cycle number you are validating (provided in the Context section above).

# Delegatable Acceptance Detection (v1.23.0)
When you would emit \`outcome: fix_requested\` because the worker did not produce a required acceptance artifact (e.g. a real foreground latency measurement, a screenshot, a manual stopwatch run), FIRST check whether the worker's own spec explicitly delegates that acceptance to another worker. The signal phrases live in the worker spec's \`#### Applicable Laws\` section and read like:
- "acceptance is the V-01 desktop run with measured latency < 1500ms"
- "acceptance is owned by <other-worker>"
- "real-binary acceptance is <other-worker>"
- "delegated to <other-worker>"

When such phrasing is present AND the named other-worker is an emitted row in the dispatch plan, emit a single \`delegatable:\` line citing the spec location + target instead of (or in addition to) demanding the worker self-perform the acceptance. The dispatcher's auto-clarify branch will then append a PM Clarification to the worker's report and force-complete — no PM resolver, no human escalation. If you also detect a non-delegable issue, list it under \`blocking:\` instead; presence of \`blocking:\` disables the auto-clarify path.

If you must reference the marker format earlier in your reply (e.g. for documentation), wrap that example in a fenced code block (\`\`\`\`); only the unfenced block at the end of your reply is parsed.`;

  const expectedOutputsSection = (context.expectedOutputs ?? []).length > 0
    ? `- Worker Report / Expected Outputs (ABSOLUTE paths — the canonical artifacts):\n${(context.expectedOutputs ?? [])
        .map((output) => `  - ${output}`)
        .join("\n")}\n  ⚠️ These paths are absolute and live in the TaskSpec directory, NOT inside the worker's git worktree. Read them exactly as written. A missing \`reports/\` directory inside the worktree is expected and is NOT a finding.\n`
    : "";

  return `# Role
Code Validator. You review a worker's implementation against the task specification and dispatch plan, then provide ${roleAssessment}.

# Context
- Worker: ${workerId}
- Validation Cycle: ${cycle}/${maxFixCycles}
- Task Branch: ${taskBranch}
- Base Branch: ${baseBranch}
${expectedOutputsSection}${previousFeedbackSection}${contextCapsuleSection}
# Instructions
1. Try \`git diff ${baseBranch}..${taskBranch}\` to see all changes made by the worker.
   - If the task/dispatch command declares NO-GIT, document-only delivery, direct filesystem delivery, or the branch is intentionally absent, do not penalize the worker for missing task branches or missing git diff/log evidence.
   - For NO-GIT work, validate the deliverable files, worker report, acceptance checks, and referenced source paths directly.
2. Try \`git log ${baseBranch}..${taskBranch} --oneline\` to review commit history when branch-based delivery is in scope.
${taskspecPath ? `3. Read the task specification at \`${taskspecPath}\` for requirements.\n` : ""}${dispatchPlanStep}
${taskspecPath ? "5" : "4"}. Evaluate the implementation against:
   - **Correctness**: Does it implement what was specified in the task?
   - **Completeness**: Are all sub-tasks and acceptance criteria addressed?
   - **Quality**: Code style, error handling, edge cases
   - **Tests**: Are new/updated tests present where appropriate?
   - **Branch strategy**: Are commits on the correct branch when branch-based delivery is required?
${previousFeedbackCheck}

# NO-GIT and Lifecycle Metadata Rules
- If the dispatch command says the lifecycle store manages plan status updates, treat dispatch-plan status symbols as service metadata. Review the sibling \`dispatch_threads.json\` when present.
- Do not fail an otherwise valid deliverable solely because the dispatch plan row still shows a lifecycle-managed transient symbol such as \`🔍\`, \`🔁\`, or \`🔄\`, or because branch/diff evidence is unavailable in a documented NO-GIT round.
- If deliverables, reports, and acceptance checks satisfy the worker instructions and the only remaining concern is NO-GIT branch absence or lifecycle-managed plan-row status drift, ${noGitPassingInstruction}

${evaluationGuidelines}

${replyProtocol}

# Constraints
- You are in READ-ONLY mode. Do NOT modify any files or make any commits.
- Do NOT create pull requests or merge branches.
- Focus exclusively on reviewing the diff and providing your assessment.
`;
}
