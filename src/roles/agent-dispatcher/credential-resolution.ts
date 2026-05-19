import type { AgentDispatcherConfig } from "../../types";

export type SpawnPurpose = "main" | "validator" | "pm_resolver";

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
  config: AgentDispatcherConfig
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
