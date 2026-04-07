import * as fs from "node:fs";
import path from "node:path";

export interface MeridianToolCommandSpec {
  command: string;
  args: string[];
  displayCommand: string;
  entrypointPath: string;
}

const MERIDIAN_ROLES_REPO_ROOT = path.resolve(__dirname, "../../..");
const SOURCE_TOOL_ENTRYPOINT = path.join(MERIDIAN_ROLES_REPO_ROOT, "src/bin/meridian-tool.ts");
const DIST_TOOL_ENTRYPOINT = path.join(MERIDIAN_ROLES_REPO_ROOT, "dist/bin/meridian-tool.js");
const LOCAL_TSX_EXECUTABLE = path.join(MERIDIAN_ROLES_REPO_ROOT, "node_modules/.bin/tsx");

export const MERIDIAN_TOOL_COMMAND = resolveMeridianToolCommand();
export const MERIDIAN_TOOL_EXECUTABLE = MERIDIAN_TOOL_COMMAND.command;
export const MERIDIAN_TOOL_ENTRYPOINT = MERIDIAN_TOOL_COMMAND.entrypointPath;
export const MERIDIAN_TOOL_DISPLAY_COMMAND = MERIDIAN_TOOL_COMMAND.displayCommand;

export function buildMeridianToolArgs(args: string[]): string[] {
  return [...MERIDIAN_TOOL_COMMAND.args, ...args];
}

export function resolveMeridianToolCommand(): MeridianToolCommandSpec {
  const preferredRuntimeTree = __dirname.includes(`${path.sep}dist${path.sep}`) ? "dist" : "src";

  if (preferredRuntimeTree === "dist" && fs.existsSync(DIST_TOOL_ENTRYPOINT)) {
    return buildNodeCommand(DIST_TOOL_ENTRYPOINT);
  }

  if (preferredRuntimeTree === "src" && fs.existsSync(SOURCE_TOOL_ENTRYPOINT)) {
    return buildTsxCommand(SOURCE_TOOL_ENTRYPOINT);
  }

  if (fs.existsSync(DIST_TOOL_ENTRYPOINT)) {
    return buildNodeCommand(DIST_TOOL_ENTRYPOINT);
  }

  return buildTsxCommand(SOURCE_TOOL_ENTRYPOINT);
}

function buildNodeCommand(entrypointPath: string): MeridianToolCommandSpec {
  return {
    command: process.execPath,
    args: [entrypointPath],
    displayCommand: `${shellQuote(process.execPath)} ${shellQuote(entrypointPath)}`,
    entrypointPath
  };
}

function buildTsxCommand(entrypointPath: string): MeridianToolCommandSpec {
  if (fs.existsSync(LOCAL_TSX_EXECUTABLE)) {
    return {
      command: LOCAL_TSX_EXECUTABLE,
      args: [entrypointPath],
      displayCommand: `${shellQuote(LOCAL_TSX_EXECUTABLE)} ${shellQuote(entrypointPath)}`,
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
