import { z } from "zod";

// ─── Schema ────────────────────────────────────────────────────────────────────
//
// Structured status marker that worker / validator / pm-resolver agents are
// required to emit at the end of their reply. The dispatcher parses this block
// to derive a deterministic lifecycle outcome instead of guessing from prose.
//
// Wire format (inside agent reply text):
//
//   <<<MERIDIAN-STATUS>>>
//   role: worker
//   worker_id: N-01
//   outcome: complete
//   report_path: artifacts/reports/N-01-report.md
//   notes: short single-line note
//   <<<END>>>
//
// Multiline string fields (notes, feedback, error) may use YAML-pipe style:
//
//   feedback: |
//     line one
//     line two
//
// Parser semantics worth knowing:
//
// - Stray openers are skipped leniently. If a `<<<MERIDIAN-STATUS>>>` opener
//   appears with no closer before the next opener, it is treated as a stray
//   token (e.g. quoted illustration in narrative) and the parser keeps
//   scanning for a genuinely paired BEGIN/END block.
// - If the same key appears twice inside a single block, the last occurrence
//   wins.

const MARKER_BEGIN = "<<<MERIDIAN-STATUS>>>";
const MARKER_END = "<<<END>>>";

const MULTILINE_STRING_FIELDS = new Set(["notes", "feedback", "error", "delegatable", "blocking"]);

// Canonical role-outcome enums. Single-sourced here so the Zod schemas below
// and the per-role preamble emitters in `tool-gateway/tools/run.ts` (and the
// upcoming validator / pm-resolver preambles) cannot drift in spelling.
export const WORKER_MARKER_OUTCOMES = [
  "complete",
  "failed",
  "blocked",
  "hit_limit",
  "needs_pm"
] as const;

export const VALIDATOR_MARKER_OUTCOMES = ["pass", "fix_requested", "fail"] as const;

export const PM_RESOLVER_MARKER_OUTCOMES = ["resolved", "escalated"] as const;

export const PM_RESOLVER_ACTIONS = [
  "retry",
  "skip",
  "force_complete",
  "wait",
  "escalate_human"
] as const;

const WorkerMarkerSchema = z.object({
  role: z.literal("worker"),
  worker_id: z.string().min(1),
  outcome: z.enum(WORKER_MARKER_OUTCOMES),
  report_path: z.string().min(1).optional(),
  notes: z.string().optional(),
  error: z.string().optional()
});

const ValidatorMarkerSchema = z.object({
  role: z.literal("validator"),
  worker_id: z.string().min(1),
  outcome: z.enum(VALIDATOR_MARKER_OUTCOMES),
  cycle: z.number().int().nonnegative().optional(),
  score: z.number().optional(),
  feedback: z.string().optional(),
  notes: z.string().optional(),
  // v1.23.0 structured fix-request fields (optional, multi-line).
  // `delegatable`: each non-empty line is `ref=<file:line-or-section> target=<worker_id> [reason=<short>]`.
  // `blocking`:    each non-empty line is a free-text criterion that BLOCKS pass and is NOT delegable.
  // The dispatcher's auto-clarify branch (validator-orchestrator) inspects
  // these when outcome === fix_requested: a single delegatable entry whose
  // target exists in the plan triggers auto-PM-Clarification + force-complete
  // without spawning a PM resolver. Multiple delegatables, any blocking item,
  // or an unresolved target fall through to the PM-resolver path verbatim.
  delegatable: z.string().optional(),
  blocking: z.string().optional()
});

const PmResolverMarkerSchema = z.object({
  role: z.literal("pm-resolver"),
  worker_id: z.string().min(1),
  outcome: z.enum(PM_RESOLVER_MARKER_OUTCOMES),
  pm_action: z.enum(PM_RESOLVER_ACTIONS).optional(),
  notes: z.string().optional()
});

export const MeridianStatusMarkerSchema = z.discriminatedUnion("role", [
  WorkerMarkerSchema,
  ValidatorMarkerSchema,
  PmResolverMarkerSchema
]);

export type MeridianStatusMarker = z.infer<typeof MeridianStatusMarkerSchema>;
export type WorkerStatusMarker = z.infer<typeof WorkerMarkerSchema>;
export type ValidatorStatusMarker = z.infer<typeof ValidatorMarkerSchema>;
export type PmResolverStatusMarker = z.infer<typeof PmResolverMarkerSchema>;

// ─── Public API ────────────────────────────────────────────────────────────────

export interface ParseMeridianStatusMarkerOptions {
  // When true, marker blocks inside fenced code regions are still parsed.
  // Use this for report/artifact files, where the worker may legitimately wrap
  // its final marker in a ``` fence for readability. Default false matches the
  // chat-reply context where workers may quote example markers in narrative.
  allowFenced?: boolean;
}

export function parseMeridianStatusMarker(
  text: string,
  options: ParseMeridianStatusMarkerOptions = {}
): MeridianStatusMarker | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  const scrubbed = options.allowFenced ? text : stripFencedRegions(text);
  const blocks = findMarkerBlocks(scrubbed);
  if (blocks.length === 0) {
    return null;
  }

  const lastBlock = blocks[blocks.length - 1];
  const fields = parseBlockFields(lastBlock);
  if (fields === null) {
    return null;
  }

  const result = MeridianStatusMarkerSchema.safeParse(fields);
  if (!result.success) {
    return null;
  }

  return result.data;
}

// ─── Internals ─────────────────────────────────────────────────────────────────

/**
 * Replaces fenced code regions (``` … ``` and ~~~ … ~~~) with blank space of
 * the same length, so that any marker text inside example/illustration fences
 * is ignored without shifting line offsets.
 */
function stripFencedRegions(text: string): string {
  // Handles either fence style; matches non-greedy across lines.
  const fenceRegex = /(^|\n)([ \t]*)(```|~~~)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
  return text.replace(fenceRegex, (match) => match.replace(/[^\n]/g, " "));
}

function findMarkerBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const beginIdx = text.indexOf(MARKER_BEGIN, cursor);
    if (beginIdx === -1) {
      break;
    }

    const contentStart = beginIdx + MARKER_BEGIN.length;
    const nextBeginIdx = text.indexOf(MARKER_BEGIN, contentStart);
    const endIdx = text.indexOf(MARKER_END, contentStart);

    if (endIdx === -1) {
      // Malformed: opener with no closer anywhere ahead. Stop scanning so we
      // never emit a truncated block.
      break;
    }

    if (nextBeginIdx !== -1 && nextBeginIdx < endIdx) {
      // Another opener appears before the next closer — the current opener
      // is stray (e.g. quoted illustration in narrative). Skip it and keep
      // scanning from the next opener.
      cursor = nextBeginIdx;
      continue;
    }

    blocks.push(text.slice(contentStart, endIdx));
    cursor = endIdx + MARKER_END.length;
  }

  return blocks;
}

/**
 * Parses the body of a single marker block (text between begin and end
 * delimiters) into a key/value record. Supports YAML-pipe multiline values
 * for the fields in `MULTILINE_STRING_FIELDS`. Numeric-looking values for
 * known numeric fields (`cycle`, `score`) are converted; everything else is
 * kept as a string.
 *
 * Returns null if the block contains no recognisable `key: value` lines.
 */
function parseBlockFields(block: string): Record<string, unknown> | null {
  const lines = block.split("\n");
  const fields: Record<string, unknown> = {};

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    i += 1;

    if (line.length === 0) {
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      // Stray non-key line inside a marker block — ignore so a single typo
      // does not nuke an otherwise valid marker.
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const valuePart = line.slice(colonIdx + 1).trim();

    if (key.length === 0) {
      continue;
    }

    if (valuePart === "|" && MULTILINE_STRING_FIELDS.has(key)) {
      const { value, nextIndex } = readPipeBlock(lines, i);
      fields[key] = value;
      i = nextIndex;
      continue;
    }

    fields[key] = coerceScalar(key, valuePart);
  }

  return Object.keys(fields).length === 0 ? null : fields;
}

function readPipeBlock(lines: string[], startIndex: number): { value: string; nextIndex: number } {
  const collected: string[] = [];
  let baseIndent: number | null = null;
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      collected.push("");
      i += 1;
      continue;
    }

    const indent = countLeadingSpaces(line);
    if (baseIndent === null) {
      if (indent === 0) {
        // No indented content — pipe block is empty.
        break;
      }
      baseIndent = indent;
    }

    if (indent < baseIndent) {
      break;
    }

    collected.push(line.slice(baseIndent));
    i += 1;
  }

  // Trim trailing blank lines so a stray newline before <<<END>>> doesn't
  // appear in the captured value.
  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }

  return { value: collected.join("\n"), nextIndex: i };
}

function countLeadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) {
    n += 1;
  }
  return n;
}

function coerceScalar(key: string, value: string): unknown {
  if (key === "cycle" || key === "score") {
    if (value.length === 0) {
      return value;
    }
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return value;
}

// ─── Validator delegatable / blocking parsers (v1.23.0) ────────────────────────

export interface ValidatorDelegatableEntry {
  /** Source citation, e.g. "R-04.md:155" or "R-04.md §Applied Laws". */
  ref: string;
  /** Target worker ID (e.g. "V-01"); must exist in the dispatch plan to auto-clarify. */
  target: string;
  /** Optional one-line reason for the delegation (free text). */
  reason?: string;
}

export interface ValidatorBlockingEntry {
  /** Free-text criterion that must be resolved before the worker can pass. */
  criterion: string;
}

const DELEGATABLE_LINE_REGEX = /^\s*ref\s*=\s*(?<ref>\S+(?:\s+\S+)*?)\s+target\s*=\s*(?<target>\S+)(?:\s+reason\s*=\s*(?<reason>.*))?\s*$/;

/**
 * Parse a `delegatable: |` multi-line YAML-pipe value from the validator marker.
 * Each non-empty line must match `ref=<citation> target=<worker_id> [reason=<text>]`.
 * Lines that don't match are silently skipped (the orchestrator will not act on them).
 *
 * Returns the empty array for `undefined` / `null` / empty input — auto-clarify
 * is only triggered when this returns exactly one entry whose target resolves
 * to a known plan row.
 */
export function parseValidatorDelegatable(raw: string | undefined | null): ValidatorDelegatableEntry[] {
  if (!raw || typeof raw !== "string") {
    return [];
  }
  const out: ValidatorDelegatableEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = DELEGATABLE_LINE_REGEX.exec(trimmed);
    if (!match || !match.groups) continue;
    const ref = match.groups.ref?.trim();
    const target = match.groups.target?.trim();
    if (!ref || !target) continue;
    const entry: ValidatorDelegatableEntry = { ref, target };
    const reason = match.groups.reason?.trim();
    if (reason && reason.length > 0) entry.reason = reason;
    out.push(entry);
  }
  return out;
}

/**
 * Parse a `blocking: |` multi-line YAML-pipe value. Each non-empty line becomes
 * one ValidatorBlockingEntry. Used by the orchestrator to refuse auto-clarify
 * when at least one item is non-delegable: a worker may simultaneously report a
 * delegatable item AND a hard blocker; the hard blocker wins and the PM resolver
 * runs as usual.
 */
export function parseValidatorBlocking(raw: string | undefined | null): ValidatorBlockingEntry[] {
  if (!raw || typeof raw !== "string") {
    return [];
  }
  const out: ValidatorBlockingEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push({ criterion: trimmed });
  }
  return out;
}
