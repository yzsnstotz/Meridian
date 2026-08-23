import * as crypto from "node:crypto";

import type { CallerRegistry } from "./caller-registry-schema";
import type { CallerAuthResult, CallerIdentificationResult } from "./caller-auth-hmac";

export interface VerifyMtlsCertInput {
  caller_id: string;
  peer_cert: unknown;
  registry: CallerRegistry;
}

export function verifyMtlsCert(input: VerifyMtlsCertInput): CallerAuthResult {
  const caller = input.registry.get(input.caller_id);
  if (!caller) {
    return { ok: false, reason: "unknown_caller" };
  }
  if (caller.auth_method !== "mtls") {
    return { ok: false, reason: "auth_method_mismatch" };
  }

  const thumbprint = readPeerCertThumbprint(input.peer_cert);
  if (!thumbprint) {
    return { ok: false, reason: "missing_peer_cert" };
  }

  if (thumbprint !== normalizeThumbprint(caller.mtls_cert_thumbprint)) {
    return { ok: false, reason: "invalid_peer_cert" };
  }

  return { ok: true };
}

export function identifyMtlsCaller(input: { peer_cert: unknown; registry: CallerRegistry }): CallerIdentificationResult {
  const thumbprint = readPeerCertThumbprint(input.peer_cert);
  if (!thumbprint) {
    return { ok: false, reason: "missing_peer_cert" };
  }

  for (const caller of input.registry.values()) {
    if (caller.auth_method === "mtls" && normalizeThumbprint(caller.mtls_cert_thumbprint) === thumbprint) {
      return { ok: true, caller_id: caller.caller_id };
    }
  }

  return { ok: false, reason: "invalid_peer_cert" };
}

function readPeerCertThumbprint(peerCert: unknown): string | null {
  if (!peerCert) {
    return null;
  }

  if (Buffer.isBuffer(peerCert) || peerCert instanceof Uint8Array) {
    return hashThumbprint(Buffer.from(peerCert));
  }

  if (typeof peerCert === "object") {
    const cert = peerCert as { raw?: unknown; fingerprint256?: unknown };
    if (typeof cert.fingerprint256 === "string" && cert.fingerprint256.trim()) {
      return normalizeThumbprint(cert.fingerprint256);
    }
    if (Buffer.isBuffer(cert.raw) || cert.raw instanceof Uint8Array) {
      return hashThumbprint(Buffer.from(cert.raw));
    }
  }

  return null;
}

function hashThumbprint(raw: Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function normalizeThumbprint(value: string): string {
  return value.replace(/:/g, "").toLowerCase();
}
