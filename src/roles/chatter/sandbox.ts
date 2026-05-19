import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SandboxSpawnPlanInput {
  memoryFolder: string;
  skillAllowlist: ReadonlyArray<string>;
  // Free-form: meridian-hub owns the allowed-kinds list. The local
  // settings.json sandbox doesn't branch on the value today, so any
  // non-empty string is fine here.
  llmAgentKind: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
}

export interface SandboxSpawnPlan {
  cwd: string;
  settingsPath: string;
  spawnArgs: ReadonlyArray<string>;
  toolDescriptors: ReadonlyArray<ToolDescriptor>;
  materialize: () => void;
}

const BUILTIN_MEMORY_TOOLS: ReadonlyArray<ToolDescriptor> = [
  { name: "chatter.memory.read", description: "Read a memory entry by logical key." },
  { name: "chatter.memory.write", description: "Write a memory entry by logical key (session mode only)." },
  { name: "chatter.memory.list", description: "List entries under a logical path." }
];

export function buildSandboxSpawnPlan(input: SandboxSpawnPlanInput): SandboxSpawnPlan {
  const sandboxDir = path.join(input.memoryFolder, ".chatter-sandbox");
  const settingsPath = path.join(sandboxDir, "settings.json");

  const settings = {
    permissions: {
      allow: [`Read(${input.memoryFolder}/**)`, `Write(${input.memoryFolder}/**)`],
      deny: ["Bash(*)", "WebFetch(*)", "WebSearch(*)", "Read(/**)", "Write(/**)"],
      additionalDirectories: [] as string[]
    },
    enabledMcpjsonServers: [] as string[],
    disableAllHooks: true
  };

  const skillTools: ReadonlyArray<ToolDescriptor> = input.skillAllowlist.map((s) => ({
    name: `chatter.skill.${s}`,
    description: `Operator-allowlisted skill: ${s}`
  }));

  const toolDescriptors: ReadonlyArray<ToolDescriptor> = [...BUILTIN_MEMORY_TOOLS, ...skillTools];

  const spawnArgs: ReadonlyArray<string> = ["--settings", settingsPath, "--cwd", input.memoryFolder];

  return {
    cwd: input.memoryFolder,
    settingsPath,
    spawnArgs,
    toolDescriptors,
    materialize() {
      mkdirSync(sandboxDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  };
}
