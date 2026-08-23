export interface ParamSchema {
  type: "string";
  required?: boolean;
  description?: string;
}

export interface ToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  params: Record<string, ParamSchema>;
  execute(params: Record<string, string>): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (!isToolDefinition(tool)) {
      throw new Error("Invalid tool definition");
    }

    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }
}

export function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    return false;
  }

  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    return false;
  }

  if (!isParamSchemaRecord(value.params)) {
    return false;
  }

  return typeof value.execute === "function";
}

function isParamSchemaRecord(value: unknown): value is Record<string, ParamSchema> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => {
    if (!isRecord(entry)) {
      return false;
    }

    if (entry.type !== "string") {
      return false;
    }

    if ("required" in entry && typeof entry.required !== "boolean") {
      return false;
    }

    if ("description" in entry && typeof entry.description !== "string") {
      return false;
    }

    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
