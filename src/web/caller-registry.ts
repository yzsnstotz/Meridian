import * as fs from "node:fs/promises";
import path from "node:path";

import { ZodError } from "zod";

import { CallerRegistrySchema, type CallerRegistry, type CallerRegistryEntry } from "./caller-registry-schema";

export interface LoadCallerRegistryOptions {
  repoRoot?: string;
  validateSecrets?: boolean;
}

export class InvalidCallerRegistryError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string, cause?: unknown) {
    super(`Invalid caller registry ${filePath}: ${message}`, { cause });
    this.name = "InvalidCallerRegistryError";
    this.filePath = filePath;
  }
}

export class DuplicateCallerIdError extends Error {
  readonly callerId: string;

  constructor(callerId: string) {
    super(`Duplicate caller_id in caller registry: ${callerId}`);
    this.name = "DuplicateCallerIdError";
    this.callerId = callerId;
  }
}

export class MissingCallerSecretError extends Error {
  readonly callerId: string;
  readonly envVar: string;

  constructor(callerId: string, envVar: string) {
    super(`HMAC caller ${callerId} references unset env var ${envVar}`);
    this.name = "MissingCallerSecretError";
    this.callerId = callerId;
    this.envVar = envVar;
  }
}

export async function loadCallerRegistry(options: LoadCallerRegistryOptions = {}): Promise<CallerRegistry> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const validateSecrets = options.validateSecrets ?? true;
  const directory = path.join(repoRoot, "config", "callers");
  const entries = new Map<string, CallerRegistryEntry>();

  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(directory)).filter((fileName) => fileName.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return entries;
    }
    throw error;
  }

  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InvalidCallerRegistryError(filePath, asError(error).message, error);
    }

    let caller: CallerRegistryEntry;
    try {
      caller = CallerRegistrySchema.parse(parsed);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new InvalidCallerRegistryError(filePath, error.issues.map((issue) => issue.message).join("; "), error);
      }
      throw error;
    }

    if (entries.has(caller.caller_id)) {
      throw new DuplicateCallerIdError(caller.caller_id);
    }

    if (validateSecrets && caller.auth_method === "hmac" && !process.env[caller.hmac_key_env]) {
      throw new MissingCallerSecretError(caller.caller_id, caller.hmac_key_env);
    }

    entries.set(caller.caller_id, caller);
  }

  return entries;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
