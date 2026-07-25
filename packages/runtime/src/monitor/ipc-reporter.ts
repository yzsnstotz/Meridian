import { config } from "../config";
import { sendIpcMessage } from "../shared/ipc";
import { MonitorEventSchema, type MonitorEvent } from "./events";
import { getMonitorLogger } from "./logger";

export interface MonitorIpcReporterOptions {
  socketPath?: string;
  maxRetryAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class MonitorIpcReporter {
  private readonly log = getMonitorLogger();
  private readonly socketPath: string;
  private readonly maxRetryAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: MonitorIpcReporterOptions = {}) {
    this.socketPath = options.socketPath ?? config.HUB_SOCKET_PATH;
    this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  }

  async report(event: MonitorEvent): Promise<void> {
    const payload = MonitorEventSchema.parse(event);

    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt += 1) {
      try {
        await sendIpcMessage(this.socketPath, payload);
        this.log.debug(
          {
            trace_id: payload.trace_id,
            thread_id: payload.thread_id,
            event_type: payload.event_type,
            monitor_mode: payload.monitor_mode,
            socket_path: this.socketPath
          },
          "Monitor event reported to hub"
        );
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isLastAttempt = attempt >= this.maxRetryAttempts;
        const retryDelayMs = Math.min(
          this.baseRetryDelayMs * 2 ** (attempt - 1),
          this.maxRetryDelayMs
        );

        this.log.error(
          {
            trace_id: payload.trace_id,
            thread_id: payload.thread_id,
            event_type: payload.event_type,
            monitor_mode: payload.monitor_mode,
            socket_path: this.socketPath,
            report_attempt: attempt,
            max_attempts: this.maxRetryAttempts,
            retry_delay_ms: isLastAttempt ? 0 : retryDelayMs,
            err: errorMessage
          },
          "Failed to report monitor event"
        );

        if (isLastAttempt) {
          throw new Error(
            `Failed to report monitor event after ${this.maxRetryAttempts} attempts: ${errorMessage}`
          );
        }

        await delay(retryDelayMs);
      }
    }
  }
}
