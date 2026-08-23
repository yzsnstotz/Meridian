/**
 * Project-scoped skill registry.
 *
 * A `SkillManifest` is a map from short skill name (the same name that appears
 * in `config/projects/<project>.json#skill_allowlist`) to a handler that takes
 * a per-user `AdsHmacTransport` plus the raw skill arguments. Handlers are
 * stateless wrappers around the actual skill function (e.g. `fetchDnaTemplate`);
 * binding the transport at INVOKE time — not at registration time — is what
 * lets a single chatter role instance serve a single bound user without
 * leaking another user's identity into the signature.
 *
 * Adding a project:
 *   1. Implement the skills under `src/projects/<project>/skills/*.ts`.
 *   2. Export a `skillManifest: SkillManifest` from `src/projects/<project>/skills/index.ts`.
 *   3. Register the lazy loader here (`registerProjectManifest("...", () => ...)`).
 *   4. List the skills in `config/projects/<project>.json#skill_allowlist`.
 *
 * Lazy loading is deliberate: the registry is imported by the chatter role at
 * activate time, but most chatter instances will only ever touch one project's
 * manifest. Each loader is a thunk so unrelated projects' modules aren't
 * eagerly evaluated.
 */

import type { AdsHmacTransport } from "../transport/ads-hmac";
import { skillManifest as mumu2SkillManifest } from "./mumu2/skills";

/**
 * A single project-scoped skill handler. Receives the per-user HMAC-signed
 * transport (already bound to the user_id baked into the signature) and the
 * raw arguments passed by the agent. The handler returns whatever shape the
 * underlying skill produces — the chatter's dispatch site (`handleAgentToolCall`
 * + `handleReadOnlyQuery`) is shape-agnostic.
 */
export type ProjectSkillHandler = (
  transport: AdsHmacTransport,
  input: unknown
) => Promise<unknown>;

/**
 * A project's manifest. Keys are the short skill names that appear in
 * `skill_allowlist`. Values are the handlers described above.
 */
export type SkillManifest = Record<string, ProjectSkillHandler>;

/**
 * A lazy loader for a project's manifest. The factory pattern avoids importing
 * every project's skill modules at registry-import time.
 */
export type ProjectSkillManifestLoader = () => SkillManifest;

const projectManifestRegistry = new Map<string, ProjectSkillManifestLoader>();

/**
 * Register a project's manifest loader. Called once per project at module
 * import time (see the `mumu2` entry below).
 */
export function registerProjectManifest(
  projectName: string,
  loader: ProjectSkillManifestLoader
): void {
  projectManifestRegistry.set(projectName, loader);
}

/**
 * Resolve a project's manifest. Returns `null` for unknown projects so callers
 * can fall back to "no project-scoped skills" rather than crash. Logging the
 * miss is the caller's responsibility (the loader doesn't know enough about
 * its caller's context to log meaningfully).
 */
export function getProjectManifest(projectName: string): SkillManifest | null {
  const loader = projectManifestRegistry.get(projectName);
  return loader ? loader() : null;
}

/**
 * Test-only escape hatch — drops every registered loader so a test can
 * register a fake manifest without leaking across files. Not exported through
 * the package barrel; importable only by relative path.
 */
export function __resetProjectManifestRegistryForTests(): void {
  projectManifestRegistry.clear();
}

// ---------------------------------------------------------------------------
// Default project registrations. Add new projects below; each must be a
// no-op import when the project isn't in use (no top-level side effects in
// the project's `skills/index.ts` beyond declaring the manifest).
// ---------------------------------------------------------------------------
registerProjectManifest("mumu2", () => mumu2SkillManifest);
