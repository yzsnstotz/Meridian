import { config } from "./config";
import { HubServer } from "./hub/server";
import { setCallerIdentity } from "./interface/ipc-sender";
import { createLogger } from "./logger";
import { startLogRetentionWorker } from "./log-retention";
import { deriveBuiltinCallerKey } from "./shared/caller-bootstrap";
import { WebInterfaceServer } from "./web/server";

const log = createLogger("runtime-supervised");
const hub = new HubServer();
const web = new WebInterfaceServer({
  enabled: true,
  listenHost: config.WEB_GUI_HOST || "127.0.0.1",
  port: config.WEB_GUI_PORT,
  token: config.WEB_GUI_TOKEN
});
const retention = startLogRetentionWorker({
  enabled: config.LOG_RETENTION_ENABLED,
  intervalMs: config.LOG_RETENTION_INTERVAL_MS,
  logDir: config.LOG_DIR,
  activeFileMaxBytes: config.LOG_ACTIVE_FILE_MAX_BYTES,
  activeFileKeepBytes: config.LOG_ACTIVE_FILE_KEEP_BYTES,
  sessionFileMaxBytes: config.LOG_SESSION_FILE_MAX_BYTES,
  sessionFileKeepBytes: config.LOG_SESSION_FILE_KEEP_BYTES,
  sessionFileMaxAgeHours: config.LOG_SESSION_FILE_MAX_AGE_HOURS,
  logger: log
});

let stopping = false;

async function start(): Promise<void> {
  await hub.start();
  const callerId = "meridian-web";
  setCallerIdentity({
    caller_id: callerId,
    caller_key: deriveBuiltinCallerKey(callerId),
    caller_label: "Meridian Web"
  });
  await web.start();
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  log.info({ signal }, "Stopping supervised Runtime");
  retention.stop();
  await Promise.allSettled([web.stop(), hub.stop()]);
}

process.once("SIGINT", () => {
  void stop("SIGINT").finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop("SIGTERM").finally(() => process.exit(0));
});

void start().catch((error) => {
  log.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    "Supervised Runtime failed to start"
  );
  void stop("SIGTERM").finally(() => process.exit(1));
});
