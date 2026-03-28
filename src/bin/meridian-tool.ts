#!/usr/bin/env tsx

import {
  createToolGateway,
  executeToolCommand,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult
} from "../tool-gateway";

export interface CliIo {
  stdout: {
    write(chunk: string): unknown;
  };
  stderr: {
    write(chunk: string): unknown;
  };
}

export interface CliDeps {
  createToolGateway(toolsDir?: string): Promise<ToolRegistry>;
  executeToolCommand(registry: ToolRegistry, toolName: string, params: Record<string, string>): Promise<ToolResult>;
}

interface ParsedArgs {
  toolName?: string;
  params: Record<string, string>;
  helpRequested: boolean;
  error?: string;
}

const HELP_FLAGS = new Set(["--help", "-h"]);

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr
};

const defaultDeps: CliDeps = {
  createToolGateway,
  executeToolCommand
};

export async function runCli(argv: string[], deps: CliDeps = defaultDeps, io: CliIo = defaultIo): Promise<number> {
  let registry: ToolRegistry | undefined;

  try {
    registry = await deps.createToolGateway();
    const parsed = parseArgs(argv);

    if (parsed.helpRequested) {
      writeUsage(io.stderr, registry.list());
      writeJson(io.stdout, {
        ok: true,
        tools: registry.list().map((tool) => summarizeTool(tool))
      });
      return 0;
    }

    if (parsed.error) {
      writeUsage(io.stderr, registry.list());
      writeJson(io.stdout, {
        ok: false,
        error: parsed.error
      });
      return 1;
    }

    const result = await deps.executeToolCommand(registry, getToolName(parsed), parsed.params);
    writeJson(io.stdout, result);
    return getExitCode(getToolName(parsed), result);
  } catch (error) {
    if (registry) {
      writeUsage(io.stderr, registry.list());
    }

    writeJson(io.stdout, {
      ok: false,
      error: asError(error).message
    });
    return 1;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return {
      params: {},
      helpRequested: false,
      error: "Tool name is required"
    };
  }

  if (argv.some((arg) => HELP_FLAGS.has(arg))) {
    return {
      params: {},
      helpRequested: true
    };
  }

  const [toolName, ...rest] = argv;
  const params: Record<string, string> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--") || token.length <= 2) {
      return {
        toolName,
        params,
        helpRequested: false,
        error: `Unexpected argument: ${token}`
      };
    }

    const value = rest[index + 1];
    if (value === undefined) {
      return {
        toolName,
        params,
        helpRequested: false,
        error: `Missing value for argument: ${token}`
      };
    }

    params[toParamName(token)] = value;
    index += 1;
  }

  return {
    toolName,
    params,
    helpRequested: false
  };
}

function writeUsage(stderr: CliIo["stderr"], tools: ToolDefinition[]): void {
  const sortedTools = [...tools].sort((left, right) => left.name.localeCompare(right.name));
  const lines = ["Usage: npx tsx src/bin/meridian-tool.ts <tool-name> [--param value ...]", "", "Registered tools:"];

  if (sortedTools.length === 0) {
    lines.push("  (none)");
  } else {
    for (const tool of sortedTools) {
      lines.push(`  - ${tool.name}: ${tool.description}`);
    }
  }

  stderr.write(`${lines.join("\n")}\n`);
}

function writeJson(stdout: CliIo["stdout"], result: unknown): void {
  stdout.write(`${JSON.stringify(result)}\n`);
}

function summarizeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    params: Object.keys(tool.params)
  };
}

function getToolName(parsed: ParsedArgs): string {
  if (!parsed.toolName) {
    throw new Error("Tool name is required");
  }

  return parsed.toolName;
}

function getExitCode(toolName: string, result: ToolResult): number {
  if (toolName === "kill") {
    return 0;
  }

  return result.ok ? 0 : 1;
}

function toParamName(flag: string): string {
  return flag.slice(2).replaceAll("-", "_");
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      writeJson(process.stdout, {
        ok: false,
        error: asError(error).message
      });
      process.exitCode = 1;
    }
  );
}
