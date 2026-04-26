import * as fs from "node:fs/promises";
import path from "node:path";

import { SchedulerConfigSchema } from "../../types";
import type { ToolDefinition, ToolResult } from "../registry";

interface StaticScheduleEntry {
  id: string;
  description?: string;
  config: unknown;
}

const scheduleListTool: ToolDefinition = {
  name: "schedule-list",
  description: "List static scheduler registry entries and validate their scheduler config",
  params: {
    registry_dir: {
      type: "string",
      required: false,
      description: "Directory containing static schedule JSON files; defaults to roles/schedules"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const registryDir = path.resolve(params.registry_dir?.trim() || "roles/schedules");

    let files: string[];
    try {
      files = (await fs.readdir(registryDir))
        .filter((fileName) => fileName.endsWith(".json"))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isMissingDirectoryError(error)) {
        return { ok: true, data: { schedules: [], count: 0, registry_dir: registryDir } };
      }
      return { ok: false, error: asError(error).message, data: { registry_dir: registryDir } };
    }

    const schedules = [];
    for (const fileName of files) {
      const entryPath = path.join(registryDir, fileName);
      const entry = JSON.parse(await fs.readFile(entryPath, "utf8")) as StaticScheduleEntry;

      if (!entry || typeof entry.id !== "string" || entry.id.trim().length === 0) {
        return { ok: false, error: `Invalid schedule entry id in ${entryPath}` };
      }

      const parsedConfig = SchedulerConfigSchema.safeParse(entry.config);
      if (!parsedConfig.success) {
        return {
          ok: false,
          error: `Invalid scheduler config in ${entryPath}`,
          data: {
            issues: parsedConfig.error.issues
          }
        };
      }

      schedules.push({
        id: entry.id,
        description: entry.description,
        config: parsedConfig.data,
        path: entryPath
      });
    }

    return {
      ok: true,
      data: {
        schedules,
        count: schedules.length,
        registry_dir: registryDir
      }
    };
  }
};

export default scheduleListTool;

function isMissingDirectoryError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
