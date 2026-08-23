#!/usr/bin/env node

import path from "node:path";

import {
  discoverExistingRolesStatePaths,
  importRolesState
} from "../migration/roles-state";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value ? path.resolve(value) : undefined;
}

function main(args: string[]): void {
  if (args.includes("--discover")) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      candidates: discoverExistingRolesStatePaths()
    }, null, 2)}\n`);
    return;
  }
  const sourcePath = optionValue(args, "--from");
  if (!sourcePath) {
    throw new Error("Usage: meridian-migrate-roles-state --discover | --from <path> [--to <path>] [--dry-run]");
  }
  const result = importRolesState({
    sourcePath,
    targetPath: optionValue(args, "--to"),
    dryRun: args.includes("--dry-run")
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2)}\n`);
  process.exitCode = 1;
}
