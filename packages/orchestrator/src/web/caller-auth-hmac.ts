import * as crypto from "node:crypto";

import type { CallerRegistry } from "./caller-registry-schema";

export interface VerifyHmacSignatureInput {
  caller_id: string;
  body_bytes: Buffer | Uint8Array | string;
  signature_header: string | string[] | undefined;
  registry: CallerRegistry;
}

export type CallerAuthResult =
  | { ok: true }
  | { ok: false; reason: string };

export type CallerIdentificationResult =
  | { ok: true; caller_id: string }
  | { ok: false; reason: string };

export function verifyHmacSignature(input: VerifyHmacSignatureInput): CallerAuthResult {
  const caller = input.registry.get(input.caller_id);
  if (!caller) {
    return { ok: false, reason: "unknown_caller" };
  }
  if (caller.auth_method !== "hmac") {
    return { ok: false, reason: "auth_method_mismatch" };
  }

  const secret = process.env[caller.hmac_key_env];
  if (!secret) {
    return { ok: false, reason: "hmac_secret_unavailable" };
  }

  const provided = parseSignatureHeader(input.signature_header);
  if (!provided) {
    return { ok: false, reason: "missing_signature" };
  }

  const expected = crypto.createHmac("sha256", secret).update(Buffer.from(input.body_bytes)).digest();
  if (!constantTimeDigestEqual(expected, provided)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true };
}

export function identifyHmacCaller(input: {
  body_bytes: Buffer | Uint8Array | string;
  signature_header: string | string[] | undefined;
  registry: CallerRegistry;
}): CallerIdentificationResult {
  if (!parseSignatureHeader(input.signature_header)) {
    return { ok: false, reason: "missing_signature" };
  }

  for (const caller of input.registry.values()) {
    if (caller.auth_method !== "hmac") {
      continue;
    }

    const result = verifyHmacSignature({
      caller_id: caller.caller_id,
      body_bytes: input.body_bytes,
      signature_header: input.signature_header,
      registry: input.registry
    });
    if (result.ok) {
      return { ok: true, caller_id: caller.caller_id };
    }
  }

  return { ok: false, reason: "invalid_signature" };
}

function parseSignatureHeader(header: string | string[] | undefined): Buffer | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const hex = trimmed.includes("=") ? trimmed.slice(trimmed.indexOf("=") + 1) : trimmed;
  if (!/^[a-fA-F0-9]+$/.test(hex) || hex.length % 2 !== 0) {
    return null;
  }

  return Buffer.from(hex, "hex");
}

function constantTimeDigestEqual(expected: Buffer, provided: Buffer): boolean {
  if (provided.length !== expected.length) {
    crypto.timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }

  return crypto.timingSafeEqual(expected, provided);
}
