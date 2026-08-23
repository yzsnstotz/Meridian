import { ReasoningEffortSchema, type ReasoningEffort } from "../types";

const RECOGNIZED_MODEL_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh"]);

export interface ParsedModelReference {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export function parseReasoningEffort(value: string | null | undefined): ReasoningEffort | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const parsed = ReasoningEffortSchema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}

export function parseModelReference(
  rawModelId: string | null | undefined,
  explicitReasoningEffort?: string | null | ReasoningEffort
): ParsedModelReference {
  const modelId = typeof rawModelId === "string" ? rawModelId.trim() : "";
  if (!modelId) {
    const effort = parseReasoningEffort(typeof explicitReasoningEffort === "string" ? explicitReasoningEffort : null);
    return {
      modelId: "",
      ...(effort && { reasoningEffort: effort })
    };
  }

  const lastSpaceIndex = modelId.lastIndexOf(" ");
  let parsedEffort = parseReasoningEffort(
    typeof explicitReasoningEffort === "string" ? explicitReasoningEffort : undefined
  );

  const separatorIndex = modelId.indexOf("::");
  if (separatorIndex > -1) {
    const modelPart = modelId.slice(0, separatorIndex).trim();
    if (modelPart) {
      return {
        modelId: modelPart,
        reasoningEffort: parsedEffort ?? parseReasoningEffort(modelId.slice(separatorIndex + 2))
      };
    }
  }

  if (lastSpaceIndex > -1) {
    const possibleEffort = modelId.slice(lastSpaceIndex + 1).trim().toLowerCase();
    if (RECOGNIZED_MODEL_EFFORTS.has(possibleEffort)) {
      const normalizedModelId = modelId.slice(0, lastSpaceIndex).trim();
      return {
        modelId: normalizedModelId,
        reasoningEffort: parsedEffort ?? parseReasoningEffort(possibleEffort)
      };
    }
  }

  return {
    modelId,
    ...(parsedEffort && { reasoningEffort: parsedEffort })
  };
}
