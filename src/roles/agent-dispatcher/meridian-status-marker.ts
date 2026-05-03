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

const MULTILINE_STRING_FIELDS = new Set(["notes", "feedback", "error"]);

const WorkerMarkerSchema = z.object({
  role: z.literal("worker"),
  worker_id: z.string().min(1),
  outcome: z.enum(["complete", "failed", "blocked", "hit_limit", "needs_pm"]),
  report_path: z.string().min(1).optional(),
  notes: z.string().optional(),
  error: z.string().optional()
});

const ValidatorMarkerSchema = z.object({
  role: z.literal("validator"),
  worker_id: z.string().min(1),
  outcome: z.enum(["pass", "fix_requested", "fail"]),
  cycle: z.number().int().nonnegative().optional(),
  score: z.number().optional(),
  feedback: z.string().optional(),
  notes: z.string().optional()
});

const PmResolverMarkerSchema = z.object({
  role: z.literal("pm-resolver"),
  worker_id: z.string().min(1),
  outcome: z.enum(["resolved", "escalated"]),
  pm_action: z.enum(["retry", "skip", "force_complete", "wait", "escalate_human"]).optional(),
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

export function parseMeridianStatusMarker(text: string): MeridianStatusMarker | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  const scrubbed = stripFencedRegions(text);
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
