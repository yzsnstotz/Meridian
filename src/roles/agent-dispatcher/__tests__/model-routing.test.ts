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
});
