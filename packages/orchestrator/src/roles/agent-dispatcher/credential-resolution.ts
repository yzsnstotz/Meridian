import type { AgentDispatcherConfig } from "../../types";

export type SpawnPurpose = "main" | "validator" | "pm_resolver";

/**
 * Structural view of the dispatcher config used by credential resolution.
 * Kept narrower than {@link AgentDispatcherConfig} so callers holding only
 * the relevant slice (e.g. `continue-worker.ts`'s `ContinueWorkerConfig`)
 * can pass through without depending on every dispatcher field.
 */
export interface CredentialInheritanceView {
  credential_id?: AgentDispatcherConfig["credential_id"];
  validator?: { credential_id?: string } | undefined;
  pm_resolver?: { credential_id?: string } | undefined;
}

/**
 * Resolve the opaque credential_id to send on a spawn intent for a given
 * sub-spawn purpose, applying inheritance from the top-level dispatcher
 * config when the sub-config has not set its own override.
 *
 * Returns `undefined` when nothing is configured at either level — the hub
 * will then fall back to the default credential (e.g. `~/.codex`).
 */
export function resolveCredentialForSpawn(
  purpose: SpawnPurpose,
  config: CredentialInheritanceView
): string | undefined {
  switch (purpose) {
    case "main":
      return config.credential_id;
    case "validator":
      return config.validator?.credential_id ?? config.credential_id;
    case "pm_resolver":
      return config.pm_resolver?.credential_id ?? config.credential_id;
  }
}
