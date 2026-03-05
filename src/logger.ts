import pino, { Logger } from "pino";

const NODE_ENV = process.env.NODE_ENV ?? "development";
const LOG_DIR = process.env.LOG_DIR ?? "/var/log/hub";

const baseConfig: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (NODE_ENV === "production" ? "info" : "debug"),
  messageKey: "msg",
  timestamp: () => `,\"timestamp\":\"${new Date().toISOString()}\"`,
  formatters: {
    level: (label) => ({ level: label })
  },
  base: { service: "calling-hub" }
};

const transport =
  NODE_ENV === "production"
    ? pino.transport({
        targets: [
          {
            target: "pino/file",
            options: { destination: `${LOG_DIR}/hub.log`, mkdir: true },
            level: "info"
          },
          {
            target: "pino/file",
            options: { destination: `${LOG_DIR}/hub-error.log`, mkdir: true },
            level: "error"
          }
        ]
      })
    : pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" }
      });

export const rootLogger = pino(baseConfig, transport);
const moduleLoggerCache = new Map<string, Logger>();

function createProductionModuleLogger(module: string): Logger {
  const cached = moduleLoggerCache.get(module);
  if (cached) {
    return cached;
  }

  const destinationByModule: Record<string, { destination: string; level: string }> = {
    interface: { destination: `${LOG_DIR}/interface.log`, level: "info" },
    instance_mgr: { destination: `${LOG_DIR}/instance.log`, level: "debug" },
    monitor: { destination: `${LOG_DIR}/monitor.log`, level: "info" }
  };

  const selected = destinationByModule[module];
  if (!selected) {
    return rootLogger;
  }

  const moduleLogger = pino(
    baseConfig,
    pino.transport({
      target: "pino/file",
      options: { destination: selected.destination, mkdir: true },
      level: selected.level
    })
  );
  moduleLoggerCache.set(module, moduleLogger);
  return moduleLogger;
}

export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  const base = NODE_ENV === "production" ? createProductionModuleLogger(module) : rootLogger;
  return base.child({ module, trace_id: null, thread_id: null, ...bindings });
}
