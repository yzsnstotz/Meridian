import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { AgentInstanceSchema, type AgentInstance } from "../types";

const PersistedHubStateSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().datetime(),
  instances: z.array(AgentInstanceSchema).default([]),
  session_bindings: z.record(z.string(), z.string().min(1)).default({})
});

export type PersistedHubState = z.infer<typeof PersistedHubStateSchema>;

export function buildEmptyPersistedHubState(nowIso: string): PersistedHubState {
  return {
    version: 1,
    updated_at: nowIso,
    instances: [],
    session_bindings: {}
  };
}

export function buildPersistedHubState(
  nowIso: string,
  instances: AgentInstance[],
  sessionBindings: Record<string, string>
): PersistedHubState {
  return PersistedHubStateSchema.parse({
    version: 1,
    updated_at: nowIso,
    instances,
    session_bindings: sessionBindings
  });
}

export function loadPersistedHubState(statePath: string, nowIso: string): PersistedHubState {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return PersistedHubStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return buildEmptyPersistedHubState(nowIso);
    }
    return buildEmptyPersistedHubState(nowIso);
  }
}

export function savePersistedHubState(statePath: string, state: PersistedHubState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, statePath);
}
