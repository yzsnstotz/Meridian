import { createLogger } from "../logger";
import { HubServer } from "./server";

const hubLog = createLogger("hub");
const hubServer = new HubServer();

async function start(): Promise<void> {
  await hubServer.start();
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  hubLog.info({ trace_id: null, thread_id: null, signal }, "Received shutdown signal");
  try {
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
