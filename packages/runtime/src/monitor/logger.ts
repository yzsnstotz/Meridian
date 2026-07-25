import pino, { type Logger } from "pino";

import { config } from "../config";
import { createLogger } from "../logger";

let cachedMonitorLogger: Logger | null = null;

export function getMonitorLogger(): Logger {
  if (cachedMonitorLogger) {
    return cachedMonitorLogger;
  }

  if (config.NODE_ENV === "production") {
    cachedMonitorLogger = pino(
      {
        level: config.LOG_LEVEL,
        messageKey: "msg",
        timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
        formatters: {
          level: (label) => ({ level: label })
        },
        base: {
          service: "calling-hub",
          module: "monitor",
          trace_id: null,
          thread_id: null
        }
      },
      pino.destination({
        dest: `${config.LOG_DIR}/monitor.log`,
        mkdir: true,
        sync: false
      })
    );
    return cachedMonitorLogger;
  }

  cachedMonitorLogger = createLogger("monitor");
  return cachedMonitorLogger;
}
