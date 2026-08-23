import { config } from "../config";
import { createLogger } from "../logger";
import { startLogRetentionWorker } from "../log-retention";
import { HubServer } from "./server";

const hubLog = createLogger("hub");
const hubServer = new HubServer();
const logRetentionWorker = startLogRetentionWorker({
  enabled: config.LOG_RETENTION_ENABLED,
  intervalMs: config.LOG_RETENTION_INTERVAL_MS,
  logDir: config.LOG_DIR,
  activeFileMaxBytes: config.LOG_ACTIVE_FILE_MAX_BYTES,
  activeFileKeepBytes: config.LOG_ACTIVE_FILE_KEEP_BYTES,
  sessionFileMaxBytes: config.LOG_SESSION_FILE_MAX_BYTES,
  sessionFileKeepBytes: config.LOG_SESSION_FILE_KEEP_BYTES,
  sessionFileMaxAgeHours: config.LOG_SESSION_FILE_MAX_AGE_HOURS,
  logger: hubLog
});

async function start(): Promise<void> {
  await hubServer.start();
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  hubLog.info({ trace_id: null, thread_id: null, signal }, "Received shutdown signal");
  try {
    logRetentionWorker.stop();
    await hubServer.stop();
    process.exit(0);
  } catch (error) {
    hubLog.error(
      { trace_id: null, thread_id: null, err: error instanceof Error ? error.message : String(error) },
      "Failed to stop hub server cleanly"
    );
    process.exit(1);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start().catch((error) => {
  hubLog.fatal(
    { trace_id: null, thread_id: null, err: error instanceof Error ? error.message : String(error) },
    "Failed to start hub server"
  );
  process.exit(1);
});
