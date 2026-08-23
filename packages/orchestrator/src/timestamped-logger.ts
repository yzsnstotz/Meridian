import type { Logger } from "./roles/base-role";

type LogMethod = (...args: unknown[]) => void;

export interface LogSink {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

// Wrap a console-style sink so every log line begins with an ISO timestamp.
// The monitor's LogPatternCounter relies on a leading ISO date to honor its
// windowMs; without it, matches accumulate as zombies (see
// learnings/dispatcher/watchdog-scheduler-cleanup-kill-matcher-drift.md and
// the follow-up monitor false-positive that this fix addresses).
export function createTimestampedLogger(
  sink: LogSink,
  now: () => Date = () => new Date()
): Logger {
  const wrap = (method: keyof LogSink): LogMethod =>
    (...args: unknown[]) => sink[method](now().toISOString(), ...args);

  return {
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error")
  };
}
