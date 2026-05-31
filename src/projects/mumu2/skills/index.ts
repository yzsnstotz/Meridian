/**
 * mumu2 project-scoped skills.
 *
 * Skills here are referenced by short name (e.g. `fetch_dna_template`) in
 * `config/projects/mumu2.json#skill_allowlist`. They surface to the sandboxed
 * Codex agent as `chatter.skill.<name>` tool descriptors and are dispatched
 * by the chatter role's `handleAgentToolCall` (see
 * `src/roles/definitions/chatter.ts`).
 *
 * NOTE: as of P2.X.B.1 there is no project-scoped skill-registration plug
 * point inside the chatter role — only the always-available
 * `chatter.suggest_observation` and the `structured.*` family are wired into
 * `skillHandlers`. Wiring the project-scoped skills (including
 * `fetch_dna_template`) into the dispatcher is tracked separately as a
 * follow-up; this module is the canonical export surface those wires will
 * import from.
 */
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
