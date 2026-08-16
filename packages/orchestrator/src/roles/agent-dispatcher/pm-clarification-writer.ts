import { promises as fs } from "node:fs";
import path from "node:path";

import type { ValidatorDelegatableEntry } from "./meridian-status-marker";

/**
 * v1.23.0 — Auto PM Clarification appender.
 *
 * When the validator reports `fix_requested` and emits exactly one
 * `delegatable: ref=<X> target=<Y>` entry whose target resolves to a worker
 * in the dispatch plan, the orchestrator invokes this helper to append a
 * PM-approved clarification section to the worker's report (the file at
 * `workerReportPath`). The clarification cites the validator's delegate ref
 * + target so future re-validation accepts the delegation without re-running
 * the PM resolver.
 *
 * The function is idempotent in the weak sense: it only checks whether a
 * heading line `## PM Clarification — Auto-delegated to <target>` already
 * exists in the file. Duplicate appends are skipped. If the file does not
 * exist yet, it is created with a minimal header.
 *
 * Return value:
 * - `{ appended: true,  headingLine }` when a fresh section was written.
 * - `{ appended: false, headingLine }` when an equivalent section already
 *   exists (idempotent no-op). The orchestrator should still proceed to mark
 *   the worker complete in either case, because a prior clarification is
 *   already authority for the same delegation.
 */
export interface AppendPmClarificationArgs {
  workerReportPath: string;
  workerId: string;
  delegatable: ValidatorDelegatableEntry;
  validatorThreadId: string;
  cycle: number;
  validatorFeedback: string | undefined;
  /** ISO timestamp written into the heading; defaults to new Date().toISOString(). */
  timestamp?: string;
}

export interface AppendPmClarificationResult {
  appended: boolean;
  headingLine: string;
}

export async function appendPmClarification(
  args: AppendPmClarificationArgs
): Promise<AppendPmClarificationResult> {
  const timestamp = args.timestamp ?? new Date().toISOString();
  const headingLine = `## PM Clarification — Auto-delegated to ${args.delegatable.target} (validator cycle ${args.cycle})`;

  let existing = "";
  try {
    existing = await fs.readFile(args.workerReportPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  if (existing.includes(headingLine)) {
    return { appended: false, headingLine };
  }

  const reasonLine = args.delegatable.reason
    ? `- **Reason cited by validator**: ${args.delegatable.reason}`
    : "- **Reason cited by validator**: (none provided)";

  const feedbackBlock = args.validatorFeedback && args.validatorFeedback.trim().length > 0
    ? `\n### Validator feedback (verbatim, cycle ${args.cycle})\n\n\`\`\`\n${args.validatorFeedback.trim()}\n\`\`\`\n`
    : "";

  const section = [
    "",
    "---",
    "",
    headingLine,
    "",
    `Resolver: agent-dispatcher (auto, validator cycle ${args.cycle})`,
    `Validator thread: ${args.validatorThreadId}`,
    `Timestamp: ${timestamp}`,
    "",
    "### Authority",
    "",
    `- The validator's marker (\`<<<MERIDIAN-STATUS>>>\` block, cycle ${args.cycle}) emitted exactly one \`delegatable:\` entry citing **${args.delegatable.ref}** with **target=${args.delegatable.target}** and no \`blocking:\` items.`,
    `- The delegate target **${args.delegatable.target}** is an emitted row in this dispatch plan.`,
    "- Per `/taskspec` v1.23.0 §5.5.c (Applied-Laws ↔ Acceptance consistency) and meridian-roles v1.23.0 auto-clarify policy, when a validator's single delegatable entry resolves to a planned worker, the dispatcher auto-appends this clarification and force-completes the worker without spawning a PM resolver.",
    reasonLine,
    "",
    "### Decision",
    "",
    `The unmet acceptance criterion cited at \`${args.delegatable.ref}\` is formally delegated to **${args.delegatable.target}**. ${args.workerId} acceptance is closed on the remaining criteria; ${args.delegatable.target} inherits the delegated criterion verbatim. If ${args.delegatable.target} fails to meet it, the regression is recorded in ${args.delegatable.target}'s report — it is NOT retried under ${args.workerId}.`,
    feedbackBlock,
    "### Dispatcher action",
    "",
    `Validator-orchestrator auto-marked ${args.workerId} as validated (force-complete) immediately after writing this section. Dispatcher then continues per the normal eligibility loop. No PM resolver was spawned for this clarification.`,
    ""
  ].join("\n");

  await fs.mkdir(path.dirname(args.workerReportPath), { recursive: true });
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fs.writeFile(args.workerReportPath, existing + separator + section, "utf8");

  return { appended: true, headingLine };
}
