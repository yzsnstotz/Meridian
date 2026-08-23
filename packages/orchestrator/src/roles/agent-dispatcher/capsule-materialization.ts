import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";

import type { DispatchThreadStateV2 } from "../../types";
// The canonical plan-table parser — the only one in the tree that reads the
// `Branch` column, which is where the ref a SHA is read from comes from.
// (role-handlers.ts has a second, private parser that drops `branch`.)
import { parseDispatchPlanRows } from "../../tool-gateway/tools/dispatch-status";
import { resolveValidatorContextCapsulePath } from "./validator-prompt-builder";

/**
 * ─── The dispatch materialization precondition ──────────────────────────────
 *
 * Every row carries a Context Capsule at `context/<WORKER_ID>-context.md`.
 * Sections that cannot be written at generation time — because they need a
 * dependency's REAL git SHA, or an approved decision entry that does not exist
 * yet — carry the literal placeholder `⏳ **待物化**`.
 *
 * Two rules govern filling those sections, each individually correct:
 *
 *   WHO   the round templates say the previous Gate row fills them before the
 *         next wave dispatches;
 *   WHEN  PM rulings §1.48 / §4.11 forbid inventing a SHA for a dependency
 *         that has not finished.
 *
 * They coincide only for a CROSS-WAVE dependency. For an INTRA-WAVE dependency
 * they are permanently misaligned, and the misalignment is not recoverable by
 * the plan author: measured on clawso round
 * unification-layer-decoupling-2026-08-06, rows I-02..I-06 (wave 9) depend on
 * I-01 (also wave 9). When BATCH-8-GATE finished, I-01 had not run, so the Gate
 * CORRECTLY refused to fill (§1.48). After I-01 finished, no Gate ever runs
 * again before those rows. All five launched against capsules still carrying
 * `⏳ **待物化**`, all five immediately self-reported `blocked`, each consumed a
 * PM resolver, and an operator filled them by hand.
 *
 * "The previous Gate fills them" was never a rule — it is a WORKAROUND the plan
 * author invented because the orchestrator exposed no pre-dispatch hook. The
 * plan author can only observe proxy events (a wave boundary). The orchestrator
 * is the only component that observes the real condition (a dependency reaching
 * a terminal state) and the real action point (immediately before launching a
 * row). The generation layer already declares WHAT must be filled — that is
 * exactly what the `⏳` markers are. Choosing WHEN is lifecycle knowledge and
 * belongs here.
 *
 * So this module is a PRECONDITION, not another actor:
 *
 *   1. REFUSE to launch a row whose capsule still carries a placeholder. This
 *      is the safety half. Launching a worker against a `⏳` capsule is
 *      guaranteed waste — the row self-reports `blocked` within one turn.
 *   2. TRIGGER the fill when — and only when — every dependency the placeholder
 *      names has reached lifecycle `completed`. §1.48/§4.11 then fall out as a
 *      CONSEQUENCE of the trigger condition rather than as a separate rule
 *      someone has to remember: there is no code path in this module that reads
 *      or writes a SHA for a dependency that is not `completed`, so there is
 *      nothing left to forbid.
 *   3. NEVER invent. The SHA is read from the real ref with `git rev-parse`.
 *      Anything not derivable from state the orchestrator owns — which approved
 *      decision entries apply to this row, a dependency with no branch, a ref
 *      that does not resolve — is not guessed: the row stays parked and the
 *      hold names the exact file, section and reason so PM/the operator can act.
 *
 * There is deliberately NO compatibility path, retry loop, or fallback that
 * lets an unmaterialized row run anyway. Routing around the fault is the defect
 * being repaired.
 *
 * ─── The spec-file half of the same precondition ────────────────────────────
 *
 * The refusal above only fires on a capsule that EXISTS and still carries `⏳`.
 * Its "launch is permitted" escape covered three shapes, one of which — no
 * capsule file at all — silently conflated two states that have opposite
 * correct answers:
 *
 *   A. this round does not use capsules  → launching is right;
 *   B. the capsule has not been WRITTEN yet → launching is guaranteed waste.
 *
 * Measured on the same clawso round, 2026-08-11: rows I-08 and I-09 were added
 * to `plan.json` / `dispatch_plan.md` while their cards and capsules were still
 * being authored. The watchdog selected I-09 and launched worker thread
 * `codex_1543` against a non-existent card AND a non-existent capsule; the
 * thread was killed and the row parked by hand. I-08 had the same shape one
 * step earlier and burned a blocked report against a superseded draft card.
 * `/taskspec` §6.7.16 names this defect class directly: a default that papers
 * over two indistinguishable states.
 *
 * They are not, in fact, indistinguishable — the round already publishes the
 * signal. `plan.json`, the canonical task graph and a sibling of
 * `dispatch_plan.md`, carries per-task `card` and `capsule` keys holding
 * repo-relative paths. So:
 *
 *   key absent / empty      → positive determination of (A). Launch.
 *   path declared, file on   → nothing to refuse. Launch.
 *   disk and non-empty
 *   path declared, no file   → state (B). PARK, `spec_not_written`.
 *   or file empty
 *
 * and, because "I cannot tell" must never resolve to the friendly branch:
 *
 *   plan.json absent          → this round publishes no task graph, so it
 *                               declares nothing. Launch — see
 *                               {@link loadSpecManifest} for why absence is a
 *                               positive determination and not a failed read.
 *   plan.json present but     → PARK, `spec_manifest_unreadable`. The round DOES
 *   unreadable / malformed      publish a task graph and we cannot read what it
 *                               declares; failing closed is the only honest
 *                               answer.
 *
 * Same anti-requirements as the capsule half, and for the same reason: no retry
 * loop, no grace period, no "launch anyway and let the worker discover it". A
 * spec that is not on disk cannot become on-disk by being asked again — only an
 * author writing it changes that state, so the row parks and the hold names the
 * exact path that is missing.
 */

/**
 * The literal placeholder the capsule generator writes. Tolerant of the bold
 * markers because the generator emits `⏳ **待物化**` while hand edits and the
 * capsule materializer script have both been observed writing it unbolded.
 */
export const CAPSULE_MATERIALIZATION_MARKER_REGEX = /⏳\s*\*{0,2}\s*待物化\s*\*{0,2}/;

/**
 * The dependency clause inside a placeholder line: `依赖行：I-01, V-02。`.
 *
 * This clause is the ONLY thing that tells the orchestrator what to substitute,
 * which is why its presence — not the section heading — is what makes a
 * placeholder derivable. The live `## Required Decisions` placeholder carries no
 * such clause ("extract the applicable entries from the decision registry"), and
 * that is precisely the judgement the orchestrator must not make.
 */
const CAPSULE_DEPENDENCY_CLAUSE_REGEX = /依赖行\s*[：:]\s*([^。.\n]+)/;

/** Guards `git rev-parse` against a ref that would be parsed as a flag. */
const SAFE_GIT_REF_REGEX = /^[^\s-][^\s]*$/;

const RESOLVED_SHA_REGEX = /^[0-9a-f]{40}$/i;

export interface CapsulePlaceholder {
  /** Nearest preceding `## ` heading, or null when the marker precedes any. */
  section: string | null;
  /** 1-based line number inside the capsule. */
  line: number;
  /** The full placeholder line, verbatim. */
  text: string;
  /**
   * Worker ids named by the line's `依赖行` clause. Empty means the placeholder
   * declares no substitutable dependency, i.e. the orchestrator has nothing it
   * could derive.
   */
  declaredDependencies: string[];
}

export type CapsuleMaterializationHoldReason =
  /** At least one named dependency has not reached lifecycle `completed`. */
  | "awaiting_dependencies"
  /**
   * Every named dependency is `completed` and every remaining placeholder names
   * one, so the fill is due — the next continue tick performs it. Reported by
   * the READ-ONLY gate (watchdog, scheduler), which deliberately does not write
   * and therefore cannot know whether the refs resolve. Distinct from
   * `awaiting_pm` so a read-only observer never raises a false "a human owes us
   * something" signal for a row the dispatcher is about to fill by itself.
   */
  | "awaiting_fill"
  /**
   * The remainder is NOT derivable from state the orchestrator owns — a
   * placeholder that names no dependency (the `## Required Decisions` shape), a
   * dependency with no ref, or a ref that does not resolve. Routes to PM. Never
   * guessed, and never downgraded into a launch.
   */
  | "awaiting_pm"
  /**
   * `plan.json` declares a `card` and/or `capsule` path for this row and the
   * file is not on disk, or is on disk but empty. The row was registered in the
   * plan while its spec was still being authored. Deliberately distinct from
   * every `awaiting_*` reason: those describe a capsule that EXISTS and is
   * incomplete, and an operator reading `awaiting_pm` would go looking for a
   * `⏳` section in a file that is not there. Clears only when an author writes
   * the file — never by retry, and never by waiting.
   */
  | "spec_not_written"
  /**
   * `plan.json` exists but could not be read or parsed as a task graph, so the
   * dispatcher cannot tell whether this row's spec files were declared, let
   * alone written. Fails closed. Distinct from `spec_not_written` because the
   * operator action is different: fix (or remove) the manifest, not write a
   * card.
   */
  | "spec_manifest_unreadable";

export type SpecFileKind = "card" | "capsule";

/** One declared-but-unwritten spec file. */
export interface MissingSpecFile {
  kind: SpecFileKind;
  /** The path exactly as `plan.json` declares it (repo/taskspec-relative). */
  declaredPath: string;
  /** `declaredPath` resolved against the taskspec directory. */
  resolvedPath: string;
  /**
   * `absent` — no file at the declared path. `empty` — a file exists but holds
   * nothing but whitespace. See {@link inspectSpecFiles} for why the viability
   * test stops there.
   */
  state: "absent" | "empty";
}

export interface CapsuleMaterializationHold {
  workerId: string;
  capsulePath: string;
  reason: CapsuleMaterializationHoldReason;
  /** Every placeholder still present in the capsule. */
  placeholders: CapsulePlaceholder[];
  /** Named dependencies not yet at lifecycle `completed`, deduped, in order. */
  pendingDependencies: string[];
  /**
   * Human-readable reasons a placeholder could not be derived, one per
   * unsatisfiable placeholder. Empty when `reason` is `awaiting_dependencies`.
   */
  underivableReasons: string[];
  /**
   * Spec files `plan.json` declares for this row that are not written. Non-empty
   * only when `reason` is `spec_not_written`.
   */
  missingSpecFiles: MissingSpecFile[];
  /** The `plan.json` consulted, when one was. Null when the round has none. */
  specManifestPath: string | null;
  /**
   * Why `plan.json` could not be read. Non-null only when `reason` is
   * `spec_manifest_unreadable`.
   */
  specManifestError: string | null;
}

export interface CapsuleMaterializationRow {
  worker: string;
  branch?: string | null;
}

export interface CapsuleMaterializationIo {
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => void;
  /** Resolves a ref to a full 40-char SHA, or throws / returns "" when it cannot. */
  revParse?: (ref: string, repoRoot: string | undefined) => string;
  log?: Pick<typeof console, "warn" | "info">;
  /**
   * A `plan.json` already loaded earlier in the SAME tick, so the manifest is
   * read once per tick rather than once per row. Purely a read cache — omitting
   * it is always correct and simply re-reads.
   *
   * Never module-level state: the manifest is exactly the file an operator edits
   * to unpark a row (by writing the missing card), so a cache that outlives a
   * tick would keep the round parked after the fix landed. The scope of this
   * field is the scope of one gate / one sweep / one launch decision.
   */
  specManifest?: SpecManifest;
}

export interface InspectCapsuleMaterializationArgs extends CapsuleMaterializationIo {
  dispatchPlanPath: string;
  workerId: string;
  lifecycleState: DispatchThreadStateV2;
}

// ─── The spec manifest (plan.json) ──────────────────────────────────────────

/** The canonical task graph, a fixed sibling of `dispatch_plan.md`. */
const SPEC_MANIFEST_FILENAME = "plan.json";

export type SpecManifestStatus =
  /** Read and parsed. `tasks` is authoritative. */
  | "declared"
  /** No `plan.json` beside the dispatch plan: this round publishes no task graph. */
  | "absent"
  /** A `plan.json` is there and could not be read or parsed. */
  | "unreadable";

export interface SpecManifestTask {
  /** `plan.json`'s declared card path, or null when the key is absent/empty. */
  card: string | null;
  /** `plan.json`'s declared capsule path, or null when the key is absent/empty. */
  capsule: string | null;
}

export interface SpecManifest {
  status: SpecManifestStatus;
  /** Where the manifest was looked for. */
  path: string;
  /** Populated only for `unreadable`. */
  error: string | null;
  /** Declarations by task id. Empty unless `status` is `declared`. */
  tasks: Map<string, SpecManifestTask>;
}

/**
 * Read `plan.json` beside the dispatch plan.
 *
 * The three outcomes are deliberately three, not two:
 *
 * `absent` is a POSITIVE determination, not a swallowed error. 136 of the 137
 * rounds on disk carry no `plan.json` at all — every round generated before the
 * canonical task graph existed. A round with no manifest declares no spec paths,
 * so there is no declaration this precondition could find unfulfilled; parking
 * would halt every legacy round to protect against a promise none of them made.
 * Note also that ENOENT is a definite answer about the filesystem ("there is no
 * such file"), which is the opposite of the ambiguous read below.
 *
 * `unreadable` covers everything else: a permissions error, a directory in the
 * way, an I/O failure, a truncated write, a zero-byte file, invalid JSON, or a
 * well-formed JSON document that is not a task graph. In every one of those the
 * round HAS a manifest — the file is there — and we cannot read what it
 * declares. That is "I cannot tell", and this precondition exists precisely
 * because "I cannot tell" was being resolved as "go ahead". It fails closed.
 */
export function loadSpecManifest(
  dispatchPlanPath: string,
  io: CapsuleMaterializationIo = {}
): SpecManifest {
  const manifestPath = path.join(path.dirname(dispatchPlanPath), SPEC_MANIFEST_FILENAME);
  const readFile = io.readFile ?? defaultReadFile;

  let raw: string;
  try {
    raw = readFile(manifestPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "absent", path: manifestPath, error: null, tasks: new Map() };
    }
    const message = error instanceof Error ? error.message : String(error);
    io.log?.warn?.("plan.json present but unreadable; dispatch fails closed", {
      spec_manifest_path: manifestPath,
      error: message
    });
    return { status: "unreadable", path: manifestPath, error: message, tasks: new Map() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.log?.warn?.("plan.json is not valid JSON; dispatch fails closed", {
      spec_manifest_path: manifestPath,
      error: message
    });
    return { status: "unreadable", path: manifestPath, error: message, tasks: new Map() };
  }

  const tasksValue = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(tasksValue)) {
    const message = "plan.json does not carry a `tasks` array";
    io.log?.warn?.("plan.json is not a task graph; dispatch fails closed", {
      spec_manifest_path: manifestPath,
      error: message
    });
    return { status: "unreadable", path: manifestPath, error: message, tasks: new Map() };
  }

  const tasks = new Map<string, SpecManifestTask>();
  for (const entry of tasksValue) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    // `task_id` is what the live generator emits; the aliases cost nothing and
    // keep a hand-written or older manifest from silently declaring nothing.
    const taskId = firstNonEmptyString(record.task_id, record.id, record.worker_id);
    if (!taskId || tasks.has(taskId)) {
      continue;
    }
    tasks.set(taskId, {
      card: firstNonEmptyString(record.card),
      capsule: firstNonEmptyString(record.capsule)
    });
  }

  return { status: "declared", path: manifestPath, error: null, tasks };
}

/** The manifest entry for a row, tolerant of the plan's id casing/decoration. */
function resolveSpecManifestTask(
  manifest: SpecManifest,
  workerId: string
): SpecManifestTask | null {
  const direct = manifest.tasks.get(workerId);
  if (direct) {
    return direct;
  }
  const normalized = normalizeWorkerId(workerId);
  for (const [candidate, task] of manifest.tasks) {
    if (normalizeWorkerId(candidate) === normalized) {
      return task;
    }
  }
  return null;
}

/**
 * Declared spec files for this row that are not written.
 *
 * The viability test is: the file opens, and it holds at least one
 * non-whitespace character. Nothing beyond that, on purpose. This gate answers
 * "does the spec exist", not "is the spec good" — the moment it asserts a
 * minimum length, a required heading, or a section list, it becomes a content
 * validator that a legitimately terse card fails and that has to be revised
 * every time the card template moves. Any non-zero threshold is also arbitrary
 * in a way zero is not: there is no principled answer to "why 200 bytes and not
 * 20", whereas "an author has typed nothing into this file" is a fact.
 *
 * The boundary is stated rather than hidden: a card that exists but is a
 * SUPERSEDED DRAFT passes this test, so the I-08 half of the incident is out of
 * scope here by construction. Catching that needs content judgement, which is
 * the thing this gate must not acquire.
 *
 * Emptiness is tested by reading rather than by `stat`, so a whitespace-only
 * file counts as unwritten and so this shares the one filesystem seam the rest
 * of the module already uses. The files are small (median ~9KB card, ~2.4KB
 * capsule on the live round) and local, and the capsule on this path is read
 * exactly once and handed back to the caller for placeholder parsing.
 */
export function inspectSpecFiles(
  dispatchPlanPath: string,
  workerId: string,
  manifest: SpecManifest,
  io: CapsuleMaterializationIo = {}
): { missing: MissingSpecFile[]; declaredCapsulePath: string | null } {
  const task = resolveSpecManifestTask(manifest, workerId);
  if (!task) {
    // The row is not in the task graph. No declaration, so nothing to enforce —
    // the same positive determination as an absent key, one level up.
    return { missing: [], declaredCapsulePath: null };
  }

  const taskspecDir = path.dirname(dispatchPlanPath);
  const missing: MissingSpecFile[] = [];
  let declaredCapsulePath: string | null = null;

  for (const kind of ["card", "capsule"] as const) {
    const declaredPath = task[kind];
    if (!declaredPath) {
      // Key absent or empty: a positive "this round/row has no such spec file".
      continue;
    }
    const resolvedPath = path.resolve(taskspecDir, declaredPath);
    if (kind === "capsule") {
      declaredCapsulePath = resolvedPath;
    }
    const state = readSpecFileState(resolvedPath, io);
    if (state !== "written") {
      missing.push({ kind, declaredPath, resolvedPath, state });
    }
  }

  return { missing, declaredCapsulePath };
}

function readSpecFileState(
  filePath: string,
  io: CapsuleMaterializationIo
): "written" | "absent" | "empty" {
  const readFile = io.readFile ?? defaultReadFile;
  let raw: string;
  try {
    raw = readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return "absent";
    }
    // An EACCES/EISDIR/EIO on a path the manifest DECLARES is the same "I
    // cannot tell" as an unreadable manifest, and gets the same closed answer:
    // report it as absent rather than inferring the file is fine.
    io.log?.warn?.("Declared spec file unreadable; treated as not written", {
      spec_path: filePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return "absent";
  }
  return raw.trim().length === 0 ? "empty" : "written";
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

export function parseCapsuleMaterializationPlaceholders(content: string): CapsulePlaceholder[] {
  const placeholders: CapsulePlaceholder[] = [];
  let section: string | null = null;

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }

    if (!CAPSULE_MATERIALIZATION_MARKER_REGEX.test(line)) {
      continue;
    }

    placeholders.push({
      section,
      line: index + 1,
      text: line,
      declaredDependencies: parseDeclaredDependencies(line)
    });
  }

  return placeholders;
}

function parseDeclaredDependencies(line: string): string[] {
  const clause = CAPSULE_DEPENDENCY_CLAUSE_REGEX.exec(line)?.[1];
  if (!clause) {
    return [];
  }

  const seen = new Set<string>();
  const workerIds: string[] = [];
  for (const raw of clause.split(/[,，、]|\s+\+\s+/)) {
    const workerId = raw.replace(/[`*_]/g, "").trim();
    if (!workerId || seen.has(workerId)) {
      continue;
    }
    seen.add(workerId);
    workerIds.push(workerId);
  }
  return workerIds;
}

// ─── Read-only inspection (the refusal half) ────────────────────────────────

/**
 * Read the row's spec files and capsule and decide whether it may launch.
 *
 * This is the ONE read-only evaluator. The gate, the watchdog heartbeat, the
 * scheduler's row picker, the parallel candidate filter and the per-launch
 * funnel all reach the refusal through here, so a new check added here holds on
 * every path without any of them wiring it separately.
 *
 * Refuses, in precedence order:
 *
 *   1. `spec_manifest_unreadable` — `plan.json` is there and cannot be read.
 *      First because it is the only state in which every other answer below
 *      would be a guess.
 *   2. `spec_not_written` — a declared card/capsule is absent or empty. Before
 *      the capsule checks because a capsule that was never written has no
 *      placeholders to reason about, and "no placeholders" would otherwise read
 *      as "nothing to refuse".
 *   3..5. the capsule placeholder reasons, unchanged.
 *
 * Returns `null` — launch permitted — for every shape that is NOT one of those:
 * a round with no `plan.json` (the 136-of-137 legacy case), a row absent from
 * the task graph, a row whose `card`/`capsule` keys are absent or empty, an
 * undeclared capsule that happens not to exist, an unreadable capsule, or a
 * capsule with no placeholder left. Note the asymmetry that carries the whole
 * fix: an UNDECLARED missing capsule still launches (pre-capsule rounds keep
 * working), a DECLARED missing capsule parks.
 *
 * Synchronous for the same reason `loadValidatorContextCapsule` is: it runs on
 * the continue tick alongside `LifecycleStore.load()`'s own `readFileSync` of
 * the capsule's sibling `dispatch_threads.json`, and the launch path's timing is
 * observed by callers.
 */
export function inspectCapsuleMaterialization(
  args: InspectCapsuleMaterializationArgs
): CapsuleMaterializationHold | null {
  const workerId = args.workerId?.trim();
  if (!workerId) {
    return null;
  }

  const manifest = args.specManifest ?? loadSpecManifest(args.dispatchPlanPath, args);
  const conventionCapsulePath = resolveValidatorContextCapsulePath(args.dispatchPlanPath, workerId);

  if (manifest.status === "unreadable") {
    return {
      workerId,
      capsulePath: conventionCapsulePath,
      reason: "spec_manifest_unreadable",
      placeholders: [],
      pendingDependencies: [],
      underivableReasons: [],
      missingSpecFiles: [],
      specManifestPath: manifest.path,
      specManifestError: manifest.error
    };
  }

  const { missing, declaredCapsulePath } = inspectSpecFiles(
    args.dispatchPlanPath,
    workerId,
    manifest,
    args
  );

  // The capsule the ROUND declares outranks the one the convention predicts.
  // When they agree — they do for all 77 rows of the live round — this is a
  // no-op; when they disagree, scanning the convention path would be scanning a
  // file the round does not consider this row's capsule at all.
  const capsulePath = declaredCapsulePath ?? conventionCapsulePath;

  if (missing.length > 0) {
    return {
      workerId,
      capsulePath,
      reason: "spec_not_written",
      placeholders: [],
      pendingDependencies: [],
      underivableReasons: [],
      missingSpecFiles: missing,
      specManifestPath: manifest.path,
      specManifestError: null
    };
  }

  const content = readCapsule(capsulePath, workerId, args);
  if (content === null) {
    return null;
  }

  const placeholders = parseCapsuleMaterializationPlaceholders(content);
  if (placeholders.length === 0) {
    return null;
  }

  const pendingDependencies: string[] = [];
  const underivableReasons: string[] = [];
  const seenPending = new Set<string>();

  for (const placeholder of placeholders) {
    if (placeholder.declaredDependencies.length === 0) {
      // No `依赖行` clause: the placeholder does not say what to substitute, so
      // there is nothing the orchestrator could derive. This is the
      // `## Required Decisions` shape — "extract the entries that apply to this
      // row" is a judgement, and judgement is PM's.
      underivableReasons.push(
        `${describeSection(placeholder)} declares no substitutable dependency `
        + "(no `依赖行` clause) — its content is not derivable from dispatcher state"
      );
      continue;
    }

    for (const dependencyId of placeholder.declaredDependencies) {
      const dependency = resolveLifecycleWorker(args.lifecycleState, dependencyId);
      if (dependency?.status === "completed") {
        continue;
      }
      if (seenPending.has(dependencyId)) {
        continue;
      }
      seenPending.add(dependencyId);
      pendingDependencies.push(dependencyId);
    }
  }

  // Dependencies outrank PM: while any named dependency is unfinished the only
  // honest answer is "not yet", and reporting `awaiting_pm` would ask a human to
  // supply data that does not exist yet.
  if (pendingDependencies.length > 0) {
    return {
      workerId,
      capsulePath,
      reason: "awaiting_dependencies",
      placeholders,
      pendingDependencies,
      underivableReasons: [],
      missingSpecFiles: [],
      specManifestPath: manifest.status === "absent" ? null : manifest.path,
      specManifestError: null
    };
  }

  return {
    workerId,
    capsulePath,
    // Precedence: unfinished dependencies (handled above) outrank an
    // underivable section, which outranks a due-but-unperformed fill. Anything
    // PM must write keeps the row on PM's desk even if a sibling placeholder is
    // about to be filled automatically.
    reason: underivableReasons.length > 0 ? "awaiting_pm" : "awaiting_fill",
    placeholders,
    pendingDependencies: [],
    underivableReasons,
    missingSpecFiles: [],
    specManifestPath: manifest.status === "absent" ? null : manifest.path,
    specManifestError: null
  };
}

/** Boolean form of {@link inspectCapsuleMaterialization}. */
export function isCapsuleMaterializationHeld(args: InspectCapsuleMaterializationArgs): boolean {
  return inspectCapsuleMaterialization(args) !== null;
}

/**
 * A memoized read-only gate, shaped so the pure row resolvers in
 * service-continuation.ts can consult it without importing this module (which
 * would be a cycle) and without re-reading the same capsule once per candidate
 * per tick.
 *
 * `plan.json` is read ONCE per gate — i.e. once per tick — and shared with every
 * row the gate is asked about, rather than once per row. Scoped to the gate and
 * not to the module: an operator who writes the missing card must see the row
 * unpark on the next tick, which a longer-lived cache would prevent.
 */
export type CapsuleMaterializationGate = (workerId: string) => CapsuleMaterializationHold | null;

export interface CreateCapsuleMaterializationGateOptions extends CapsuleMaterializationIo {
  /**
   * Holds carried over from a {@link materializeReadyCapsules} sweep performed
   * earlier in the same tick. Without them the gate can only report
   * `awaiting_fill` — it never attempts a derivation — so a row whose fill was
   * ATTEMPTED and failed would tell the operator "the next tick will handle it"
   * forever. Seeding hands the sweep's verdict (`awaiting_pm`, with the concrete
   * reasons) to every consumer of the gate.
   */
  seed?: readonly CapsuleMaterializationHold[];
}

export function createCapsuleMaterializationGate(
  dispatchPlanPath: string,
  lifecycleState: DispatchThreadStateV2,
  io: CreateCapsuleMaterializationGateOptions = {}
): CapsuleMaterializationGate {
  const cache = new Map<string, CapsuleMaterializationHold | null>();
  for (const hold of io.seed ?? []) {
    cache.set(hold.workerId, hold);
  }
  const specManifest = io.specManifest ?? loadSpecManifest(dispatchPlanPath, io);
  return (workerId: string) => {
    const key = workerId?.trim() ?? "";
    if (cache.has(key)) {
      return cache.get(key) ?? null;
    }
    const hold = inspectCapsuleMaterialization({
      dispatchPlanPath,
      workerId: key,
      lifecycleState,
      readFile: io.readFile,
      log: io.log,
      specManifest
    });
    cache.set(key, hold);
    return hold;
  };
}

/**
 * Every plan row currently parked behind an unmaterialized capsule, in plan
 * order. Scoped to the plan's own rows so a stray capsule file for a row that no
 * longer exists cannot park anything, and so operator-facing messages name rows
 * they can actually see. Mirrors `resolveHumanEscalationParkedWorkers`.
 */
export function resolveCapsuleMaterializationParkedWorkers(
  rows: readonly CapsuleMaterializationRow[],
  gate: CapsuleMaterializationGate
): CapsuleMaterializationHold[] {
  const parked: CapsuleMaterializationHold[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const workerId = row.worker?.trim();
    if (!workerId || seen.has(workerId)) {
      continue;
    }
    seen.add(workerId);
    const hold = gate(workerId);
    if (hold) {
      parked.push(hold);
    }
  }
  return parked;
}

/** Operator-facing one-liner describing why a row is parked. */
export function describeCapsuleMaterializationHold(hold: CapsuleMaterializationHold): string {
  // The two spec-file reasons answer BEFORE the capsule prefix is built: that
  // prefix asserts the capsule "still carries ⏳ 待物化", which for a capsule
  // that was never written would send the operator to read a file that is not
  // there. Naming the wrong fault is how a park becomes an investigation.
  if (hold.reason === "spec_manifest_unreadable") {
    return `spec manifest unreadable: ${hold.specManifestPath} exists but could not be read as a task `
      + `graph (${hold.specManifestError ?? "unknown error"}), so the dispatcher cannot tell whether `
      + `${hold.workerId}'s card and capsule have been written; every launch fails closed until the `
      + "manifest is valid JSON with a `tasks` array (or is removed, for a round that has no task graph)";
  }

  if (hold.reason === "spec_not_written") {
    const files = hold.missingSpecFiles
      .map((file) => `${file.kind} \`${file.declaredPath}\` is ${file.state} (${file.resolvedPath})`)
      .join("; ");
    return `spec not written: ${hold.specManifestPath} declares spec files for ${hold.workerId} that do `
      + `not exist on disk — ${files}; the row was registered in the plan before its spec was authored. `
      + "It stays parked until the file(s) are written — no retry, wait, or relaunch can change this";
  }

  const prefix = `awaiting materialization: ${hold.workerId}'s context capsule still carries ⏳ 待物化 in `
    + `${hold.placeholders.map(describeSection).join(", ")} (${hold.capsulePath})`;

  if (hold.reason === "awaiting_dependencies") {
    return `${prefix}; it will be filled automatically once `
      + `${hold.pendingDependencies.join(", ")} reach completed — no operator action`;
  }

  if (hold.reason === "awaiting_fill") {
    return `${prefix}; every named dependency is completed, so the next continue tick fills it — `
      + "no operator action";
  }

  return `${prefix} and the remainder is NOT derivable by the dispatcher — `
    + `${hold.underivableReasons.join("; ")}; PM must write those sections into the capsule, `
    + "then the row launches";
}

// ─── The trigger (the automation half) ──────────────────────────────────────

export interface MaterializeCapsulesArgs extends CapsuleMaterializationIo {
  dispatchPlanPath: string;
  rows: readonly CapsuleMaterializationRow[];
  lifecycleState: DispatchThreadStateV2;
  /** cwd for `git rev-parse`. Undefined uses the process cwd. */
  repoRoot?: string;
  /**
   * Restrict the sweep to these worker ids. The BRANCH MAP is still built from
   * every row — a scoped sweep still needs its dependencies' refs. Used by the
   * per-launch funnel; the per-tick sweep omits it.
   */
  only?: readonly string[];
}

export interface MaterializedCapsuleSubstitution {
  workerId: string;
  dependencyId: string;
  ref: string;
  sha: string;
}

export interface MaterializeCapsulesResult {
  /** Rows whose capsule was rewritten this sweep. */
  materializedWorkers: string[];
  substitutions: MaterializedCapsuleSubstitution[];
  /** Rows that still hold after the sweep, with the reason. */
  stillHeld: CapsuleMaterializationHold[];
}

/**
 * Fill every placeholder whose named dependencies have ALL reached lifecycle
 * `completed`, reading each SHA from the real ref.
 *
 * This is the trigger. It is the whole of §1.48/§4.11 in executable form: the
 * `completed` test is the loop's entry condition, so no SHA is read — let alone
 * written — for a dependency that has not finished. Delete the rule from the
 * playbook and nothing changes; there is no other path to a SHA here.
 *
 * The orchestrator performs this fill ITSELF rather than dispatching a
 * materialization worker. A dedicated step would be another actor that has to be
 * scheduled, can fail, and can be forgotten before the next row — which is
 * exactly the failure being repaired. The fill is also a pure function of state
 * the orchestrator already owns (the plan's `Branch` column plus `git
 * rev-parse`), so there is no judgement in it to delegate.
 *
 * What it will NOT do: guess. A placeholder with no `依赖行` clause, a
 * dependency with no branch, and a ref that does not resolve are all left
 * untouched, and the row stays parked with a hold naming the exact gap. That is
 * the PM route.
 */
export function materializeReadyCapsules(args: MaterializeCapsulesArgs): MaterializeCapsulesResult {
  const readFile = args.readFile ?? defaultReadFile;
  const writeFile = args.writeFile ?? defaultWriteFile;
  const revParse = args.revParse ?? defaultRevParse;

  const branchByWorkerId = new Map<string, string>();
  for (const row of args.rows) {
    const workerId = row.worker?.trim();
    const branch = row.branch?.trim();
    if (workerId && branch && !branchByWorkerId.has(workerId)) {
      branchByWorkerId.set(workerId, branch);
    }
  }

  const scope = args.only
    ? new Set(args.only.map((workerId) => normalizeWorkerId(workerId)))
    : null;

  // Read once for the whole sweep and threaded into every per-row inspect below,
  // so a 77-row tick reads plan.json once rather than 77 times.
  const specManifest = args.specManifest ?? loadSpecManifest(args.dispatchPlanPath, args);

  const materializedWorkers: string[] = [];
  const substitutions: MaterializedCapsuleSubstitution[] = [];
  const stillHeld: CapsuleMaterializationHold[] = [];
  const seen = new Set<string>();

  for (const row of args.rows) {
    const workerId = row.worker?.trim();
    if (!workerId || seen.has(workerId)) {
      continue;
    }
    seen.add(workerId);
    if (scope && !scope.has(normalizeWorkerId(workerId))) {
      continue;
    }

    // The spec-file half is checked BEFORE any write is contemplated. A row
    // whose manifest is unreadable or whose declared capsule is not on disk is
    // recorded as held and skipped: there is nothing to fill, and writing into a
    // capsule path we could not verify is exactly the invention this module
    // refuses to make.
    const specHold = inspectSpecFiles(args.dispatchPlanPath, workerId, specManifest, args);
    if (specManifest.status === "unreadable" || specHold.missing.length > 0) {
      const hold = inspectCapsuleMaterialization({
        dispatchPlanPath: args.dispatchPlanPath,
        workerId,
        lifecycleState: args.lifecycleState,
        readFile,
        log: args.log,
        specManifest
      });
      if (hold) {
        stillHeld.push(hold);
      }
      continue;
    }

    const capsulePath = specHold.declaredCapsulePath
      ?? resolveValidatorContextCapsulePath(args.dispatchPlanPath, workerId);
    const content = readCapsule(capsulePath, workerId, args);
    if (content === null) {
      continue;
    }

    const placeholders = parseCapsuleMaterializationPlaceholders(content);
    if (placeholders.length === 0) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    let changed = false;
    // Recorded so the hold this sweep returns can say PM rather than "the next
    // tick will fill it". The read-only gate cannot make that distinction — it
    // never attempts the derivation — but this function did attempt it and
    // knows it failed, and repeating the attempt every tick forever without
    // telling anyone is precisely the silent-waste shape being repaired.
    const derivationFailures: string[] = [];

    for (const placeholder of placeholders) {
      // ── The trigger condition. Everything §1.48/§4.11 forbids is
      //    unreachable from below this line, by construction.
      if (placeholder.declaredDependencies.length === 0) {
        continue;
      }
      if (!placeholder.declaredDependencies.every((dependencyId) =>
        resolveLifecycleWorker(args.lifecycleState, dependencyId)?.status === "completed")) {
        continue;
      }

      const resolved: MaterializedCapsuleSubstitution[] = [];
      let derivable = true;
      for (const dependencyId of placeholder.declaredDependencies) {
        const ref = branchByWorkerId.get(dependencyId)
          ?? branchByWorkerId.get(findMatchingWorkerId(branchByWorkerId, dependencyId) ?? "");
        if (!ref) {
          // A NO-GIT dependency, or a row whose plan has no Branch column. There
          // is no ref to read, and a SHA is exactly the thing we must not
          // invent.
          derivable = false;
          derivationFailures.push(
            `${describeSection(placeholder)} needs ${dependencyId}'s SHA, but ${dependencyId} has no `
            + "branch in the dispatch plan — there is no ref to read it from"
          );
          break;
        }
        const sha = safeRevParse(revParse, ref, args.repoRoot);
        if (!sha) {
          derivable = false;
          derivationFailures.push(
            `${describeSection(placeholder)} needs ${dependencyId}'s SHA, but its ref \`${ref}\` `
            + "does not resolve to a commit"
          );
          break;
        }
        resolved.push({ workerId, dependencyId, ref, sha });
      }

      if (!derivable) {
        continue;
      }

      lines[placeholder.line - 1] = resolved
        .map((entry) => `${entry.dependencyId}@${entry.sha}`)
        .join("\n");
      substitutions.push(...resolved);
      changed = true;
    }

    if (changed) {
      // One write per capsule: a partially rewritten capsule read by a
      // concurrently launching row would be worse than no rewrite at all.
      writeFile(capsulePath, lines.join("\n"));
      materializedWorkers.push(workerId);
      args.log?.info?.("dispatcher_capsule_materialized", {
        event: "dispatcher_capsule_materialized",
        dispatchPlanPath: args.dispatchPlanPath,
        workerId,
        capsulePath,
        substitutions: substitutions.filter((entry) => entry.workerId === workerId)
      });
    }

    const hold = inspectCapsuleMaterialization({
      dispatchPlanPath: args.dispatchPlanPath,
      workerId,
      lifecycleState: args.lifecycleState,
      readFile,
      log: args.log,
      specManifest
    });
    if (hold) {
      // This sweep TRIED and failed, so `awaiting_fill` ("the next tick will do
      // it") would be a lie that repeats forever. Upgrade to the PM route and
      // carry the concrete reasons.
      stillHeld.push(
        hold.reason === "awaiting_fill" && derivationFailures.length > 0
          ? { ...hold, reason: "awaiting_pm", underivableReasons: derivationFailures }
          : hold
      );
    }
  }

  return { materializedWorkers, substitutions, stillHeld };
}

/**
 * Read the plan markdown and return the rows the materializer needs. Returns
 * `[]` for any read/parse failure — the caller then finds no branch for any
 * dependency, nothing is derivable, and the row parks. Failing CLOSED is the
 * whole point: an unreadable plan must never let an unmaterialized row launch.
 */
export function loadCapsuleMaterializationRows(
  dispatchPlanPath: string,
  io: CapsuleMaterializationIo = {}
): CapsuleMaterializationRow[] {
  const readFile = io.readFile ?? defaultReadFile;
  let markdown: string;
  try {
    markdown = readFile(dispatchPlanPath);
  } catch (error) {
    io.log?.warn?.("Dispatch plan unreadable; capsule materialization sweep skipped", {
      dispatch_plan_path: dispatchPlanPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }

  return parseDispatchPlanRows(markdown).map((row) => ({
    worker: row.worker_id,
    branch: row.branch ?? null
  }));
}

export interface EvaluateCapsuleMaterializationForLaunchArgs extends CapsuleMaterializationIo {
  dispatchPlanPath: string;
  workerId: string;
  lifecycleState: DispatchThreadStateV2;
  repoRoot?: string;
  /** Pre-parsed rows; loaded from `dispatchPlanPath` when omitted. */
  rows?: readonly CapsuleMaterializationRow[];
}

/**
 * The complete precondition for ONE launch: trigger, then refuse.
 *
 * Returns `null` when the row may launch, and a hold when it may not. This is
 * what `continueDispatchWorker` — the single funnel every launch path reaches —
 * calls, so both halves hold on every path without each path having to wire
 * them separately.
 *
 * Note the ordering: the fill is attempted FIRST, then the capsule is re-read.
 * A row therefore launches on the same tick its last dependency completed,
 * rather than parking for one extra tick — and, more importantly, the refusal
 * is decided by re-reading the file rather than by trusting the fill's own
 * return value.
 *
 * The two spec-file reasons short-circuit ahead of the fill. Not an
 * optimisation: with no capsule on disk there is no placeholder to substitute
 * into, and with an unreadable manifest the dispatcher does not know which file
 * IS the capsule — running the sweep in either state would be doing work
 * against a file it cannot vouch for.
 */
export function evaluateCapsuleMaterializationForLaunch(
  args: EvaluateCapsuleMaterializationForLaunchArgs
): CapsuleMaterializationHold | null {
  const workerId = args.workerId?.trim();
  if (!workerId) {
    return null;
  }

  // Read once and share with the sweep below: the fill and the refusal must
  // agree on which files the round declares, and two independent reads of
  // plan.json could straddle an operator's edit.
  const specManifest = args.specManifest ?? loadSpecManifest(args.dispatchPlanPath, args);

  // Cheap pre-check: no capsule, or no placeholder in it, means there is
  // nothing to trigger and nothing to refuse. Skips the plan read entirely for
  // the overwhelmingly common case.
  const inspect = () => inspectCapsuleMaterialization({
    dispatchPlanPath: args.dispatchPlanPath,
    workerId,
    lifecycleState: args.lifecycleState,
    readFile: args.readFile,
    log: args.log,
    specManifest
  });

  const initial = inspect();
  if (!initial) {
    return null;
  }
  if (initial.reason === "spec_not_written" || initial.reason === "spec_manifest_unreadable") {
    return initial;
  }

  const rows = args.rows ?? loadCapsuleMaterializationRows(args.dispatchPlanPath, args);
  const swept = materializeReadyCapsules({
    dispatchPlanPath: args.dispatchPlanPath,
    rows,
    lifecycleState: args.lifecycleState,
    repoRoot: args.repoRoot,
    only: [workerId],
    readFile: args.readFile,
    writeFile: args.writeFile,
    revParse: args.revParse,
    log: args.log,
    specManifest
  });

  // Prefer the SWEEP's hold: it is the one that knows whether a derivation was
  // attempted and failed, so the refusal message names the real gap instead of
  // promising a fill that will never happen. Fall back to a fresh read for the
  // case where the sweep skipped the row entirely (row absent from the plan).
  return swept.stillHeld.find((hold) => hold.workerId === workerId) ?? inspect();
}

// ─── Internals ──────────────────────────────────────────────────────────────

function describeSection(placeholder: CapsulePlaceholder): string {
  return placeholder.section
    ? `\`## ${placeholder.section}\` (line ${placeholder.line})`
    : `line ${placeholder.line}`;
}

function readCapsule(
  capsulePath: string,
  workerId: string,
  io: CapsuleMaterializationIo
): string | null {
  const readFile = io.readFile ?? defaultReadFile;
  let raw: string;
  try {
    raw = readFile(capsulePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      io.log?.warn?.("Context capsule unreadable; materialization precondition not applied", {
        worker_id: workerId,
        capsule_path: capsulePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  }

  return raw.trim().length === 0 ? null : raw;
}

function resolveLifecycleWorker(lifecycleState: DispatchThreadStateV2, workerId: string) {
  const direct = lifecycleState.workers?.[workerId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeWorkerId(workerId);
  return Object.entries(lifecycleState.workers ?? {})
    .find(([candidate]) => normalizeWorkerId(candidate) === normalized)?.[1];
}

function findMatchingWorkerId(branchByWorkerId: Map<string, string>, workerId: string): string | null {
  const normalized = normalizeWorkerId(workerId);
  for (const candidate of branchByWorkerId.keys()) {
    if (normalizeWorkerId(candidate) === normalized) {
      return candidate;
    }
  }
  return null;
}

function normalizeWorkerId(value: string): string {
  return value.replace(/[`*_\s]/g, "").toUpperCase();
}

function safeRevParse(
  revParse: NonNullable<CapsuleMaterializationIo["revParse"]>,
  ref: string,
  repoRoot: string | undefined
): string | null {
  if (!SAFE_GIT_REF_REGEX.test(ref)) {
    return null;
  }
  let output: string;
  try {
    output = revParse(ref, repoRoot);
  } catch {
    return null;
  }
  const sha = output.trim();
  return RESOLVED_SHA_REGEX.test(sha) ? sha.toLowerCase() : null;
}

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function defaultWriteFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf8");
}

function defaultRevParse(ref: string, repoRoot: string | undefined): string {
  return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}
