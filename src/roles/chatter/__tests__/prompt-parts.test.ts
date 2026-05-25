import { describe, expect, it } from "vitest";

import {
  buildMumuPromptParts,
  renderMumuPromptParts
} from "../prompt-parts";

describe("mumu prompt parts", () => {
  it("renders base prompt before subordinate preferences and user request", () => {
    const parts = buildMumuPromptParts({
      systemPromptId: "create_from_template",
      systemPrompt: "BASE SYSTEM",
      contextBlock: "## Pre-loaded context\ncontext body",
      envelopePromptParts: [
        {
          id: "user_request:create_from_template",
          kind: "user_request",
          content: "USER REQUEST"
        },
        {
          id: "preference:account",
          kind: "account_preferences",
          content: "PREFERENCE BLOCK"
        },
        {
          id: "ads_contract:create_from_template:douyin",
          kind: "ads_contract",
          content: "ADS CONTRACT"
        }
      ],
      legacyUserContent: "legacy duplicate"
    });

    const rendered = renderMumuPromptParts(parts);

    expect(rendered.content.indexOf("BASE SYSTEM")).toBeLessThan(rendered.content.indexOf("PREFERENCE BLOCK"));
    expect(rendered.content.indexOf("PREFERENCE BLOCK")).toBeLessThan(rendered.content.indexOf("USER REQUEST"));
    expect(rendered.content.indexOf("BASE SYSTEM")).toBeLessThan(rendered.content.indexOf("## Pre-loaded context"));
    expect(rendered.content.indexOf("ADS CONTRACT")).toBeLessThan(rendered.content.indexOf("USER REQUEST"));
    expect(rendered.content).not.toContain("legacy duplicate");
    expect(rendered.diagnostics).toEqual({
      prompt_part_ids: [
        "system_prompt:create_from_template",
        "context:resolved",
        "preference:account",
        "ads_contract:create_from_template:douyin",
        "user_request:create_from_template"
      ],
      preference_status: "applied"
    });
  });

  it("keeps minimal legacy turns byte-for-byte while adding diagnostics ids", () => {
    const parts = buildMumuPromptParts({
      legacyUserContent: "plain user turn"
    });

    const rendered = renderMumuPromptParts(parts);

    expect(rendered.content).toBe("plain user turn");
    expect(rendered.diagnostics).toEqual({
      prompt_part_ids: ["user_request:legacy"],
      preference_status: "not_provided"
    });
  });
});
