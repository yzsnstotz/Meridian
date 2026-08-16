import type { IncomingMessage } from "node:http";

import { identifyHmacCaller } from "./caller-auth-hmac";
import { identifyMtlsCaller } from "./caller-auth-mtls";
import { loadCallerRegistry } from "./caller-registry";
import type { CallerRegistry } from "./caller-registry-schema";

export const CALLER_SIGNATURE_HEADER = "x-meridian-caller-signature";

export interface CallerAuthenticatedRequest extends IncomingMessage {
  caller?: { caller_id: string };
  body_bytes?: Buffer;
}

export type CallerAuthNext = (error?: unknown) => void;
export type CallerAuthMiddleware = (
  request: CallerAuthenticatedRequest,
  response: ServerResponseLike,
  next: CallerAuthNext
) => Promise<void>;

export interface ServerResponseLike {
  statusCode?: number;
  setHeader(name: string, value: number | string | readonly string[]): void;
  end(chunk: string): void;
}

export class ForbiddenProjectError extends Error {
  readonly callerId: string;
  readonly projectId: string;

  constructor(callerId: string, projectId: string) {
    super(`Caller ${callerId} may not access project ${projectId}`);
    this.name = "ForbiddenProjectError";
    this.callerId = callerId;
    this.projectId = projectId;
  }
}

export class CallerRegistryUnavailableError extends Error {
  constructor() {
    super("Caller registry is unavailable; initialize caller auth middleware before checking project access");
    this.name = "CallerRegistryUnavailableError";
  }
}

let activeCallerRegistry: CallerRegistry | null = null;

export function createRequireCallerAuth(options: { registry: CallerRegistry }): CallerAuthMiddleware {
  activeCallerRegistry = options.registry;

  return async (request, response, next) => {
    try {
      const bodyBytes = await readBodyBytes(request);
      const hmacResult = identifyHmacCaller({
        body_bytes: bodyBytes,
        signature_header: request.headers[CALLER_SIGNATURE_HEADER],
        registry: options.registry
      });
      if (hmacResult.ok) {
        request.caller = { caller_id: hmacResult.caller_id };
        request.body_bytes = bodyBytes;
        next();
        return;
      }

      if (hmacResult.reason !== "missing_signature") {
        writeDenied(response, hmacResult.reason);
        return;
      }

      const result = identifyMtlsCaller({
        peer_cert: readPeerCertificate(request),
        registry: options.registry
      });

      if (!result.ok) {
        writeDenied(response, hmacResult.reason === "missing_signature" ? result.reason : hmacResult.reason);
        return;
      }

      request.caller = { caller_id: result.caller_id };
      request.body_bytes = bodyBytes;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function requireCallerAuth(
  request: CallerAuthenticatedRequest,
  response: ServerResponseLike,
  next: CallerAuthNext
): Promise<void> {
  const registry = await loadCallerRegistry();
  return createRequireCallerAuth({ registry })(request, response, next);
}

export function assertCallerMayAccessProject(callerId: string, projectId: string, registry?: CallerRegistry): void {
  const callerRegistry = registry ?? activeCallerRegistry;
  if (!callerRegistry) {
    throw new CallerRegistryUnavailableError();
  }

  const caller = callerRegistry.get(callerId);
  if (!caller || !caller.allowed_project_ids.includes(projectId)) {
    throw new ForbiddenProjectError(callerId, projectId);
  }
}

async function readBodyBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readPeerCertificate(request: IncomingMessage): unknown {
  const socket = request.socket as (IncomingMessage["socket"] & {
    getPeerCertificate?: () => unknown;
  }) | undefined;
  return socket?.getPeerCertificate?.();
}

function writeDenied(response: ServerResponseLike, reason: string): void {
  response.statusCode = 401;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify({ error: "denied_caller_auth", reason })}\n`);
}
