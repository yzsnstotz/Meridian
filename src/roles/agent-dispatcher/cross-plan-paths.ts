import { AgentDispatcherConfigSchema, AppStateSchema, type AppState } from "../../types";
import { parseNormalizedAgentDispatcherConfig } from "./config-normalization";

export interface StateStoreLike {
  load(): Promise<unknown>;
}

/**
 * Resolves `dispatch_plan_path`s of *other* persisted agent-dispatcher roles.
 * Callers exclude their own role via `selfThreadId`.
 *
 * Used by `LaunchConfig.otherDispatchPlanPaths` / `LaunchDispatchWorkerConfig
 * .otherDispatchPlanPaths` / `ValidatorOrchestratorDeps.otherDispatchPlanPaths`
 * to refuse a spawn whose returned `thread_id` is already reserved in another
 * dispatcher role's lifecycle sidecar. After a Meridian Hub restart the
 * allocator can wrap back to low ids and hand the same `codex_NN` to a fresh
 * spawn while another role still pins it on disk; without cross-plan
 * reservation, two plans' lifecycle sidecars converge on one Hub thread.
 *
 * Fails open (returns `[]`) on any read/parse error — a corrupt or missing
 * sidecar must never block a fresh launch. Per-role config parse errors are
 * skipped silently so one malformed entry cannot pin out every spawn.
 */
export async function resolveOtherDispatcherPlanPaths(
  stateStore: StateStoreLike,
  selfThreadId: string
): Promise<string[]> {
  let raw: unknown;
  try {
    raw = await stateStore.load();
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  let parsed: AppState;
  try {
    parsed = AppStateSchema.parse(raw);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const role of parsed.roles) {
    if (role.roleType !== "agent-dispatcher") {
      continue;
    }
    if (role.threadId === selfThreadId) {
      continue;
    }
    try {
      const cfg =
        parseNormalizedAgentDispatcherConfig(role.config, { threadId: role.threadId })
        ?? AgentDispatcherConfigSchema.parse(role.config);
      const planPath = cfg.dispatch_plan_path?.trim();
      if (planPath) {
        paths.push(planPath);
      }
    } catch {
      // Skip unparseable persisted role config — one malformed entry must not
      // pin out every fresh spawn.
    }
  }
  return paths;
}
