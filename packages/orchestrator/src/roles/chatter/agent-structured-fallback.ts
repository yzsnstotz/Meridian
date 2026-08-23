import { z } from "zod";
import {
  ChatterCandidateObservationSchema,
  ChatterExtractStateSchema,
  type ChatterTurnEnvelope
} from "../../types";

const ChatterSuggestObservationArgsSchema = ChatterCandidateObservationSchema.omit({
  observation_id: true
});

const SuggestObservationFallbackSchema = z.object({
  tool: z.literal("chatter.suggest_observation"),
  args: ChatterSuggestObservationArgsSchema
});

const WrappedFallbackSchema = z.object({
  mumu_structured_fallback: SuggestObservationFallbackSchema
});

const WrappedFallbacksSchema = z.object({
  mumu_structured_fallbacks: z.array(SuggestObservationFallbackSchema).min(1).max(5)
});

const PayloadChatterFallbackSchema = z.object({
  payload: z.object({
    chatter: z.object({
      extract_state: ChatterExtractStateSchema.optional()
    })
  })
});

const ChatterFallbackSchema = z.object({
  chatter: z.object({
    extract_state: ChatterExtractStateSchema.optional()
  })
});

const DirectExtractStateFallbackSchema = z.object({
  extract_state: ChatterExtractStateSchema
});

export interface AgentStructuredFallback {
  chatter: Pick<ChatterTurnEnvelope, "extract_state">;
  toolCalls: Array<z.infer<typeof SuggestObservationFallbackSchema>>;
}

export function parseAgentStructuredFallback(content: string): AgentStructuredFallback {
  const fallback: AgentStructuredFallback = {
    chatter: {},
    toolCalls: []
  };

  for (const value of extractJsonValues(content)) {
    const wrapped = WrappedFallbackSchema.safeParse(value);
    if (wrapped.success) {
      fallback.toolCalls.push(wrapped.data.mumu_structured_fallback);
    } else {
      const wrappedMany = WrappedFallbacksSchema.safeParse(value);
      if (wrappedMany.success) {
        fallback.toolCalls.push(...wrappedMany.data.mumu_structured_fallbacks);
      } else {
        const directTool = SuggestObservationFallbackSchema.safeParse(value);
        if (directTool.success) {
          fallback.toolCalls.push(directTool.data);
        }
      }
    }

    if (!fallback.chatter.extract_state) {
      const payloadChatter = PayloadChatterFallbackSchema.safeParse(value);
      if (payloadChatter.success && payloadChatter.data.payload.chatter.extract_state) {
        fallback.chatter.extract_state = payloadChatter.data.payload.chatter.extract_state;
        continue;
      }

      const chatter = ChatterFallbackSchema.safeParse(value);
      if (chatter.success && chatter.data.chatter.extract_state) {
        fallback.chatter.extract_state = chatter.data.chatter.extract_state;
        continue;
      }

      const directExtractState = DirectExtractStateFallbackSchema.safeParse(value);
      if (directExtractState.success) {
        fallback.chatter.extract_state = directExtractState.data.extract_state;
      }
    }
  }

  return fallback;
}

export function stripAgentStructuredFallbackContent(content: string): string {
  let strippedAny = false;
  const stripped = content.replace(fencedJsonPattern(), (fullMatch, body: string) => {
    const parsed = parseJsonCandidate(body.trim());
    if (parsed !== undefined && isStructuredFallbackValue(parsed)) {
      strippedAny = true;
      return "";
    }
    return fullMatch;
  });

  const trimmed = stripped.replace(/\n{3,}/g, "\n\n").trim();
  const wholeJson = parseJsonCandidate(trimmed);
  if (wholeJson !== undefined && isStructuredFallbackValue(wholeJson)) {
    return "";
  }

  return strippedAny ? trimmed : content;
}

function extractJsonValues(content: string): unknown[] {
  const candidates = new Set<string>();
  const pattern = fencedJsonPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.add(candidate);
    }
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.add(trimmed);
  }

  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    const value = parseJsonCandidate(candidate);
    if (value !== undefined) {
      parsed.push(value);
    }
  }
  return parsed;
}

function fencedJsonPattern(): RegExp {
  return /```(?:json)?\s*([\s\S]*?)```/gi;
}

function parseJsonCandidate(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function isStructuredFallbackValue(value: unknown): boolean {
  return (
    WrappedFallbackSchema.safeParse(value).success ||
    WrappedFallbacksSchema.safeParse(value).success ||
    SuggestObservationFallbackSchema.safeParse(value).success ||
    PayloadChatterFallbackSchema.safeParse(value).success ||
    ChatterFallbackSchema.safeParse(value).success ||
    DirectExtractStateFallbackSchema.safeParse(value).success
  );
}
