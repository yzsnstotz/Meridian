import { describe, expect, it } from "vitest";

import {
  normalizeReasoningEffort,
  parseDispatchModelCode,
  resolveDispatchModelMapFromMarkdown,
  resolveImplicitDispatchModelOverride
} from "../model-routing";

describe("resolveDispatchModelMapFromMarkdown", () => {
  it("parses provider/model pairs from the extended Model Legend", () => {
    const resolved = resolveDispatchModelMapFromMarkdown([
      "| Model | Code | Provider | Model ID | Assign When |",
      "|-------|------|----------|----------|-------------|",
      "| Codex | `CODEX` | `codex` | `gpt-5.4` | General work |",
      "| Opus | `OPUS` | `claude` | `claude-opus-4-6` | Architecture |",
      ""
    ].join("\n"), undefined);

    expect(resolved).toEqual({
      CODEX: {
        provider: "codex",
        model_id: "gpt-5.4"
      },
      OPUS: {
        provider: "claude",
        model_id: "claude-opus-4-6"
      }
    });
  });

  it("lets dispatch-start overrides take precedence and stays backward compatible with legacy legends", () => {
    const resolved = resolveDispatchModelMapFromMarkdown([
      "| Model | Code | Assign When |",
      "|-------|------|-------------|",
      "| Codex | `CODEX` | General work |",
      ""
    ].join("\n"), {
      CODEX: {
        provider: "codex",
        model_id: "o3-mini"
      }
    });

    expect(resolved).toEqual({
      CODEX: {
        provider: "codex",
        model_id: "o3-mini"
      }
    });
  });

  it("fills implicit provider/model defaults for legacy model codes", () => {
    const resolved = resolveDispatchModelMapFromMarkdown([
      "| Model | Code | Assign When |",
      "|-------|------|-------------|",
      "| Codex | `CODEX` | General work |",
      "| Codex High | `CODEX-HIGH` | Moderate coordination |",
      "| Codex XHigh | `CODEX-XHIGH` | Deep integration |",
      "| Opus | `OPUS` | Architecture |",
      "| Sonnet | `SONNET` | Lighter Claude work |",
      "| Gemini | `GEMINI` | Research |",
      ""
    ].join("\n"), undefined);

    expect(resolved).toEqual({
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
    });
  });

  it("normalizes model aliases and reads reasoning_effort from the model legend", () => {
    const resolved = resolveDispatchModelMapFromMarkdown([
      "| Model | Code | Provider | Model ID | Reasoning Effort | Assign When |",
      "|-------|------|----------|----------|-----------------|-------------|",
      "| Spark | `SPARK` | `codex` | `gpt_5_3_codex_spark` | `high` | General work |",
      ""
    ].join("\n"), undefined);

    expect(resolved).toEqual({
      SPARK: {
        provider: "codex",
        model_id: "gpt-5.3-codex-spark",
        reasoning_effort: "high"
      }
    });
  });

  it("parses model::effort references with normalized effort", () => {
    expect(parseDispatchModelCode("CODEX::high")).toEqual({
      modelCode: "CODEX",
      reasoningEffort: "high"
    });

    expect(parseDispatchModelCode("codex :: XHIGH")).toEqual({
      modelCode: "codex",
      reasoningEffort: "xhigh"
    });
  });

  it("preserves unsupported reasoning values in resolve model parsing as null", () => {
    expect(normalizeReasoningEffort("ultra")).toBeUndefined();
  });
});

describe("resolveImplicitDispatchModelOverride", () => {
  it("returns the legacy implicit defaults for known aliases", () => {
    expect(resolveImplicitDispatchModelOverride("CODEX-HIGH")).toEqual({
      provider: "codex",
      model_id: "gpt-5.5 high"
    });
    expect(resolveImplicitDispatchModelOverride("OPUS")).toEqual({
      provider: "claude",
      model_id: "claude-opus-4-7"
    });
  });

  it("treats canonical taskspec v1.2+ model ids as the model_id directly", () => {
    // Without this fallback, a row like `gpt-5.5::high` would parse to
    // modelCode="gpt-5.5" with no legend entry — `modelId` ends up undefined,
    // the spawn omits `model_id`, and the Hub falls back to whatever the codex
    // CLI is configured with locally (observed: `gpt-5.5-xhigh`). Recognizing
    // canonical ids here keeps taskspec / dispatcher detail / Hub aligned.
    expect(resolveImplicitDispatchModelOverride("gpt-5.5")).toEqual({
      provider: "codex",
      model_id: "gpt-5.5"
    });
    expect(resolveImplicitDispatchModelOverride("claude-opus-4-7")).toEqual({
      provider: "claude",
      model_id: "claude-opus-4-7"
    });
    expect(resolveImplicitDispatchModelOverride("gemini-2.5-pro")).toEqual({
      provider: "gemini",
      model_id: "gemini-2.5-pro"
    });
  });

  it("returns undefined for unknown codes with no canonical prefix", () => {
    expect(resolveImplicitDispatchModelOverride("UNKNOWN")).toBeUndefined();
    expect(resolveImplicitDispatchModelOverride("MY-CUSTOM-CODE")).toBeUndefined();
  });
});
