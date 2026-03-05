import { config } from "../config";
import { MonitorIpcReporter } from "./ipc-reporter";
import { getMonitorLogger } from "./logger";
import { MonitorManager } from "./monitor";

const monitorLog = getMonitorLogger();

export function createMonitorManager(): MonitorManager {
  const reporter = new MonitorIpcReporter({
    socketPath: config.HUB_SOCKET_PATH
  });

  return new MonitorManager({
    reporter,
    heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
    heartbeatMissedThreshold: config.HEARTBEAT_MISSED_THRESHOLD
  });
}

export async function startMonitorService(): Promise<void> {
  const manager = createMonitorManager();
  const keepAlive = setInterval(() => undefined, 60_000);

  const shutdown = (signal: NodeJS.Signals): void => {
    clearInterval(keepAlive);
    manager.shutdown();
    monitorLog.info({ trace_id: null, thread_id: null, signal }, "Monitor service stopped");
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  monitorLog.info(
    {
      trace_id: null,
      thread_id: null,
      heartbeat_interval_ms: config.HEARTBEAT_INTERVAL_MS,
      heartbeat_missed_threshold: config.HEARTBEAT_MISSED_THRESHOLD
    },
    "Monitor service started"
  );
}

if (require.main === module) {
  void startMonitorService();
}
