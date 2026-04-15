import { describe, expect, it } from "vitest";

import { resolveDispatchModelMapFromMarkdown } from "../model-routing";

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
        model_id: "gpt-5.4 high"
      },
      "CODEX-XHIGH": {
        provider: "codex",
        model_id: "gpt-5.4 xhigh"
      },
      OPUS: {
        provider: "claude",
        model_id: "claude-opus-4-6"
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
});
