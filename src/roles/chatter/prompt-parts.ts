import type { MumuChatterDiagnostics, MumuPromptPart, MumuPromptPartKind } from "../../types";

const PROMPT_PART_ORDER: Record<MumuPromptPartKind, number> = {
  base_system_prompt: 10,
  context: 20,
  account_preferences: 30,
  ads_contract: 40,
  user_request: 50
};

export interface BuildMumuPromptPartsInput {
  systemPromptId?: string;
  systemPrompt?: string;
  contextBlock?: string | null;
  envelopePromptParts?: MumuPromptPart[];
  legacyUserContent: string;
}

export interface RenderedMumuPromptParts {
  content: string;
  diagnostics: Pick<MumuChatterDiagnostics, "prompt_part_ids" | "preference_status">;
}

export function buildMumuPromptParts(input: BuildMumuPromptPartsInput): MumuPromptPart[] {
  const parts: MumuPromptPart[] = [];
  const systemPrompt = input.systemPrompt?.trimEnd();
  const contextBlock = input.contextBlock?.trimEnd();
  const envelopePromptParts = input.envelopePromptParts ?? [];

  if (systemPrompt) {
    parts.push({
      id: `system_prompt:${input.systemPromptId ?? "inline"}`,
      kind: "base_system_prompt",
      content: systemPrompt
    });
  }

  if (contextBlock) {
    parts.push({
      id: "context:resolved",
      kind: "context",
      content: contextBlock
    });
  }

  parts.push(...envelopePromptParts);

  const hasUserRequest = envelopePromptParts.some((part) => part.kind === "user_request");
  if (!hasUserRequest) {
    parts.push({
      id: "user_request:legacy",
      kind: "user_request",
      content: input.legacyUserContent
    });
  }

  return parts;
}

export function renderMumuPromptParts(parts: MumuPromptPart[]): RenderedMumuPromptParts {
  const ordered = parts
    .map((part, index) => ({ part, index }))
    .sort((left, right) => {
      const orderDelta = PROMPT_PART_ORDER[left.part.kind] - PROMPT_PART_ORDER[right.part.kind];
      return orderDelta === 0 ? left.index - right.index : orderDelta;
    })
    .map(({ part }) => part);

  const hasOnlyLegacyUserRequest =
    ordered.length === 1 && ordered[0]?.kind === "user_request" && ordered[0].id === "user_request:legacy";

  return {
    content: hasOnlyLegacyUserRequest
      ? ordered[0]!.content
      : ordered.map(formatPromptPart).join("\n\n"),
    diagnostics: {
      prompt_part_ids: ordered.map((part) => part.id),
      preference_status: ordered.some((part) => part.kind === "account_preferences") ? "applied" : "not_provided"
    }
  };
}

function formatPromptPart(part: MumuPromptPart): string {
  const content = part.content.trimEnd();
  switch (part.kind) {
    case "base_system_prompt":
      return ["System prompt for this turn:", content].join("\n");
    case "context":
      return content;
    case "account_preferences":
      return ["Account creative preferences for this turn:", content].join("\n");
    case "ads_contract":
      return ["ADS functional contract for this turn:", content].join("\n");
    case "user_request":
      return ["User turn:", content].join("\n");
  }
}
