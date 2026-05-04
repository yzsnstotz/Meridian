import type { DispatchModelMap, DispatchModelOverride } from "../../types";

interface DispatchPlanModelLegendEntry {
  provider: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
}

export interface ParsedDispatchModelRef {
  modelCode: string;
  reasoningEffort?: string;
}

export interface ResolvedDispatchModel extends DispatchModelOverride {
  reasoning_effort?: string;
}

const KNOWN_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const IMPLICIT_MODEL_CODE_DEFAULTS: Record<string, ResolvedDispatchModel> = {
  CODEX: {
    provider: "codex",
    model_id: "gpt-5.4 medium"
  },
  "CODEX-HIGH": {
    provider: "codex",
    model_id: "gpt-5.5 high"
  },
  "CODEX-XHIGH": {
    provider: "codex",
    model_id: "gpt-5.5 xhigh"
  },
  OPUS: {
    provider: "claude",
    model_id: "claude-opus-4-7"
  },
  SONNET: {
    provider: "claude",
    model_id: "claude-sonnet-4-6"
  },
  GEMINI: {
    provider: "gemini",
    model_id: "gemini-2.5-pro"
  }
};

const CANONICAL_MODEL_ID_ALIASES: Record<string, string> = {
  "gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
  "codex-spark": "gpt-5.3-codex-spark"
};

export function resolveDispatchModelMapFromMarkdown(
  markdown: string,
  overrides: DispatchModelMap | undefined
): Record<string, ResolvedDispatchModel> {
  const legend = parseDispatchPlanModelLegend(markdown);
  const resolved: Record<string, ResolvedDispatchModel> = {};

  for (const [code, entry] of Object.entries(legend)) {
    const resolvedEntry = toDispatchModelOverride(entry) ?? resolveImplicitDispatchModelOverride(code);
    if (!resolvedEntry) {
      continue;
    }

    resolved[code] = resolvedEntry;
  }

  return {
    ...resolved,
    ...(overrides ?? {})
  };
}

export function resolveImplicitDispatchModelOverride(
  modelCode: string | null | undefined
): ResolvedDispatchModel | undefined {
  const normalized = normalizeModelCode(modelCode);
  if (!normalized) {
    return undefined;
  }

  const implicit = IMPLICIT_MODEL_CODE_DEFAULTS[normalized];
  return implicit ? { ...implicit } : undefined;
}

export function parseDispatchModelCode(rawModel: string | undefined): ParsedDispatchModelRef | null {
  if (!rawModel) {
    return null;
  }

  const trimmed = rawModel.trim().replace(/^`+|`+$/g, "");
  if (!trimmed || trimmed === "—") {
    return null;
  }

  const separatorIndex = trimmed.indexOf("::");
  if (separatorIndex === -1) {
    return { modelCode: trimmed };
  }

  const modelCode = trimmed.slice(0, separatorIndex).trim();
  if (!modelCode) {
    return null;
  }

  const reasoningEffort = normalizeReasoningEffort(trimmed.slice(separatorIndex + 2));
  return {
    modelCode,
    reasoningEffort
  };
}

export function normalizeReasoningEffort(value: string | null | undefined): string | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized || !KNOWN_REASONING_EFFORTS.has(normalized)) {
    return undefined;
  }

  return normalized;
}

export function parseDispatchPlanModelLegend(markdown: string): Record<string, DispatchPlanModelLegendEntry> {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const columnIndex = indexModelLegendColumns(headerCells);
    if (!columnIndex) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    const modelLegend: Record<string, DispatchPlanModelLegendEntry> = {};
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      const code = readOptionalCell(rowCells[columnIndex.code]);
      if (!code) {
        continue;
      }

      modelLegend[code] = {
        provider: columnIndex.provider === -1 ? null : readOptionalCell(rowCells[columnIndex.provider]),
        model_id: columnIndex.model_id === -1 ? null : readOptionalCell(rowCells[columnIndex.model_id]),
        reasoning_effort: columnIndex.reasoning_effort === -1
          ? null
          : normalizeReasoningEffort(readOptionalCell(rowCells[columnIndex.reasoning_effort]) ?? undefined) ?? null
      };
    }

    return modelLegend;
  }

  return {};
}

function indexModelLegendColumns(headerCells: string[]): {
  code: number;
  provider: number;
  model_id: number;
  reasoning_effort: number;
} | null {
  const normalizedHeaders = headerCells.map(normalizeTableHeader);
  const code = normalizedHeaders.indexOf("code");

  if (code === -1) {
    return null;
  }

  return {
    code,
    provider: normalizedHeaders.indexOf("provider"),
    model_id: normalizedHeaders.indexOf("model_id"),
    reasoning_effort: normalizedHeaders.indexOf("reasoning_effort")
  };
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }

  const withoutLeadingPipe = trimmed.slice(1);
  const normalized = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return normalized.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function normalizeTableHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeModelCode(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function toDispatchModelOverride(entry: DispatchPlanModelLegendEntry): ResolvedDispatchModel | undefined {
  if (!entry.provider || !entry.model_id) {
    return undefined;
  }

  const normalizedModelId = normalizeModelId(entry.model_id);
  if (!normalizedModelId) {
    return undefined;
  }

  const resolved: ResolvedDispatchModel = {
    provider: entry.provider,
    model_id: normalizedModelId
  };

  if (entry.reasoning_effort && KNOWN_REASONING_EFFORTS.has(entry.reasoning_effort)) {
    resolved.reasoning_effort = entry.reasoning_effort;
  }

  return resolved;
}

function normalizeModelId(modelId: string): string | null {
  const normalizedModelId = modelId.trim();
  const normalizedAlias = normalizedModelId.replace(/_/g, "-").toLowerCase();
  return CANONICAL_MODEL_ID_ALIASES[normalizedAlias] ?? normalizedAlias;
}

function readOptionalCell(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^`+|`+$/g, "");
  return trimmed.length > 0 && trimmed !== "—" ? trimmed : null;
}
