import { constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  STRUCTURED_SKILL_NAMES,
  getStructuredToolDescriptors,
  type StructuredSkillName
} from "./skills/structured";
import type { ChatterManifest } from "./manifest";
import type { MemoryResolver } from "./memory-resolver";

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

export const SEEDS_INIT_SENTINEL = ".seeds_initialized";

export class SeedsInitError extends Error {
  constructor(
    public readonly code: "seeds_source_missing" | "seeds_init_failed",
    cause?: unknown
  ) {
    super(`${code}${cause instanceof Error ? `: ${cause.message}` : ""}`, { cause });
    this.name = "SeedsInitError";
  }
}

const BUILTIN_MEMORY_TOOLS: ReadonlyArray<ToolDescriptor> = [
  { name: "chatter.memory.read", description: "Read a memory entry by logical key." },
  { name: "chatter.memory.write", description: "Write a memory entry by logical key (session mode only)." },
  { name: "chatter.memory.list", description: "List entries under a logical path." }
];

const STRUCTURED_SKILL_NAME_SET: ReadonlySet<string> = new Set(STRUCTURED_SKILL_NAMES);
const STRUCTURED_TOOL_DESCRIPTORS = new Map<StructuredSkillName, ToolDescriptor>(
  getStructuredToolDescriptors().map((descriptor) => [descriptor.name, descriptor])
);

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

  const skillTools: ReadonlyArray<ToolDescriptor> = input.skillAllowlist.map((s) => {
    if (STRUCTURED_SKILL_NAME_SET.has(s)) {
      return STRUCTURED_TOOL_DESCRIPTORS.get(s as StructuredSkillName) ?? {
        name: s,
        description: `Operator-allowlisted skill: ${s}`
      };
    }
    return {
      name: `chatter.skill.${s}`,
      description: `Operator-allowlisted skill: ${s}`
    };
  });

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

export async function initializeSeedsOnProvision(input: {
  resolver: MemoryResolver;
  seedsInit: ChatterManifest["seeds_init"];
}): Promise<void> {
  if (input.seedsInit?.mode !== "copy_on_provision") {
    return;
  }

  const sentinelPath = input.resolver.resolveMemoryPath(SEEDS_INIT_SENTINEL);
  if (existsSync(sentinelPath)) {
    return;
  }

  const sourcePath = input.seedsInit.source_path;
  if (!sourcePath) {
    throw new SeedsInitError("seeds_source_missing");
  }

  await assertReadableSeedSource(sourcePath);

  try {
    await copySeedDirectoryContents(sourcePath, input.resolver);
    await fs.writeFile(sentinelPath, `${new Date().toISOString()}\n`, { flag: "wx" });
  } catch (error) {
    if (error instanceof SeedsInitError) {
      throw error;
    }
    throw new SeedsInitError("seeds_init_failed", error);
  }
}

async function assertReadableSeedSource(sourcePath: string): Promise<void> {
  try {
    await fs.access(sourcePath, constants.R_OK);
    const stat = await fs.stat(sourcePath);
    if (!stat.isDirectory()) {
      throw new Error("seed source is not a directory");
    }
  } catch (error) {
    throw new SeedsInitError("seeds_source_missing", error);
  }
}

async function copySeedDirectoryContents(sourcePath: string, resolver: MemoryResolver): Promise<void> {
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    await copySeedEntry(path.join(sourcePath, entry.name), [entry.name], entry, resolver);
  }
}

async function copySeedEntry(
  sourcePath: string,
  relativeSegments: string[],
  entry: Dirent,
  resolver: MemoryResolver
): Promise<void> {
  const destinationPath = resolver.resolveMemoryPath(...relativeSegments);

  if (entry.isDirectory()) {
    await fs.mkdir(destinationPath, { recursive: true });
    const childEntries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const child of childEntries) {
      await copySeedEntry(path.join(sourcePath, child.name), [...relativeSegments, child.name], child, resolver);
    }
    return;
  }

  if (entry.isFile()) {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    return;
  }

  throw new Error(`unsupported seed source entry: ${sourcePath}`);
}
