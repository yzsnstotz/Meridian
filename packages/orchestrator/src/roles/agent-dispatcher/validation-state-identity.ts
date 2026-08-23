import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ValidationStateIdentity,
  ValidationStateIdentityComponent,
  ValidationStateIdentityComponentStatus
} from "../../types";
import { resolveValidatorContextCapsulePath } from "./validator-prompt-builder";

/**
 * ─── Why this module exists ────────────────────────────────────────────────
 *
 * The validator's `fix_requested` branch used to guard on ONE thing: the cycle
 * counter. Nothing checked whether anything had actually CHANGED between cycle
 * N and cycle N+1, so a row whose worker was not permitted to change anything
 * could be re-validated until its budget ran out, paying a full worker resume
 * plus a full validator session (~47k tokens of tool output, median) for each
 * pass that could not possibly produce a different verdict.
 *
 * Observed on round `unification-layer-decoupling-2026-08-06`, worker
 * `BATCH-8-GATE`: cycles 1-4 all returned `fix_requested` with an identical
 * objection set and a score stuck at 0.5, each "rework" finishing in 56-79
 * seconds. The worker itself published SHA-256 digests of its task card and
 * context capsule to prove the inputs were byte-identical across all four
 * cycles. The orchestrator never made that check. This module is that check.
 *
 * ─── What identity means ───────────────────────────────────────────────────
 *
 * A fingerprint is a digest over four components, each carrying an EXPLICIT
 * observation status so "we saw nothing" can never be confused with "we saw
 * that nothing changed":
 *
 *   branch   the row's branch head commit (`<branch>@<sha40>`)
 *   card     the row's task card, `<WORKER_ID>.md` next to the dispatch plan
 *   capsule  the row's context capsule, `context/<WORKER_ID>-context.md`
 *   outputs  every declared `expected_outputs` file (the worker's report)
 *
 * Statuses:
 *   present     bytes were read and digested — real evidence
 *   absent      the artifact legitimately does not exist for this row
 *               (a NO-GIT row has no branch; a pre-capsule round has no
 *               capsule; a worker that has not written its report yet)
 *   unresolved  the artifact was DECLARED but could not be observed
 *               (branch named but `git rev-parse` failed; file present but
 *               unreadable). This is ignorance, not evidence.
 *
 * ─── NO-GIT rows (`BATCH-*-GATE`, `LEGACY-ZERO-GATE`, `W0-03`, …) ──────────
 *
 * Many rows have no branch at all. Their `git log` is empty because there is
 * nothing to log — reading that as "no new commits" is exactly the mistake
 * that once produced a bogus 71% waste statistic that was really 33%. So a
 * missing branch is recorded as `absent`, and identity for those rows is
 * carried by card + capsule + outputs. Concretely: for a NO-GIT row the ONLY
 * thing the worker can change in response to feedback is its report, so the
 * report bytes ARE the state. If the report changed, the row is treated as
 * changed and the cycle proceeds — deliberately conservative, because for a
 * gate row the report IS the deliverable and a false PM route on a working
 * row costs more than one extra cycle.
 *
 * ─── Why the report is normalised before hashing ───────────────────────────
 *
 * The orchestrator writes into the worker's own report: every applied verdict
 * appends a `## Validator Report - <ID> - Cycle N` section (see
 * `appendWorkerReportHistory`), PM results append `## PM Resolver Report`, and
 * auto-clarify appends `## PM Clarification`. Hashing the raw file would
 * therefore make the report differ after EVERY cycle purely because we wrote
 * to it ourselves, and the guard could never fire. So orchestrator-authored
 * sections are stripped and only the worker-authored remainder is digested.
 *
 * ─── The determinacy rule ──────────────────────────────────────────────────
 *
 * A fingerprint may only be compared when it is `determinate`: at least one
 * component was actually observed (`present`) AND no component is
 * `unresolved`. A row where we observed nothing at all — no branch, no card,
 * no capsule, no readable report — yields two byte-equal fingerprints that
 * mean "we know nothing", twice. Comparing those would route healthy rows to
 * PM on the strength of our own blindness, so we refuse.
 */

const SHA40_PATTERN = /^[0-9a-f]{40}$/i;

// Fixed component order. The canonical string that gets hashed depends on it,
// so changing this order changes every fingerprint; a mismatch against a
// stored fingerprint is fail-open (guard does not fire), never fail-closed.
const COMPONENT_KEYS = ["branch", "card", "capsule", "outputs"] as const;
export type ValidationStateIdentityComponentKey = (typeof COMPONENT_KEYS)[number];

export interface ComputeValidationStateIdentityInput {
  workerId: string;
  /** Absolute path to `dispatch_plan.md`; task card and capsule are resolved from its directory. */
  dispatchPlanPath: string;
  /** The row's Branch column, already normalized. `null` for NO-GIT rows. */
  branch: string | null;
  /**
   * Working directory for the `git rev-parse` that resolves the branch head.
   * The dispatcher repo root in practice. On a multi-repo round whose row
   * lives in a different repo the lookup simply fails and the branch
   * component lands on `unresolved`, which disables the guard for that row —
   * fail-safe by construction.
   */
  repoDir: string;
  /** The worker's `expected_outputs` (report paths). Absolute or plan-relative. */
  expectedOutputs?: readonly string[];
  /** The validation cycle this fingerprint describes. */
  cycle: number;
}

export interface ValidationStateIdentityIo {
  /**
   * Test seam. Defaults to a synchronous utf8 read — synchronous on purpose,
   * matching `loadValidatorContextCapsule` and `LifecycleStore.load()`, which
   * already do `readFileSync` on this same code path.
   */
  readFile?: (filePath: string) => string;
  /** Test seam. Defaults to a `execFileSync` wrapper; throws when git is unavailable. */
  execFile?: (command: string, args: string[], options: { cwd?: string }) => string;
}

export function computeValidationStateIdentity(
  input: ComputeValidationStateIdentityInput,
  io: ValidationStateIdentityIo = {}
): ValidationStateIdentity {
  const readFile = io.readFile ?? defaultReadFile;
  const execFile = io.execFile ?? defaultExecFile;
  const planDirectory = path.dirname(input.dispatchPlanPath);

  const components: ValidationStateIdentityComponent[] = [
    buildBranchComponent(input.branch, input.repoDir, execFile),
    buildFileComponent("card", path.join(planDirectory, `${input.workerId.trim()}.md`), readFile),
    buildFileComponent(
      "capsule",
      resolveValidatorContextCapsulePath(input.dispatchPlanPath, input.workerId),
      readFile
    ),
    buildOutputsComponent(input.expectedOutputs ?? [], planDirectory, readFile)
  ];

  const ordered = COMPONENT_KEYS.map(
    (key) => components.find((component) => component.key === key)!
  );

  const observed = ordered.some((component) => component.status === "present");
  const unresolved = ordered.some((component) => component.status === "unresolved");

  return {
    fingerprint: sha256(ordered.map(renderComponent).join("\n")),
    cycle: input.cycle,
    observed,
    determinate: observed && !unresolved,
    components: ordered
  };
}

/**
 * The guard predicate. True ONLY when both fingerprints are determinate and
 * byte-equal — i.e. we positively observed the same state twice, rather than
 * failing to observe it twice.
 */
export function isValidationStateIdentityUnchanged(
  previous: ValidationStateIdentity | null | undefined,
  current: ValidationStateIdentity | null | undefined
): boolean {
  if (!previous || !current) {
    return false;
  }

  if (!previous.determinate || !current.determinate) {
    return false;
  }

  return previous.fingerprint === current.fingerprint;
}

/** Flat, log-friendly rendering: `{ branch: "present", card: "absent", … }`. */
export function summarizeValidationStateIdentity(
  identity: ValidationStateIdentity
): Record<string, ValidationStateIdentityComponentStatus> {
  const summary: Record<string, ValidationStateIdentityComponentStatus> = {};
  for (const component of identity.components) {
    summary[component.key] = component.status;
  }
  return summary;
}

// ─── Component builders ─────────────────────────────────────────────────────

function buildBranchComponent(
  branch: string | null,
  repoDir: string,
  execFile: NonNullable<ValidationStateIdentityIo["execFile"]>
): ValidationStateIdentityComponent {
  const trimmed = branch?.trim() ?? "";
  if (trimmed.length === 0) {
    // NO-GIT row. Not "identical" — simply not a source of identity here.
    return { key: "branch", status: "absent", value: "" };
  }

  // Refuse obviously hostile refs even though execFile uses no shell: a
  // leading `-` would be parsed as a git flag. Mirrors commit-scanner.
  if (trimmed.startsWith("-")) {
    return { key: "branch", status: "unresolved", value: trimmed };
  }

  let output: string;
  try {
    output = execFile("git", ["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`], {
      cwd: repoDir
    });
  } catch {
    // Branch declared but not resolvable here (wrong repo on a multi-repo
    // round, ref deleted, git unavailable). Ignorance, not evidence.
    return { key: "branch", status: "unresolved", value: trimmed };
  }

  const sha = output.trim();
  if (!SHA40_PATTERN.test(sha)) {
    return { key: "branch", status: "unresolved", value: trimmed };
  }

  return { key: "branch", status: "present", value: `${trimmed}@${sha.toLowerCase()}` };
}

function buildFileComponent(
  key: ValidationStateIdentityComponentKey,
  filePath: string,
  readFile: NonNullable<ValidationStateIdentityIo["readFile"]>
): ValidationStateIdentityComponent {
  const digest = digestFile(filePath, readFile);
  return { key, status: digest.status, value: digest.value };
}

function buildOutputsComponent(
  expectedOutputs: readonly string[],
  planDirectory: string,
  readFile: NonNullable<ValidationStateIdentityIo["readFile"]>
): ValidationStateIdentityComponent {
  const declared = expectedOutputs
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .sort();

  if (declared.length === 0) {
    return { key: "outputs", status: "absent", value: "" };
  }

  const entries: string[] = [];
  let presentCount = 0;
  let unresolvedCount = 0;

  for (const declaredPath of declared) {
    // path.resolve is a no-op for the absolute paths the lifecycle store
    // actually persists, and does the right thing for plan-relative ones.
    const digest = digestFile(
      path.resolve(planDirectory, declaredPath),
      readFile,
      stripOrchestratorReportSections
    );
    entries.push(`${declaredPath}=${digest.status}:${digest.value}`);
    if (digest.status === "present") {
      presentCount += 1;
    } else if (digest.status === "unresolved") {
      unresolvedCount += 1;
    }
  }

  const status: ValidationStateIdentityComponentStatus = unresolvedCount > 0
    ? "unresolved"
    : presentCount > 0
      ? "present"
      : "absent";

  return { key: "outputs", status, value: sha256(entries.join("\n")) };
}

function digestFile(
  filePath: string,
  readFile: NonNullable<ValidationStateIdentityIo["readFile"]>,
  normalize: (content: string) => string = (content) => content
): { status: ValidationStateIdentityComponentStatus; value: string } {
  let content: string;
  try {
    content = readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // A file that is not there is a fact about the row (no capsule on a
    // pre-capsule round, no report written yet). Anything else — permissions,
    // I/O, a directory where a file was expected — is a failure to observe.
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "absent", value: "" };
    }
    return { status: "unresolved", value: "" };
  }

  return { status: "present", value: sha256(normalize(content)) };
}

/**
 * Headings the ORCHESTRATOR appends to a worker's report. Everything under
 * one of these belongs to us, not to the worker, so it must not count as the
 * worker having changed something.
 *
 * - `## Validator Report - <ID> - Cycle N` — appended by
 *   `recordValidationOutcome` on every applied verdict.
 * - `## PM Resolver Report - <ID>` — appended by `recordPmResolverResult`.
 * - `## PM Clarification — Auto-delegated to <target> …` — appended by
 *   `appendPmClarification`.
 */
const ORCHESTRATOR_REPORT_HEADING_PATTERN =
  /^##\s+(?:Validator Report|PM Resolver Report|PM Clarification)\b/;

export function stripOrchestratorReportSections(content: string): string {
  const kept: string[] = [];
  let skipping = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (/^##\s/.test(line)) {
      // A new `##` heading always ends the previous section, and starts a
      // skipped one only when it is ours.
      skipping = ORCHESTRATOR_REPORT_HEADING_PATTERN.test(line);
    } else if (/^#\s/.test(line)) {
      // An h1 outranks our appended h2 sections and returns to worker content.
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  // The appender emits `\n\n---\n\n` before its heading; drop that trailing
  // separator noise so a report with N appended sections normalises to the
  // same bytes as the same report with none.
  while (kept.length > 0 && /^(?:\s*|-{3,}\s*)$/.test(kept[kept.length - 1]!)) {
    kept.pop();
  }

  return kept.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderComponent(component: ValidationStateIdentityComponent): string {
  return `${component.key}=${component.status}:${component.value}`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function defaultExecFile(command: string, args: string[], options: { cwd?: string } = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}
