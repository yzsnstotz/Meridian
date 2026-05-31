/**
 * mumu2 project-scoped skills.
 *
 * Skills here are referenced by short name (e.g. `fetch_dna_template`) in
 * `config/projects/mumu2.json#skill_allowlist`. They surface to the sandboxed
 * Codex agent as `chatter.skill.<name>` tool descriptors and are dispatched
 * by the chatter role's `handleAgentToolCall` (see
 * `src/roles/definitions/chatter.ts`).
 *
 * `skillManifest` below is the canonical handler map consumed by
 * `src/projects/registry.ts` and threaded through `registerProjectSkills`
 * into the chatter's `skillHandlers` Map at activate time. Each handler
 * binds the underlying skill function to the per-user `AdsHmacTransport`
 * supplied by the dispatcher.
 */
import type { SkillManifest } from "../../registry";
import { fetchDnaTemplate } from "./fetch_dna_template";
import { fetchFullSource } from "./fetch_full_source";

export {
  fetchDnaTemplate,
  FetchDnaTemplateInputSchema,
  FetchDnaTemplateOutputSchema
} from "./fetch_dna_template";
export type {
  FetchDnaTemplateInput,
  FetchDnaTemplateOutput,
  FetchDnaTemplateDeps,
  FetchDnaTemplateTransport,
  FetchDnaTemplateTransportResponse
} from "./fetch_dna_template";

export {
  fetchFullSource,
  FetchFullSourceInputSchema,
  FetchFullSourceOutputSchema
} from "./fetch_full_source";
export type {
  FetchFullSourceInput,
  FetchFullSourceOutput,
  FetchFullSourceDeps,
  FetchFullSourceTransport,
  FetchFullSourceTransportResponse
} from "./fetch_full_source";

/**
 * mumu2 manifest. Each entry is a thin (transport, input) wrapper around the
 * underlying skill function so the per-user transport is bound at invoke
 * time, not at registration time. Keys MUST match
 * `config/projects/mumu2.json#skill_allowlist`.
 */
export const skillManifest: SkillManifest = {
  fetch_dna_template: (transport, input) =>
    fetchDnaTemplate(input as Parameters<typeof fetchDnaTemplate>[0], { transport }),
  fetch_full_source: (transport, input) =>
    fetchFullSource(input as Parameters<typeof fetchFullSource>[0], { transport })
};
