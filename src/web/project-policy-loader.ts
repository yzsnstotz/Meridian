import * as fs from "node:fs/promises";
import path from "node:path";

import { ZodError } from "zod";

import {
  ProjectPolicySchema,
  type InterpolatedProjectPolicy,
  type ProjectPolicy
} from "./project-policy-schema";

export interface LoadProjectPolicyOptions {
  repoRoot?: string;
}

interface ProjectPolicyErrorOptions {
  projectId: string;
  filePath: string;
  cause?: unknown;
}

export class ProjectNotRegisteredError extends Error {
  readonly projectId: string;
  readonly filePath: string;

  constructor({ projectId, filePath, cause }: ProjectPolicyErrorOptions) {
    super(`Project policy is not registered: ${projectId}`, { cause });
    this.name = "ProjectNotRegisteredError";
    this.projectId = projectId;
    this.filePath = filePath;
  }
}

export class InvalidProjectPolicyError extends Error {
  readonly projectId: string;
  readonly filePath: string;
  readonly fieldPaths: string[];
  readonly fieldLineNumbers: Record<string, number>;

  constructor({
    projectId,
    filePath,
    fieldPaths,
    fieldLineNumbers,
    message,
    cause
  }: ProjectPolicyErrorOptions & {
    fieldPaths: string[];
    fieldLineNumbers?: Record<string, number>;
    message: string;
  }) {
    super(message, { cause });
    this.name = "InvalidProjectPolicyError";
    this.projectId = projectId;
    this.filePath = filePath;
    this.fieldPaths = fieldPaths;
    this.fieldLineNumbers = fieldLineNumbers ?? {};
  }
}

export async function loadProjectPolicy(
  projectId: string,
  options: LoadProjectPolicyOptions = {}
): Promise<ProjectPolicy> {
  assertValidProjectId(projectId);

  const filePath = getProjectPolicyPath(projectId, options.repoRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ProjectNotRegisteredError({ projectId, filePath, cause: error });
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new InvalidProjectPolicyError({
      projectId,
      filePath,
      fieldPaths: ["$"],
      fieldLineNumbers: { "$": readJsonParseLineNumber(error) ?? 1 },
      message: `Invalid project policy JSON for ${projectId}: ${asError(error).message}`,
      cause: error
    });
  }

  try {
    return ProjectPolicySchema.parse(json);
  } catch (error) {
    if (error instanceof ZodError) {
      const fieldPaths = readFieldPaths(error);
      throw new InvalidProjectPolicyError({
        projectId,
        filePath,
        fieldPaths,
        fieldLineNumbers: mapFieldLineNumbers(raw, fieldPaths),
        message: `Invalid project policy for ${projectId}: ${error.issues.map((issue) => issue.message).join("; ")}`,
        cause: error
      });
    }
    throw error;
  }
}

export function interpolatePolicyForUser(policy: ProjectPolicy, userId: string): InterpolatedProjectPolicy {
  const threadId = interpolatePattern(policy.thread_id_pattern, "thread_id_pattern", userId);
  const memoryFolder = interpolatePattern(policy.memory_folder_pattern, "memory_folder_pattern", userId);
  const chatId = interpolatePattern(policy.user_reply_channel_template.chat_id, "user_reply_channel_template.chat_id", userId);

  // Per-project env override for llm_agent_kind. Lets a single source-of-
  // truth project policy file (e.g. config/projects/mumu.json) hold the
  // Mac-friendly default ("claude-code") while production hosts override
  // to whatever CLI is actually installed and authenticated on that box
  // (e.g. MUMU_LLM_AGENT_KIND=codex on EC2). Avoids per-host forks of the
  // policy JSON and the dirty-tree state that creates.
  const overrideEnvKey = `${policy.project_id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_LLM_AGENT_KIND`;
  const llmAgentKindOverride = process.env[overrideEnvKey]?.trim();
  const effectiveLlmAgentKind = llmAgentKindOverride || policy.llm_agent_kind;

  return {
    ...policy,
    llm_agent_kind: effectiveLlmAgentKind,
    thread_id: threadId,
    memory_folder: memoryFolder,
    user_reply_channel: {
      ...policy.user_reply_channel_template,
      chat_id: chatId
    }
  };
}

export function getProjectPolicyPath(projectId: string, repoRoot = process.cwd()): string {
  assertValidProjectId(projectId);
  return path.join(repoRoot, "config", "projects", `${projectId}.json`);
}

function interpolatePattern(pattern: string, fieldName: string, userId: string): string {
  for (const placeholder of pattern.matchAll(/\{([^}]+)\}/g)) {
    if (placeholder[1] !== "user_id") {
      throw new Error(`Unknown placeholder {${placeholder[1]}} in ${fieldName}`);
    }
  }

  return pattern.split("{user_id}").join(userId);
}

function assertValidProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error(`Invalid project_id: ${projectId}`);
  }
}

function readFieldPaths(error: ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length === 0 ? "$" : issue.path.join(".")));
}

function mapFieldLineNumbers(raw: string, fieldPaths: string[]): Record<string, number> {
  const lineNumbers: Record<string, number> = {};
  const lines = raw.split(/\r?\n/);

  for (const fieldPath of fieldPaths) {
    const topLevelField = fieldPath.split(".")[0];
    const fieldPattern = `"${topLevelField}"`;
    const lineIndex = lines.findIndex((line) => line.includes(fieldPattern));
    lineNumbers[fieldPath] = lineIndex === -1 ? 1 : lineIndex + 1;
  }

  return lineNumbers;
}

function readJsonParseLineNumber(error: unknown): number | null {
  const match = asError(error).message.match(/line (\d+)/i);
  return match ? Number(match[1]) : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
