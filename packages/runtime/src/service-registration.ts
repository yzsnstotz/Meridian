import fs from "node:fs";
import path from "node:path";

import {
  RuntimeServiceRegistration,
  ServiceDeclarationSchema,
  type RuntimeInstanceDescriptor,
  type ServiceDeclaration
} from "@meridian/contracts";

import { runtimePaths } from "./config";

export interface RuntimeRegistrationOptions {
  httpEndpoint: string;
  instanceId?: string;
  pid?: number;
  leaseDurationMs?: number;
}

export function loadRuntimeServiceDeclaration(): ServiceDeclaration {
  return ServiceDeclarationSchema.parse(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../service.json"), "utf8"))
  );
}

export function createRuntimeServiceRegistration(
  options: RuntimeRegistrationOptions
): RuntimeServiceRegistration {
  return new RuntimeServiceRegistration({
    declaration: loadRuntimeServiceDeclaration(),
    declarationDir: runtimePaths.serviceDeclarationDir,
    descriptorDir: runtimePaths.runtimeDescriptorDir,
    instanceId: options.instanceId,
    pid: options.pid,
    leaseDurationMs: options.leaseDurationMs,
    transports: [
      {
        kind: "http",
        endpoint: options.httpEndpoint,
        features: ["streaming", "cancellation", "provider_acknowledgement"]
      }
    ]
  });
}

export function publishRuntimeRegistration(
  registration: RuntimeServiceRegistration,
  health: RuntimeInstanceDescriptor["health"]["state"]
): RuntimeInstanceDescriptor {
  return registration.publish(health);
}
