import { z } from "zod";

/**
 * Class A read-only skill: fetch a single full-text source row from ADS.
 *
 * Calls `POST /api/mumu2/read-only-query` with `{ kind: "source", id }`.
 * The caller's `user_id` is baked into the HMAC by the ADS-side transport
 * (this skill is HTTP-transport-agnostic — the gateway adds auth).
 *
 * LAW-7: input schema is `.strict()`.
 * LAW-9: this skill targets `/api/mumu2/*` (not `/api/mumu/*`).
 */
export const FetchFullSourceInputSchema = z
  .object({
    id: z.string().min(1)
  })
  .strict();

export type FetchFullSourceInput = z.infer<typeof FetchFullSourceInputSchema>;

/**
 * Output is intentionally loose for the same reason as `fetch_dna_template`:
 * source rows evolve (text, title, created_at, metadata) and pinning a strict
 * shape here would force a meridian-roles release each time ADS adds a column.
 * 2-arg `z.record(z.string(), z.unknown())` is required on zod v4.
 */
export const FetchFullSourceOutputSchema = z.record(z.string(), z.unknown());

export type FetchFullSourceOutput = z.infer<typeof FetchFullSourceOutputSchema>;

type FetchFullSourceResponseBody = {
  kind?: string;
  id?: string;
  content?: Record<string, unknown>;
  error?: string;
};

export interface FetchFullSourceTransportResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface FetchFullSourceTransport {
  post(url: string, body: unknown): Promise<FetchFullSourceTransportResponse>;
}

export interface FetchFullSourceDeps {
  transport: FetchFullSourceTransport;
}

export async function fetchFullSource(
  input: FetchFullSourceInput,
  deps: FetchFullSourceDeps
): Promise<FetchFullSourceOutput> {
  const validated = FetchFullSourceInputSchema.parse(input);
  const res = await deps.transport.post("/api/mumu2/read-only-query", {
    kind: "source",
    id: validated.id
  });
  if (!res.ok) {
    const body = asFetchFullSourceResponseBody(await res.json().catch(() => ({})));
    throw new Error(`fetch_full_source:${body.error ?? `HTTP_${res.status}`}`);
  }
  const body = asFetchFullSourceResponseBody(await res.json());
  if (!body.content) {
    throw new Error("fetch_full_source:MALFORMED_RESPONSE");
  }
  return body.content;
}

function asFetchFullSourceResponseBody(value: unknown): FetchFullSourceResponseBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as FetchFullSourceResponseBody;
}
