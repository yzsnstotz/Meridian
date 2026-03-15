import pino, { Logger } from "pino";

function resolveNodeEnv(): string {
  return process.env.NODE_ENV ?? "development";
}

function isNodeTestRuntime(): boolean {
  return process.argv.some((arg) => arg === "--test" || arg.startsWith("--test-"));
}

function resolveLogDir(): string {
  return process.env.LOG_DIR ?? "/var/log/hub";
}

function buildBaseConfig(): pino.LoggerOptions {
  const nodeEnv = resolveNodeEnv();
  return {
    level: process.env.LOG_LEVEL ?? (nodeEnv === "production" ? "info" : "debug"),
    messageKey: "msg",
    timestamp: () => `,\"timestamp\":\"${new Date().toISOString()}\"`,
    formatters: {
      level: (label) => ({ level: label })
    },
    base: { service: "calling-hub" }
  };
}

function buildTransport() {
  const nodeEnv = resolveNodeEnv();
  const logDir = resolveLogDir();
  if (isNodeTestRuntime()) {
    return undefined;
  }
  return nodeEnv === "production"
    ? pino.transport({
        targets: [
          {
            target: "pino/file",
            options: { destination: `${logDir}/hub.log`, mkdir: true },
            level: "info"
          },
          {
            target: "pino/file",
            options: { destination: `${logDir}/hub-error.log`, mkdir: true },
            level: "error"
          }
        ]
      })
    : pino.transport({
        targets: [
          {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard" }
          }
        ]
      });
}

let rootLoggerInstance: Logger | null = null;

export function getRootLogger(): Logger {
  if (!rootLoggerInstance) {
    const transport = buildTransport();
    rootLoggerInstance = transport ? pino(buildBaseConfig(), transport) : pino(buildBaseConfig());
  }
  return rootLoggerInstance;
}

const moduleLoggerCache = new Map<string, Logger>();

function createProductionModuleLogger(module: string): Logger {
  const cached = moduleLoggerCache.get(module);
  if (cached) {
    return cached;
  }

  const destinationByModule: Record<string, { destination: string; level: string }> = {
    interface: { destination: `${resolveLogDir()}/interface.log`, level: "info" },
    instance_mgr: { destination: `${resolveLogDir()}/instance.log`, level: "debug" },
    monitor: { destination: `${resolveLogDir()}/monitor.log`, level: "info" }
  };

  const selected = destinationByModule[module];
  if (!selected) {
    return getRootLogger();
  }

  const moduleLogger = pino(
    buildBaseConfig(),
    isNodeTestRuntime()
      ? undefined
      : pino.transport({
          target: "pino/file",
          options: { destination: selected.destination, mkdir: true },
          level: selected.level
        })
  );
  moduleLoggerCache.set(module, moduleLogger);
  return moduleLogger;
}

export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  const base = resolveNodeEnv() === "production" ? createProductionModuleLogger(module) : getRootLogger();
  return base.child({ module, trace_id: null, thread_id: null, ...bindings });
}
