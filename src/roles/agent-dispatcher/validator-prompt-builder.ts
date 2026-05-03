import type { ValidatorThresholdType } from "../../types";
import { VALIDATOR_MARKER_OUTCOMES } from "./meridian-status-marker";

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
    thresholdType = "score"
  } = context;

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
<<<END>>>

This block is the ONLY authoritative signal for your verdict. Pick exactly one \`outcome\`:
- \`pass\` — implementation meets the requirements; no rework needed. The worker is finalized.
- \`fix_requested\` — implementation has fixable issues. The worker will be sent your feedback and asked to retry. Use this when issues are remediable.
- \`fail\` — implementation is fundamentally wrong, unrecoverable within this round, or violates a hard constraint. The worker is marked failed and PM resolution is invoked.

For binary-threshold tasks (score is irrelevant), still emit the \`score\` field — use \`1.0\` for \`pass\`, \`0.0\` for \`fail\`, \`0.5\` for \`fix_requested\`. \`cycle\` is the current cycle number you are validating (provided in the Context section above).

If you must reference the marker format earlier in your reply (e.g. for documentation), wrap that example in a fenced code block (\`\`\`\`); only the unfenced block at the end of your reply is parsed.`;

  return `# Role
Code Validator. You review a worker's implementation against the task specification and dispatch plan, then provide ${roleAssessment}.

# Context
- Worker: ${workerId}
- Validation Cycle: ${cycle}/${maxFixCycles}
- Task Branch: ${taskBranch}
- Base Branch: ${baseBranch}
${previousFeedbackSection}
# Instructions
1. Try \`git diff ${baseBranch}..${taskBranch}\` to see all changes made by the worker.
   - If the task/dispatch command declares NO-GIT, document-only delivery, direct filesystem delivery, or the branch is intentionally absent, do not penalize the worker for missing task branches or missing git diff/log evidence.
   - For NO-GIT work, validate the deliverable files, worker report, acceptance checks, and referenced source paths directly.
2. Try \`git log ${baseBranch}..${taskBranch} --oneline\` to review commit history when branch-based delivery is in scope.
${taskspecPath ? `3. Read the task specification at \`${taskspecPath}\` for requirements.\n` : ""}${`${taskspecPath ? "4" : "3"}. Read the dispatch plan at \`${dispatchPlanPath}\` to understand task context and the worker's assigned task (look for worker ID: ${workerId}).`}
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
