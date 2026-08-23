import net from "node:net";

import {
  discoverServices,
  resolveMeridianPaths,
  resolveService,
  type PathResolverOptions,
  type ServiceDiscoveryOptions,
  type ServiceDiscoveryReport,
  type DiscoveredService
} from "@meridian/contracts";

export interface ServiceCommandOptions {
  env?: NodeJS.ProcessEnv;
  pathOptions?: PathResolverOptions;
  discovery?: Partial<Pick<ServiceDiscoveryOptions, "now" | "isProcessAlive" | "probeHealth">>;
  compatibilityProbes?: Record<string, Array<() => Promise<string | undefined>>>;
}

export async function runServiceCommand(
  args: string[],
  options: ServiceCommandOptions = {}
): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = args;
  const report = await discoverDefaultServices(options);
  switch (subcommand) {
    case "list":
      requireNoArguments(rest, "service list");
      return {
        ok: true,
        services: report.services,
        quarantined: report.quarantined
      };
    case "describe":
      return describeService(rest, report);
    case "resolve":
      return resolveServiceCommand(rest, report, options);
    case "doctor":
      requireNoArguments(rest, "service doctor");
      return {
        ok: report.quarantined.length === 0,
        serviceCount: report.services.length,
        quarantineCount: report.quarantined.length,
        services: report.services,
        quarantined: report.quarantined
      };
    default:
      throw new Error("service requires one of: list, resolve, describe, doctor");
  }
}

async function discoverDefaultServices(options: ServiceCommandOptions): Promise<ServiceDiscoveryReport> {
  const env = options.env ?? process.env;
  const paths = resolveMeridianPaths({
    ...(options.pathOptions ?? {}),
    env: options.pathOptions?.env ?? env
  });
  const clawsoDeclarationDir = env.CLAWSO_SERVICE_DECLARATION_DIR?.trim();
  const clawsoDescriptorDir = env.CLAWSO_RUNTIME_DESCRIPTOR_DIR?.trim();
  return discoverServices({
    declarationDirs: [
      paths.serviceDeclarationDir,
      ...(clawsoDeclarationDir ? [clawsoDeclarationDir] : [])
    ],
    descriptorDirs: [
      { path: paths.runtimeDescriptorDir, source: "native" },
      ...(clawsoDescriptorDir
        ? [{ path: clawsoDescriptorDir, source: "clawso" as const }]
        : [])
    ],
    probeHealth: options.discovery?.probeHealth ?? probeDiscoveredService,
    now: options.discovery?.now,
    isProcessAlive: options.discovery?.isProcessAlive
  });
}

function describeService(args: string[], report: ServiceDiscoveryReport): Record<string, unknown> {
  if (args.length !== 1 || !args[0]?.trim()) {
    throw new Error("service describe requires exactly one provider or instance id");
  }
  const id = args[0].trim();
  const matches = report.services.filter((service) =>
    service.instanceId === id
    || service.providerId === id
    || service.declarationId === id
  );
  if (matches.length === 0) {
    throw new Error(`service not found: ${id}`);
  }
  return {
    ok: true,
    services: matches
  };
}

async function resolveServiceCommand(
  args: string[],
  report: ServiceDiscoveryReport,
  options: ServiceCommandOptions
): Promise<Record<string, unknown>> {
  const parsed = parseResolveArguments(args);
  const resolved = await resolveService({
    serviceId: parsed.serviceId,
    explicitUrl: parsed.url,
    selectedInstanceId: parsed.instanceId,
    env: options.env ?? process.env,
    services: report.services,
    compatibilityProbes: options.compatibilityProbes?.[parsed.serviceId]
      ?? defaultCompatibilityProbes(parsed.serviceId, options.env ?? process.env)
  });
  return {
    ok: true,
    resolved
  };
}

function parseResolveArguments(args: string[]): {
  serviceId: string;
  url?: string;
  instanceId?: string;
} {
  const serviceId = args[0]?.trim();
  if (!serviceId || serviceId.startsWith("--")) {
    throw new Error("service resolve requires a provider, declaration, or capability id");
  }
  let url: string | undefined;
  let instanceId: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1]?.trim();
    if ((option === "--url" || option === "--instance") && value && !value.startsWith("--")) {
      if (option === "--url") {
        url = value;
      } else {
        instanceId = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unsupported service resolve argument: ${option ?? ""}`);
  }
  return { serviceId, url, instanceId };
}

function defaultCompatibilityProbes(
  serviceId: string,
  env: NodeJS.ProcessEnv
): Array<() => Promise<string | undefined>> {
  if (serviceId === "org.meridian/runtime") {
    const endpoint = env.MERIDIAN_HTTP?.trim() || "http://127.0.0.1:3000";
    return [() => probeHttpEndpoint(endpoint)];
  }
  if (serviceId === "org.meridian/orchestrator") {
    const endpoint = env.MERIDIAN_ORCHESTRATOR_HTTP?.trim() || "http://127.0.0.1:7701";
    return [() => probeHttpEndpoint(endpoint)];
  }
  return [];
}

async function probeHttpEndpoint(endpoint: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/api/health", endpoint), {
      signal: AbortSignal.timeout(1_000)
    });
    return response.ok ? new URL(endpoint).toString() : undefined;
  } catch {
    return undefined;
  }
}

async function probeDiscoveredService(service: DiscoveredService): Promise<boolean> {
  const httpTransport = service.transports.find((transport) => transport.kind === "http");
  if (httpTransport) {
    try {
      const response = await fetch(new URL("/api/health", httpTransport.endpoint), {
        signal: AbortSignal.timeout(1_000)
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }
  const socketTransport = service.transports.find((transport) =>
    transport.kind === "a2a" || transport.kind === "acp" || transport.kind === "mcp"
  );
  if (!socketTransport) {
    return service.transports.some((transport) => transport.kind === "cli");
  }
  return probeSocket(socketTransport.endpoint);
}

function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function requireNoArguments(args: string[], command: string): void {
  if (args.length > 0) {
    throw new Error(`${command} does not accept arguments`);
  }
}
