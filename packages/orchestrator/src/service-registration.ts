import fs from "node:fs";
import path from "node:path";

import {
  RuntimeServiceRegistration,
  ServiceDeclarationSchema,
  type RuntimeInstanceDescriptor,
  type ServiceDeclaration
} from "@meridian/contracts";

import { orchestratorPaths } from "./config";

export interface OrchestratorRegistrationOptions {
  httpEndpoint: string;
  a2aEndpoint?: string;
  instanceId?: string;
  pid?: number;
  leaseDurationMs?: number;
}

export function loadOrchestratorServiceDeclaration(): ServiceDeclaration {
  return ServiceDeclarationSchema.parse(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../service.json"), "utf8"))
  );
}

export function createOrchestratorServiceRegistration(
  options: OrchestratorRegistrationOptions
): RuntimeServiceRegistration {
  const transports: RuntimeInstanceDescriptor["transports"] = [
    {
      kind: "http",
      endpoint: options.httpEndpoint,
      features: ["streaming", "cancellation", "provider_acknowledgement"]
    },
    ...(options.a2aEndpoint
      ? [{
          kind: "a2a" as const,
          endpoint: options.a2aEndpoint,
          features: ["streaming", "cancellation", "provider_acknowledgement"] as Array<
            "streaming" | "cancellation" | "provider_acknowledgement"
          >
        }]
      : [])
  ];
  return new RuntimeServiceRegistration({
    declaration: loadOrchestratorServiceDeclaration(),
    declarationDir: orchestratorPaths.serviceDeclarationDir,
    descriptorDir: orchestratorPaths.runtimeDescriptorDir,
    instanceId: options.instanceId,
    pid: options.pid,
    leaseDurationMs: options.leaseDurationMs,
    transports
  });
}

export function publishOrchestratorRegistration(
  registration: RuntimeServiceRegistration,
  health: RuntimeInstanceDescriptor["health"]["state"]
): RuntimeInstanceDescriptor {
  return registration.publish(health);
}
