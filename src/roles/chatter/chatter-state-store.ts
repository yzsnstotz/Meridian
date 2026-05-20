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

export const ChatterProvisionErrorSchema = z.object({
  ts: z.string().datetime(),
  code: z.string().min(1),
  message: z.string().min(1)
});
export type ChatterProvisionError = z.infer<typeof ChatterProvisionErrorSchema>;

export const ChatterTurnErrorSchema = z.object({
  ts: z.string().datetime(),
  trace_id: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1)
});
export type ChatterTurnError = z.infer<typeof ChatterTurnErrorSchema>;

export const ChatterTriggerThrottleStateSchema = z.object({
  records_since_last_fire: z.number().int().min(0),
  last_fire_at: z.string().datetime().nullable()
});
export type ChatterTriggerThrottleState = z.infer<typeof ChatterTriggerThrottleStateSchema>;

export const ChatterPersistedStateSchema = z.object({
  version: z.literal(1),
  agent_session_id: z.string().min(1).nullable().default(null),
  in_flight_traces: z.array(ChatterInFlightTraceSchema).default([]),
  last_provision_error: ChatterProvisionErrorSchema.optional(),
  last_turn_error: ChatterTurnErrorSchema.optional(),
  trigger_state: z.record(z.string().min(1), ChatterTriggerThrottleStateSchema).optional()
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

  recordProvisionError(code: string, error: unknown): void {
    this.save({
      ...this.load(),
      last_provision_error: {
        ts: new Date().toISOString(),
        code,
        message: sanitizeChatterErrorMessage(error)
      }
    });
  }

  clearProvisionError(): void {
    const { last_provision_error: _lastProvisionError, ...state } = this.load();
    this.save(state);
  }

  recordTurnError(traceId: string, code: string, error: unknown): void {
    this.save({
      ...this.load(),
      last_turn_error: {
        ts: new Date().toISOString(),
        trace_id: traceId,
        code,
        message: sanitizeChatterErrorMessage(error)
      }
    });
  }

  clearTurnError(): void {
    const { last_turn_error: _lastTurnError, ...state } = this.load();
    this.save(state);
  }

  getTriggerThrottleState(triggerName: string): ChatterTriggerThrottleState {
    return this.load().trigger_state?.[triggerName] ?? {
      records_since_last_fire: 0,
      last_fire_at: null
    };
  }

  incrementTriggerRecord(triggerName: string): ChatterTriggerThrottleState {
    const state = this.load();
    const current = state.trigger_state?.[triggerName] ?? {
      records_since_last_fire: 0,
      last_fire_at: null
    };
    const next: ChatterTriggerThrottleState = {
      ...current,
      records_since_last_fire: current.records_since_last_fire + 1
    };
    this.save({
      ...state,
      trigger_state: {
        ...state.trigger_state,
        [triggerName]: next
      }
    });
    return next;
  }

  markTriggerFired(triggerName: string, firedAt: string): ChatterTriggerThrottleState {
    const state = this.load();
    const next: ChatterTriggerThrottleState = {
      records_since_last_fire: 0,
      last_fire_at: firedAt
    };
    this.save({
      ...state,
      trigger_state: {
        ...state.trigger_state,
        [triggerName]: next
      }
    });
    return next;
  }
}

export function sanitizeChatterErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() || "unknown_error";
  return firstLine
    .replace(/\/(?:Users|private|var|tmp|Volumes|home)\/[^\s"'`]+/g, "[path]")
    .slice(0, 500);
}
