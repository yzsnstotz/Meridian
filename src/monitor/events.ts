import { z } from "zod";

export const MonitorEventTypeSchema = z.enum([
  "task_completed",
  "status_changed",
  "heartbeat_missed",
  "agent_error",
  "sse_reconnect_failed"
]);
export type MonitorEventType = z.infer<typeof MonitorEventTypeSchema>;

export const MonitorModeSchema = z.enum(["sse_hook", "heartbeat"]);
export type MonitorMode = z.infer<typeof MonitorModeSchema>;

export const MonitorEventSchema = z.object({
  trace_id: z.string().uuid().nullable().default(null),
  thread_id: z.string().min(1),
  event_type: MonitorEventTypeSchema,
  monitor_mode: MonitorModeSchema,
  timestamp: z.string().datetime(),
  agent_status: z.string().optional(),
  missed_heartbeats: z.number().int().nonnegative().optional(),
  sse_reconnect_count: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional()
});
export type MonitorEvent = z.infer<typeof MonitorEventSchema>;
