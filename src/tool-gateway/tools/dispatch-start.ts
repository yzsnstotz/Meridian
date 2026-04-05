import * as fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  DispatchModelMapSchema,
  ReplyChannelSchema,
  type DispatchModelMap,
  type DispatchModelOverride
} from "../../types";
import { buildDispatchStatusReport } from "./dispatch-status";
import {
  buildServiceErrorData,
  postRolesServiceJson,
  requestRolesServiceJson
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const DEFAULT_COMMAND_FILE_NAME = "agent_dispatch_command.md";
const DEFAULT_FALLBACK_REPLY_CHANNEL = {
  channel: "web",
  chat_id: "web:ops"
} as const;

const ReplyChannelsPayloadSchema = z.object({
  channels: z.array(ReplyChannelSchema)
});

const DispatchStartResponseSchema = z.object({
  ok: z.literal(true),
  dispatcher_id: z.string().min(1),
  dispatcher_thread_id: z.string().min(1)
});

export type DispatchStartModelMap = DispatchModelMap;
export type DispatchStartModelOverride = DispatchModelOverride;

export interface DispatchPlanModelLegendEntry {
  label: string | null;
  provider: string | null;
  model_id: string | null;
}

export interface DispatchStartWarnings {
  warnings: string[];
  unknown_codes: string[];
}

interface WarningCollector extends DispatchStartWarnings {
  known_codes: Set<string>;
}

type ReplyChannelsResult =
  | {
      ok: true;
      channels: z.infer<typeof ReplyChannelSchema>[];
      source: "service" | "fallback";
    }
  | {
      ok: false;
      error: string;
      data?: Record<string, unknown>;
    };

const dispatchStartTool: ToolDefinition = {
  name: "dispatch-start",
  description: "Start an agent-dispatcher session for a dispatch plan with optional model-map overrides",
  params: {
    plan: {
      type: "string",
      required: true,
      description: "Path to the dispatch_plan.md file"
    },
    model_map: {
      type: "string",
      required: false,
      description: "Comma-separated overrides, for example CODEX=codex:o3-mini,OPUS=claude:claude-opus-4-6"
    },
    model_map_file: {
      type: "string",
      required: false,
      description: "Path to a JSON file containing { CODE: { provider, model_id } } overrides"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const planPath = requireParam(params.plan);
    if (!planPath) {
      return {
        ok: false,
        error: "Missing required parameter: plan"
      };
    }

    try {
      return await executeDispatchStart({
        planPath,
        modelMap: params.model_map,
        modelMapFile: params.model_map_file
      });
    } catch (error) {
      return {
        ok: false,
        error: asError(error).message
      };
    }
  }
};

export default dispatchStartTool;

export async function executeDispatchStart(args: {
  planPath: string;
  modelMap?: string;
  modelMapFile?: string;
}): Promise<ToolResult> {
  const planMarkdown = await fs.readFile(args.planPath, "utf8");
  const modelLegend = parseDispatchPlanModelLegend(planMarkdown);
  const warnings = buildWarningCollector(modelLegend);
  const parsedModelMap = await resolveModelMap({
    modelMap: args.modelMap,
    modelMapFile: args.modelMapFile,
    warnings
  });
  const commandFilePath = await resolveCommandFilePath(args.planPath);
  const replyChannels = await resolveReplyChannels();
  if (!replyChannels.ok) {
    return replyChannels;
  }

  const response = await postRolesServiceJson<unknown>("/api/agent-dispatcher/start", {
    dispatch_plan_path: args.planPath,
    command_file_path: commandFilePath,
    user_reply_channels: replyChannels.channels,
    config: {
      model_map: parsedModelMap
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      error: response.error,
      data: buildServiceErrorData(response)
    };
  }

  const parsedResponse = DispatchStartResponseSchema.safeParse(response.body);
  if (!parsedResponse.success) {
    throw new Error("Invalid response from Meridian-roles /api/agent-dispatcher/start");
  }

  return {
    ok: true,
    data: {
      dispatch_plan_path: args.planPath,
      command_file_path: commandFilePath,
      dispatcher_id: parsedResponse.data.dispatcher_id,
      dispatcher_thread_id: parsedResponse.data.dispatcher_thread_id,
      reply_channels: replyChannels.channels,
      reply_channel_source: replyChannels.source,
      model_map: parsedModelMap,
      warnings: warnings.warnings,
      dispatch_status: await buildDispatchStatusReport(args.planPath)
    }
  };
}

async function resolveModelMap(args: {
  modelMap?: string;
  modelMapFile?: string;
  warnings: DispatchStartWarnings;
}): Promise<DispatchStartModelMap> {
  const inlineValue = requireParam(args.modelMap);
  const fileValue = requireParam(args.modelMapFile);

  if (inlineValue && fileValue) {
    throw new Error("Provide either model_map or model_map_file, not both");
  }

  if (inlineValue) {
    return parseInlineModelMap(inlineValue, args.warnings);
  }

  if (fileValue) {
    return parseModelMapFile(fileValue, args.warnings);
  }

  return {};
}

export function parseInlineModelMap(
  value: string,
  warnings: DispatchStartWarnings = buildWarningCollector({})
): DispatchStartModelMap {
  const entries = value
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const parsed: Record<string, DispatchStartModelOverride> = {};
  for (const entry of entries) {
    const equalsIndex = entry.indexOf("=");
    const colonIndex = entry.indexOf(":", equalsIndex + 1);
    if (equalsIndex <= 0 || colonIndex <= equalsIndex + 1 || colonIndex === entry.length - 1) {
      throw new Error(`Invalid model_map entry: ${entry}`);
    }

    const code = entry.slice(0, equalsIndex).trim();
    const provider = entry.slice(equalsIndex + 1, colonIndex).trim();
    const modelId = entry.slice(colonIndex + 1).trim();

    if (!code || !provider || !modelId) {
      throw new Error(`Invalid model_map entry: ${entry}`);
    }

    parsed[code] = {
      provider,
      model_id: modelId
    };
    warnIfUnknownCode(code, warnings);
  }

  return DispatchModelMapSchema.parse(parsed);
}

export async function parseModelMapFile(
  filePath: string,
  warnings: DispatchStartWarnings = buildWarningCollector({})
): Promise<DispatchStartModelMap> {
  const raw = await fs.readFile(filePath, "utf8");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in model_map_file ${filePath}: ${asError(error).message}`);
  }

  const parsed = DispatchModelMapSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid model_map_file payload: ${filePath}`);
  }

  for (const code of Object.keys(parsed.data)) {
    warnIfUnknownCode(code, warnings);
  }

  return parsed.data;
}

export function parseDispatchPlanModelLegend(markdown: string): Record<string, DispatchPlanModelLegendEntry> {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const columnIndex = indexModelLegendColumns(headerCells);
    if (!columnIndex) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    const modelLegend: Record<string, DispatchPlanModelLegendEntry> = {};
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      const code = readOptionalCell(rowCells[columnIndex.code]);
      if (!code) {
        continue;
      }

      modelLegend[code] = {
        label: readOptionalCell(rowCells[columnIndex.model]),
        provider: columnIndex.provider === -1 ? null : readOptionalCell(rowCells[columnIndex.provider]),
        model_id: columnIndex.model_id === -1 ? null : readOptionalCell(rowCells[columnIndex.model_id])
      };
    }

    return modelLegend;
  }

  return {};
}

async function resolveCommandFilePath(planPath: string): Promise<string> {
  const commandFilePath = path.join(path.dirname(planPath), DEFAULT_COMMAND_FILE_NAME);
  await fs.access(commandFilePath);
  return commandFilePath;
}

async function resolveReplyChannels(): Promise<ReplyChannelsResult> {
  const response = await requestRolesServiceJson<unknown>("/api/channels");
  if (!response.ok) {
    if (response.service_unreachable) {
      return {
        ok: false,
        error: response.error,
        data: buildServiceErrorData(response)
      };
    }

    return {
      ok: true,
      channels: [DEFAULT_FALLBACK_REPLY_CHANNEL],
      source: "fallback"
    };
  }

  const parsed = ReplyChannelsPayloadSchema.safeParse(response.body);
  if (!parsed.success || parsed.data.channels.length === 0) {
    return {
      ok: true,
      channels: [DEFAULT_FALLBACK_REPLY_CHANNEL],
      source: "fallback"
    };
  }

  return {
    ok: true,
    channels: parsed.data.channels,
    source: "service"
  };
}

function buildWarningCollector(modelLegend: Record<string, DispatchPlanModelLegendEntry>): WarningCollector {
  return {
    warnings: [],
    unknown_codes: [],
    known_codes: new Set(Object.keys(modelLegend))
  };
}

function warnIfUnknownCode(code: string, warnings: DispatchStartWarnings): void {
  const collector = warnings as WarningCollector;
  if (!(collector.known_codes instanceof Set) || collector.known_codes.size === 0 || collector.known_codes.has(code)) {
    return;
  }

  if (!collector.unknown_codes.includes(code)) {
    collector.unknown_codes.push(code);
    collector.warnings.push(
      `Unknown model code in model_map: ${code}. It will be stored as an override but may be ignored by the dispatcher.`
    );
  }
}

function indexModelLegendColumns(headerCells: string[]): {
  model: number;
  code: number;
  provider: number;
  model_id: number;
} | null {
  const normalizedHeaders = headerCells.map(normalizeTableHeader);
  const code = normalizedHeaders.indexOf("code");
  const model = normalizedHeaders.indexOf("model");
  if (code === -1 || model === -1) {
    return null;
  }

  return {
    model,
    code,
    provider: normalizedHeaders.indexOf("provider"),
    model_id: normalizedHeaders.indexOf("model_id")
  };
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }

  const withoutLeadingPipe = trimmed.slice(1);
  const normalized = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return normalized.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function normalizeTableHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function readOptionalCell(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^`+|`+$/g, "");
  return trimmed.length > 0 && trimmed !== "—" ? trimmed : null;
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
