import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

export const SERVICE_DECLARATION_SCHEMA_URL = "https://clawso.ai/schemas/service/v1.json" as const;
export const RUNTIME_INSTANCE_SCHEMA_URL = "https://clawso.ai/schemas/service-instance/v1.json" as const;

const StableIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const SemverSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TransportKindSchema = z.enum(["mcp", "a2a", "acp", "http", "cli"]);
const TransportFeatureSchema = z.enum([
  "streaming",
  "cancellation",
  "provider_acknowledgement"
]);

export const AssetRefSchema = z.strictObject({
  assetClass: z.enum(["tool", "agent", "automation"]),
  assetId: StableIdSchema,
  assetVersion: SemverSchema
});

export const OperationContractSchema = z.strictObject({
  id: StableIdSchema,
  contractVersion: SemverSchema,
  inputSchemaRef: z.string().min(1),
  outputSchemaRef: z.string().min(1),
  effect: z.enum(["read", "write", "destructive"]),
  idempotency: z.enum(["required", "supported", "none"]),
  executionMode: z.enum(["sync", "async"]),
  streaming: z.boolean(),
  cancellable: z.boolean(),
  requiredPermissions: z.array(z.string().min(1)).refine(uniqueValues, "permissions must be unique"),
  workspaceMode: z.enum(["none", "read", "write", "full"]),
  transportRequirements: z.strictObject({
    allowedTransports: z.array(TransportKindSchema).min(1).refine(uniqueValues, "transports must be unique"),
    requiredFeatures: z.array(TransportFeatureSchema).refine(uniqueValues, "features must be unique")
  })
});

export const ServiceDeclarationSchema = z.strictObject({
  $schema: z.literal(SERVICE_DECLARATION_SCHEMA_URL),
  schemaVersion: z.literal("1"),
  declarationId: StableIdSchema,
  declarationVersion: SemverSchema,
  assetRef: AssetRefSchema,
  providerId: StableIdSchema,
  serviceCapabilities: z.array(z.strictObject({
    id: StableIdSchema,
    version: SemverSchema
  })).min(1).refine(uniqueObjects, "capabilities must be unique"),
  operations: z.array(OperationContractSchema).min(1)
});

export const RuntimeInstanceDescriptorSchema = z.strictObject({
  $schema: z.literal(RUNTIME_INSTANCE_SCHEMA_URL),
  schemaVersion: z.literal("1"),
  instanceId: StableIdSchema,
  providerId: StableIdSchema,
  declarationId: StableIdSchema,
  declarationVersion: SemverSchema,
  declarationDigest: Sha256Schema,
  assetRef: AssetRefSchema,
  ownership: z.enum(["clawso-managed", "native-unmanaged"]),
  installReceiptId: StableIdSchema.optional(),
  pid: z.number().int().min(1),
  lease: z.strictObject({
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime()
  }),
  transports: z.array(z.strictObject({
    kind: TransportKindSchema,
    endpoint: z.string().min(1),
    features: z.array(TransportFeatureSchema).refine(uniqueValues, "features must be unique")
  })).min(1),
  health: z.strictObject({
    state: z.enum(["starting", "ready", "degraded", "unhealthy"]),
    checkedAt: z.iso.datetime()
  })
}).superRefine((value, context) => {
  if (value.ownership === "clawso-managed" && !value.installReceiptId) {
    context.addIssue({
      code: "custom",
      path: ["installReceiptId"],
      message: "clawso-managed descriptors require installReceiptId"
    });
  }
  if (value.ownership === "native-unmanaged" && value.installReceiptId) {
    context.addIssue({
      code: "custom",
      path: ["installReceiptId"],
      message: "native-unmanaged descriptors cannot claim installReceiptId"
    });
  }
});

export type AssetRef = z.infer<typeof AssetRefSchema>;
export type OperationContract = z.infer<typeof OperationContractSchema>;
export type ServiceDeclaration = z.infer<typeof ServiceDeclarationSchema>;
export type RuntimeInstanceDescriptor = z.infer<typeof RuntimeInstanceDescriptorSchema>;
export type ServiceSource = "native" | "clawso";

export interface DiscoveredService extends RuntimeInstanceDescriptor {
  source: ServiceSource;
  descriptorPath: string;
  routingEndpoint: string;
  declaration: ServiceDeclaration;
}

export type ServiceQuarantineReason =
  | "corrupt_declaration"
  | "conflicting_declaration"
  | "corrupt_descriptor"
  | "missing_declaration"
  | "declaration_mismatch"
  | "expired_lease"
  | "dead_process"
  | "unhealthy"
  | "health_probe_failed"
  | "duplicate_instance";

export interface ServiceQuarantineRecord {
  reason: ServiceQuarantineReason;
  detail: string;
  filePath: string;
  instanceId?: string;
}

export interface ServiceDiscoveryReport {
  services: DiscoveredService[];
  quarantined: ServiceQuarantineRecord[];
}

export interface ServiceDiscoveryOptions {
  declarationDirs: string[];
  descriptorDirs: Array<{ path: string; source: ServiceSource }>;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
  probeHealth?: (service: DiscoveredService) => Promise<boolean>;
}

export interface ResolvedService {
  source: "explicit-url" | "environment" | "explicit-selection" | ServiceSource | "compatibility-probe";
  serviceId: string;
  endpoint: string;
  instanceId?: string;
  providerId?: string;
  descriptor?: DiscoveredService;
}

export interface ResolveServiceOptions {
  serviceId: string;
  explicitUrl?: string;
  selectedInstanceId?: string;
  env?: NodeJS.ProcessEnv;
  services: DiscoveredService[];
  compatibilityProbes?: Array<() => Promise<string | undefined>>;
}

export interface RuntimeServiceRegistrationOptions {
  declaration: ServiceDeclaration;
  declarationDir: string;
  descriptorDir: string;
  transports: RuntimeInstanceDescriptor["transports"];
  instanceId?: string;
  pid?: number;
  ownership?: RuntimeInstanceDescriptor["ownership"];
  installReceiptId?: string;
  leaseDurationMs?: number;
  now?: () => Date;
}

export class RuntimeServiceRegistration {
  readonly instanceId: string;
  readonly descriptorPath: string;
  readonly declarationPath: string;

  private readonly declaration: ServiceDeclaration;
  private readonly declarationDigest: string;
  private readonly transports: RuntimeInstanceDescriptor["transports"];
  private readonly pid: number;
  private readonly ownership: RuntimeInstanceDescriptor["ownership"];
  private readonly installReceiptId?: string;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;

  constructor(options: RuntimeServiceRegistrationOptions) {
    this.declaration = ServiceDeclarationSchema.parse(options.declaration);
    this.declarationDigest = computeDeclarationDigest(this.declaration);
    this.transports = options.transports;
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.pid = options.pid ?? process.pid;
    this.ownership = options.ownership ?? "native-unmanaged";
    this.installReceiptId = options.installReceiptId;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.descriptorPath = path.join(options.descriptorDir, `${safeFileId(this.instanceId)}.json`);
    this.declarationPath = path.join(
      options.declarationDir,
      `${safeFileId(this.declaration.declarationId)}@${safeFileId(this.declaration.declarationVersion)}.json`
    );
  }

  publish(
    healthState: RuntimeInstanceDescriptor["health"]["state"],
    issuedAt: Date = this.now()
  ): RuntimeInstanceDescriptor {
    this.publishDeclaration();
    const descriptor = RuntimeInstanceDescriptorSchema.parse({
      $schema: RUNTIME_INSTANCE_SCHEMA_URL,
      schemaVersion: "1",
      instanceId: this.instanceId,
      providerId: this.declaration.providerId,
      declarationId: this.declaration.declarationId,
      declarationVersion: this.declaration.declarationVersion,
      declarationDigest: this.declarationDigest,
      assetRef: this.declaration.assetRef,
      ownership: this.ownership,
      ...(this.installReceiptId ? { installReceiptId: this.installReceiptId } : {}),
      pid: this.pid,
      lease: {
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + this.leaseDurationMs).toISOString()
      },
      transports: this.transports,
      health: {
        state: healthState,
        checkedAt: issuedAt.toISOString()
      }
    });
    atomicWritePrivate(this.descriptorPath, Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8"));
    return descriptor;
  }

  unregister(): void {
    try {
      fs.unlinkSync(this.descriptorPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private publishDeclaration(): void {
    const bytes = canonicalServiceDeclarationBytes(this.declaration);
    if (fs.existsSync(this.declarationPath)) {
      const existing = fs.readFileSync(this.declarationPath);
      if (!existing.equals(bytes)) {
        throw new Error("same declarationId/version has conflicting canonical bytes");
      }
      if (process.platform !== "win32") {
        fs.chmodSync(this.declarationPath, 0o600);
      }
      return;
    }
    atomicWritePrivate(this.declarationPath, bytes);
  }
}

export function canonicalServiceDeclarationBytes(input: unknown): Buffer {
  const declaration = ServiceDeclarationSchema.parse(input);
  return Buffer.from(`${JSON.stringify(sortJson(declaration))}\n`, "utf8");
}

export function computeDeclarationDigest(input: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(canonicalServiceDeclarationBytes(input)).digest("hex")}`;
}

export async function discoverServices(options: ServiceDiscoveryOptions): Promise<ServiceDiscoveryReport> {
  const now = options.now ?? new Date();
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const probeHealth = options.probeHealth ?? (async () => true);
  const quarantined: ServiceQuarantineRecord[] = [];
  const declarations = loadDeclarations(options.declarationDirs, quarantined);
  const candidates: DiscoveredService[] = [];

  for (const descriptorDirectory of options.descriptorDirs) {
    for (const filePath of listJsonFiles(descriptorDirectory.path)) {
      let descriptor: RuntimeInstanceDescriptor;
      try {
        descriptor = RuntimeInstanceDescriptorSchema.parse(readJson(filePath));
      } catch (error) {
        quarantined.push({
          reason: "corrupt_descriptor",
          detail: errorMessage(error),
          filePath
        });
        continue;
      }

      const declaration = declarations.get(declarationKey(
        descriptor.declarationId,
        descriptor.declarationVersion
      ));
      if (!declaration) {
        quarantined.push({
          reason: "missing_declaration",
          detail: "no exact declarationId/declarationVersion is registered",
          filePath,
          instanceId: descriptor.instanceId
        });
        continue;
      }
      if (!descriptorMatchesDeclaration(descriptor, declaration)) {
        quarantined.push({
          reason: "declaration_mismatch",
          detail: "descriptor digest, providerId, or assetRef does not exactly match its declaration",
          filePath,
          instanceId: descriptor.instanceId
        });
        continue;
      }
      if (Date.parse(descriptor.lease.expiresAt) <= now.getTime()) {
        quarantined.push({
          reason: "expired_lease",
          detail: "runtime lease is expired",
          filePath,
          instanceId: descriptor.instanceId
        });
        continue;
      }
      if (!isProcessAlive(descriptor.pid)) {
        quarantined.push({
          reason: "dead_process",
          detail: "runtime pid is not alive",
          filePath,
          instanceId: descriptor.instanceId
        });
        continue;
      }
      if (descriptor.health.state === "unhealthy" || descriptor.health.state === "starting") {
        quarantined.push({
          reason: "unhealthy",
          detail: `runtime health state is ${descriptor.health.state}`,
          filePath,
          instanceId: descriptor.instanceId
        });
        continue;
      }

      const service: DiscoveredService = {
        ...descriptor,
        source: descriptorDirectory.source,
        descriptorPath: filePath,
        routingEndpoint: descriptor.transports[0]?.endpoint ?? "",
        declaration
      };
      if (!(await probeHealth(service))) {
        quarantined.push({
          reason: "health_probe_failed",
          detail: "runtime health probe did not pass",
          filePath,
          instanceId: descriptor.instanceId
        });
        continue;
      }
      candidates.push(service);
    }
  }

  const services = rejectConflictingDuplicates(candidates, quarantined);
  services.sort(compareDiscoveredServices);
  return { services, quarantined };
}

export async function resolveService(options: ResolveServiceOptions): Promise<ResolvedService> {
  const serviceId = options.serviceId.trim();
  if (!serviceId) {
    throw new Error("serviceId is required");
  }
  if (options.explicitUrl?.trim()) {
    return {
      source: "explicit-url",
      serviceId,
      endpoint: normalizeUrl(options.explicitUrl)
    };
  }

  const env = options.env ?? process.env;
  const envName = serviceEndpointEnvName(serviceId);
  const envUrl = env[envName]?.trim();
  if (envUrl) {
    return {
      source: "environment",
      serviceId,
      endpoint: normalizeUrl(envUrl)
    };
  }

  const matches = options.services.filter((service) => serviceMatchesId(service, serviceId));
  if (options.selectedInstanceId?.trim()) {
    const selected = matches.find((service) => service.instanceId === options.selectedInstanceId?.trim());
    if (!selected) {
      throw new Error(`selected service instance not found: ${options.selectedInstanceId}`);
    }
    return resolvedDescriptor("explicit-selection", serviceId, selected);
  }

  const native = matches.find((service) => service.source === "native");
  if (native) {
    return resolvedDescriptor("native", serviceId, native);
  }
  const clawso = matches.find((service) => service.source === "clawso");
  if (clawso) {
    return resolvedDescriptor("clawso", serviceId, clawso);
  }

  for (const probe of options.compatibilityProbes ?? []) {
    const endpoint = await probe();
    if (endpoint?.trim()) {
      return {
        source: "compatibility-probe",
        serviceId,
        endpoint: normalizeUrl(endpoint)
      };
    }
  }
  throw new Error(`no compatible service found: ${serviceId}`);
}

export function serviceEndpointEnvName(serviceId: string): string {
  return `MERIDIAN_SERVICE_${serviceId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL`;
}

function loadDeclarations(
  directories: string[],
  quarantined: ServiceQuarantineRecord[]
): Map<string, ServiceDeclaration> {
  const declarations = new Map<string, ServiceDeclaration>();
  const digests = new Map<string, string>();
  for (const directory of directories) {
    for (const filePath of listJsonFiles(directory)) {
      let declaration: ServiceDeclaration;
      try {
        declaration = ServiceDeclarationSchema.parse(readJson(filePath));
      } catch (error) {
        quarantined.push({
          reason: "corrupt_declaration",
          detail: errorMessage(error),
          filePath
        });
        continue;
      }
      const key = declarationKey(declaration.declarationId, declaration.declarationVersion);
      const digest = computeDeclarationDigest(declaration);
      const existingDigest = digests.get(key);
      if (existingDigest && existingDigest !== digest) {
        declarations.delete(key);
        quarantined.push({
          reason: "conflicting_declaration",
          detail: "same declarationId/version has conflicting canonical bytes",
          filePath
        });
        continue;
      }
      declarations.set(key, declaration);
      digests.set(key, digest);
    }
  }
  return declarations;
}

function descriptorMatchesDeclaration(
  descriptor: RuntimeInstanceDescriptor,
  declaration: ServiceDeclaration
): boolean {
  return descriptor.declarationDigest === computeDeclarationDigest(declaration)
    && descriptor.providerId === declaration.providerId
    && JSON.stringify(descriptor.assetRef) === JSON.stringify(declaration.assetRef);
}

function rejectConflictingDuplicates(
  candidates: DiscoveredService[],
  quarantined: ServiceQuarantineRecord[]
): DiscoveredService[] {
  const grouped = new Map<string, DiscoveredService[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.instanceId) ?? [];
    group.push(candidate);
    grouped.set(candidate.instanceId, group);
  }
  const admitted: DiscoveredService[] = [];
  for (const group of grouped.values()) {
    const identities = new Set(group.map((entry) => JSON.stringify({
      providerId: entry.providerId,
      declarationId: entry.declarationId,
      declarationVersion: entry.declarationVersion,
      declarationDigest: entry.declarationDigest,
      assetRef: entry.assetRef,
      pid: entry.pid,
      transports: entry.transports
    })));
    if (identities.size > 1) {
      for (const entry of group) {
        quarantined.push({
          reason: "duplicate_instance",
          detail: "instanceId is reused with conflicting runtime identity",
          filePath: entry.descriptorPath,
          instanceId: entry.instanceId
        });
      }
      continue;
    }
    admitted.push(group[0] as DiscoveredService);
  }
  return admitted;
}

function serviceMatchesId(service: DiscoveredService, serviceId: string): boolean {
  return service.providerId === serviceId
    || service.declarationId === serviceId
    || service.declaration.serviceCapabilities.some((capability) => capability.id === serviceId)
    || service.declaration.operations.some((operation) => operation.id === serviceId);
}

function resolvedDescriptor(
  source: "explicit-selection" | ServiceSource,
  serviceId: string,
  service: DiscoveredService
): ResolvedService {
  return {
    source,
    serviceId,
    endpoint: service.routingEndpoint,
    instanceId: service.instanceId,
    providerId: service.providerId,
    descriptor: service
  };
}

function compareDiscoveredServices(left: DiscoveredService, right: DiscoveredService): number {
  const sourceOrder = { native: 0, clawso: 1 };
  return sourceOrder[left.source] - sourceOrder[right.source]
    || left.providerId.localeCompare(right.providerId)
    || left.instanceId.localeCompare(right.instanceId);
}

function listJsonFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function declarationKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

function normalizeUrl(value: string): string {
  return new URL(value.trim()).toString();
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function atomicWritePrivate(filePath: string, bytes: Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
    }
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup. The original write error remains authoritative.
    }
    throw error;
  }
}

function safeFileId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }
  return value;
}

function uniqueValues(values: readonly unknown[]): boolean {
  return new Set(values.map((value) => JSON.stringify(value))).size === values.length;
}

function uniqueObjects(values: readonly unknown[]): boolean {
  return uniqueValues(values);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
