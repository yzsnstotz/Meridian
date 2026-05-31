import { z } from "zod";

/**
 * Class A read-only skill: fetch a single DNA template row from ADS.
 *
 * Calls `POST /api/mumu2/read-only-query` with `{ kind: "dna_template", id }`.
 * The caller's `user_id` is baked into the HMAC by the ADS-side transport
 * (this skill is HTTP-transport-agnostic — the gateway adds auth).
 *
 * LAW-7: input schema is `.strict()`.
 * LAW-9: this skill targets `/api/mumu2/*` (not `/api/mumu/*`).
 */
export const FetchDnaTemplateInputSchema = z
  .object({
    id: z.string().min(1)
  })
  .strict();

export type FetchDnaTemplateInput = z.infer<typeof FetchDnaTemplateInputSchema>;

/**
 * Output is intentionally loose: a DNA template row's shape evolves with the
 * mumu2 schema (beats, granularity, references, etc.) and pinning a strict
 * shape here would force a meridian-roles release every time ADS adds a
 * column. The 2-arg `z.record(z.string(), z.unknown())` form is required on
 * zod v4 — the 1-arg form silently produces a broken schema (P2.X.A.1
 * finding).
 */
export const FetchDnaTemplateOutputSchema = z.record(z.string(), z.unknown());

export type FetchDnaTemplateOutput = z.infer<typeof FetchDnaTemplateOutputSchema>;

export interface FetchDnaTemplateTransportResponse {
  ok: boolean;
  status: number;
  json(): Promise<{
    kind?: string;
    id?: string;
    content?: Record<string, unknown>;
    error?: string;
  }>;
}

export interface FetchDnaTemplateTransport {
  post(url: string, body: unknown): Promise<FetchDnaTemplateTransportResponse>;
}

export interface FetchDnaTemplateDeps {
  transport: FetchDnaTemplateTransport;
}

export async function fetchDnaTemplate(
  input: FetchDnaTemplateInput,
  deps: FetchDnaTemplateDeps
): Promise<FetchDnaTemplateOutput> {
  const validated = FetchDnaTemplateInputSchema.parse(input);
  const res = await deps.transport.post("/api/mumu2/read-only-query", {
    kind: "dna_template",
    id: validated.id
  });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({} as { error?: string }));
    throw new Error(
      `fetch_dna_template:${body.error ?? `HTTP_${res.status}`}`
    );
  }
  const body = await res.json();
  if (!body.content) {
    throw new Error("fetch_dna_template:MALFORMED_RESPONSE");
  }
  return body.content;
}
