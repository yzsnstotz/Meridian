import path from "node:path";

import { sendViaHttpRelay } from "./ipc-bridge";
import { loadToolsFromDirectory } from "./loader";
import { ToolRegistry, type ToolResult } from "./registry";

export async function createToolGateway(toolsDir = path.join(__dirname, "tools")): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  await loadToolsFromDirectory(toolsDir, registry);
  return registry;
}

export async function executeToolCommand(
  registry: ToolRegistry,
  toolName: string,
  params: Record<string, string>
): Promise<ToolResult> {
  const tool = registry.get(toolName);
  if (!tool) {
    return {
      ok: false,
      error: `Unknown tool: ${toolName}`
    };
  }

  try {
    return await tool.execute(params);
  } catch (error) {
    return {
      ok: false,
      error: asError(error).message
    };
  }
}

export { sendViaHttpRelay, loadToolsFromDirectory, ToolRegistry };
export type { ParamSchema, ToolDefinition, ToolResult } from "./registry";

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
