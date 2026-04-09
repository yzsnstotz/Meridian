import * as fs from "node:fs";
import path from "node:path";

export interface MeridianToolCommandSpec {
  command: string;
  args: string[];
  displayCommand: string;
  entrypointPath: string;
}

export interface ResolveMeridianToolCommandOptions {
  repoRoot?: string;
  runtimeTree?: "src" | "dist";
  existsSync?: (filePath: string) => boolean;
  nodeExecutable?: string;
  forceDevelopment?: boolean;
}

const MERIDIAN_ROLES_REPO_ROOT = path.resolve(__dirname, "../../..");

export const MERIDIAN_TOOL_COMMAND = resolveMeridianToolCommand();
export const MERIDIAN_TOOL_EXECUTABLE = MERIDIAN_TOOL_COMMAND.command;
export const MERIDIAN_TOOL_ENTRYPOINT = MERIDIAN_TOOL_COMMAND.entrypointPath;
export const MERIDIAN_TOOL_DISPLAY_COMMAND = MERIDIAN_TOOL_COMMAND.displayCommand;

export function buildMeridianToolArgs(args: string[]): string[] {
  return [...MERIDIAN_TOOL_COMMAND.args, ...args];
}

export function resolveMeridianToolCommand(options: ResolveMeridianToolCommandOptions = {}): MeridianToolCommandSpec {
  const repoRoot = path.resolve(options.repoRoot ?? MERIDIAN_ROLES_REPO_ROOT);
  const sourceToolEntrypoint = path.join(repoRoot, "src/bin/meridian-tool.ts");
  const distToolEntrypoint = path.join(repoRoot, "dist/bin/meridian-tool.js");
  const localTsxExecutable = path.join(repoRoot, "node_modules/.bin/tsx");
  const existsSync = options.existsSync ?? fs.existsSync;
  const runtimeTree = options.runtimeTree ?? (__dirname.includes(`${path.sep}dist${path.sep}`) ? "dist" : "src");
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  if (!options.forceDevelopment && runtimeTree === "dist" && existsSync(distToolEntrypoint)) {
    return buildNodeCommand(distToolEntrypoint, nodeExecutable);
  }

  if (existsSync(sourceToolEntrypoint)) {
    return buildTsxCommand(sourceToolEntrypoint, localTsxExecutable, existsSync);
  }

  if (existsSync(distToolEntrypoint)) {
    return buildNodeCommand(distToolEntrypoint, nodeExecutable);
  }

  return buildTsxCommand(sourceToolEntrypoint, localTsxExecutable, existsSync);
}

function buildNodeCommand(entrypointPath: string, nodeExecutable: string): MeridianToolCommandSpec {
  return {
    command: nodeExecutable,
    args: [entrypointPath],
    displayCommand: `${shellQuote(nodeExecutable)} ${shellQuote(entrypointPath)}`,
    entrypointPath
  };
}

function buildTsxCommand(
  entrypointPath: string,
  localTsxExecutable: string,
  existsSync: (filePath: string) => boolean
): MeridianToolCommandSpec {
  if (existsSync(localTsxExecutable)) {
    return {
      command: localTsxExecutable,
      args: [entrypointPath],
      displayCommand: `${shellQuote(localTsxExecutable)} ${shellQuote(entrypointPath)}`,
      entrypointPath
    };
  }

  return {
    command: "npx",
    args: ["tsx", entrypointPath],
    displayCommand: `npx tsx ${shellQuote(entrypointPath)}`,
    entrypointPath
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'\\''`)}'`;
}
