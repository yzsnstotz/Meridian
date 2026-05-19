import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ChatterInFlightTraceSchema = z.object({
  trace_id: z.string().min(1),
  // "spawn" — outbound intent:"spawn" awaiting the new agent thread_id.
  // "agent_turn" — outbound intent:"run" to the bound agent thread.
  // "job_dispatch" — outbound intent:"run" to agent-dispatcher for a coding job.
  purpose: z.enum(["spawn", "agent_turn", "job_dispatch"]),
  agent_session_id: z.string().min(1).nullable().default(null),
  registered_at: z.string().datetime()
});
export type ChatterInFlightTrace = z.infer<typeof ChatterInFlightTraceSchema>;

export const ChatterPersistedStateSchema = z.object({
  version: z.literal(1),
  agent_session_id: z.string().min(1).nullable().default(null),
  in_flight_traces: z.array(ChatterInFlightTraceSchema).default([])
});
export type ChatterPersistedState = z.infer<typeof ChatterPersistedStateSchema>;

export const EMPTY_CHATTER_STATE: ChatterPersistedState = {
  version: 1,
  agent_session_id: null,
  in_flight_traces: []
};

export class ChatterStateStore {
  readonly stateDir: string;
  readonly stateFile: string;

  constructor(memoryFolder: string) {
    this.stateDir = path.join(memoryFolder, ".chatter-state");
    this.stateFile = path.join(this.stateDir, "state.json");
  }

  load(): ChatterPersistedState {
    if (!existsSync(this.stateFile)) return { ...EMPTY_CHATTER_STATE };
    const raw = readFileSync(this.stateFile, "utf8");
    return ChatterPersistedStateSchema.parse(JSON.parse(raw));
  }

  save(state: ChatterPersistedState): void {
    const validated = ChatterPersistedStateSchema.parse(state);
    mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`);
      renameSync(tmp, this.stateFile);
    } catch (e) {
      if (existsSync(tmp)) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
      }
      throw e;
    }
  }
}
