/**
 * Project-scoped skill loader.
 *
 * Threads a project's `SkillManifest` (typically returned by
 * `getProjectManifest(projectName)`) into the chatter role's `skillHandlers`
 * Map, gated by the project's `skill_allowlist`. Each handler resolves a
 * fresh per-user `AdsHmacTransport` from the supplied `transportFactory`
 * at INVOKE time — not at registration time — so a transport that happens
 * to be re-bound between invocations (e.g. across a chatter re-activation)
 * is picked up without re-registering handlers.
 *
 * Naming contract: the chatter dispatch site (`handleAgentToolCall`) looks
 * skills up in `skillHandlers` by the FULL agent-facing tool name (e.g.
 * `chatter.skill.fetch_dna_template`), while the allowlist + manifest use
 * the short name (`fetch_dna_template`). This loader bridges the gap by
 * registering under the prefixed key `chatter.skill.<short>` — the same
 * prefix `assertSkillAllowed` strips on the way in.
 *
 * Security boundary: the allowlist is enforced at registration time HERE
 * (so a skill not in the allowlist is never even reachable through the
 * dispatch Map), AND a second time at dispatch time in
 * `ChatterRole.handleAgentToolCall` via `assertSkillAllowed`. Defense in
 * depth — either layer alone is a hard wall, but both together protect
 * against (a) a manifest entry leaking through without a config update and
 * (b) a config update leaking through without a manifest update.
 *
 * Name collisions: when a registered key collides with a name already
 * present in the map (e.g. a `structured.*` skill registered earlier in
 * `onActivate`, or another project's prior registration), the FIRST
 * registration wins. The colliding entry is dropped with a warning.
 * Rationale: structured.* is a built-in invariant; a project-scoped manifest
 * accidentally shadowing it would silently change write semantics for that
 * user, which is much worse than the skill not being callable at all.
 *
 * Allowlist names not present in the manifest: logged at warn level + skipped.
 * Reflects an operator config drift (allowlist references a skill the
 * project doesn't define) but is not fatal — other allowlisted skills
 * still register.
 */

/**
 * Prefix the chatter expects on project-scoped skill names at dispatch
 * time. Must stay in sync with `src/roles/chatter/allowlist.ts`'s
 * `SKILL_PREFIX`. Duplicated here as a constant (rather than imported) to
 * keep the loader's contract self-documenting and avoid a circular import
 * through the chatter package.
 */
export const PROJECT_SKILL_DISPATCH_PREFIX = "chatter.skill.";

import type { AdsHmacTransport } from "../../../../transport/ads-hmac";
import type { Logger } from "../../../base-role";
import type { SkillManifest } from "../../../../projects/registry";

export type SkillDispatchHandler = (args: unknown) => Promise<unknown>;

export interface RegisterProjectSkillsOptions {
  /** Project key (e.g. "mumu2") — used purely for log diagnostics. */
  projectName: string;
  /** The per-project skill allowlist (from `config/projects/<project>.json`). */
  allowlist: readonly string[];
  /**
   * Manifest of skill name → handler. Usually obtained via
   * `getProjectManifest(projectName)`; passed explicitly here so tests can
   * inject fakes without touching the global registry.
   */
  manifest: SkillManifest;
  /**
   * Per-call transport factory. Resolved once per invocation so the user_id
   * baked into the HMAC signature stays current. The factory must return a
   * transport already bound to the right user_id — the loader does not know
   * (and must not know) user identity.
   */
  transportFactory: () => AdsHmacTransport;
  /** Standard chatter-role logger (`ctx.log`). */
  log: Logger;
}

export function registerProjectSkills(
  skills: Map<string, SkillDispatchHandler>,
  options: RegisterProjectSkillsOptions
): void {
  const { projectName, allowlist, manifest, transportFactory, log } = options;

  for (const skillName of allowlist) {
    const handler = manifest[skillName];
    if (!handler) {
      log.warn("project-skills: allowlisted skill missing from manifest", {
        project: projectName,
        skill: skillName
      });
      continue;
    }

    const dispatchKey = `${PROJECT_SKILL_DISPATCH_PREFIX}${skillName}`;
    if (skills.has(dispatchKey)) {
      log.warn("project-skills: skill name collides with an already-registered handler; keeping existing", {
        project: projectName,
        skill: skillName,
        dispatch_key: dispatchKey
      });
      continue;
    }

    skills.set(dispatchKey, async (args) => {
      const transport = transportFactory();
      return handler(transport, args);
    });
  }
}
