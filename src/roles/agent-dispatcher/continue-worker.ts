import * as fs from "node:fs/promises";
import path from "node:path";

import { resolveDispatchModelMapFromMarkdown } from "./model-routing";
import { isHumanDispatchRow } from "./service-continuation";
import { launchDispatchWorker, type LaunchDispatchWorkerConfig, type LaunchDispatchWorkerResult } from "./worker-launcher";
import { executeResumeWorkerAction } from "../../tool-gateway/tools/resume-worker";
import killTool from "../../tool-gateway/tools/kill";
import type { AgentDispatcherConfig } from "../../types";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";

type ResumeWorkerResult = Awaited<ReturnType<typeof executeResumeWorkerAction>>;
type KillThreadResult = Awaited<ReturnType<typeof killTool.execute>>;

export interface ContinueDispatchPlanRow {
  status: string;
  worker: string;
  model: string;
}

export interface ContinueDispatchWorkerResult {
  ok: boolean;
  workerId: string;
  threadId?: string;
  error?: string;
  localToolBootstrapFailure?: boolean;
  resumeResult?: ResumeWorkerResult;
}

export async function continueDispatchWorker(
  config: Pick<
    AgentDispatcherConfig,
    "dispatch_plan_path" | "command_file_path" | "mode" | "agent_type" | "kill_policy" | "model_map"
  >,
  dispatchPlanRows: ContinueDispatchPlanRow[],
  workerId: string,
  launchWorker: (config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult> = launchDispatchWorker,
  killThread: (threadId: string) => Promise<KillThreadResult> = defaultKillThread
): Promise<ContinueDispatchWorkerResult> {
  const snapshot = await snapshotDispatchFiles(config.dispatch_plan_path);
  const dispatchPlanRow = dispatchPlanRows.find((row) => row.worker === workerId) ?? null;
  let resumeResult: ResumeWorkerResult | undefined;
  let orphanedLaunchThreadId: string | undefined;

  try {
    if (!dispatchPlanRow) {
      throw new Error(`Worker not found in dispatch plan: ${workerId}`);
    }

    if (isHumanDispatchRow(dispatchPlanRow)) {
      throw new Error(`Worker is not launchable: ${workerId}`);
    }

    if (shouldResetWorkerBeforeContinue(dispatchPlanRow)) {
      resumeResult = await executeResumeWorkerAction({
        planPath: config.dispatch_plan_path,
        workerId,
        action: "retry"
      });
    }

    const launched = await launchWorkerFromDispatchPlan(config, dispatchPlanRow, launchWorker);
    if (!launched.ok) {
      const launchError = launched.error ?? "Failed to launch dispatch worker";
      orphanedLaunchThreadId = normalizeThreadId(launched.threadId);
      if (orphanedLaunchThreadId) {
        try {
          await killOrphanedLaunchThread(orphanedLaunchThreadId, killThread);
          orphanedLaunchThreadId = undefined;
        } catch (cleanupError) {
          throw new Error(`${launchError}; ${getErrorMessage(cleanupError)}`);
        }
      }

      throw new Error(launchError);
    }

    return {
      ok: true,
      workerId,
      threadId: launched.threadId,
      ...(resumeResult ? { resumeResult } : {})
    };
  } catch (error) {
    await restoreDispatchFiles(snapshot);
    const message = getErrorMessage(error);
    return {
      ok: false,
      workerId,
      ...(orphanedLaunchThreadId ? { threadId: orphanedLaunchThreadId } : {}),
      error: message,
      localToolBootstrapFailure: isLocalToolBootstrapFailure(message)
    };
  }
}

export function shouldResetWorkerBeforeContinue(row: Pick<ContinueDispatchPlanRow, "status"> | null): boolean {
  switch (row?.status.trim()) {
    case "⚠️ ABANDONED":
    case "❌":
    case "🔄":
      return true;
    default:
      return false;
  }
}

async function launchWorkerFromDispatchPlan(
  config: Pick<
    AgentDispatcherConfig,
    "dispatch_plan_path" | "command_file_path" | "mode" | "agent_type" | "kill_policy" | "model_map"
  >,
  dispatchPlanRow: ContinueDispatchPlanRow,
  launchWorker: (config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult>
): Promise<LaunchDispatchWorkerResult> {
  const markdown = await fs.readFile(config.dispatch_plan_path, "utf8");
  const resolvedModelMap = resolveDispatchModelMapFromMarkdown(markdown, config.model_map);
  const modelCode = dispatchPlanRow.model.trim();
  const resolvedModel = modelCode ? resolvedModelMap[modelCode] : undefined;

  return launchWorker({
    agentType: resolvedModel?.provider?.trim() || deriveAgentTypeFromModelCode(modelCode, config.agent_type),
    mode: config.mode,
    killPolicy: config.kill_policy,
    commandFilePath: config.command_file_path,
    dispatchPlanPath: config.dispatch_plan_path,
    workerId: dispatchPlanRow.worker,
    modelId: resolvedModel?.model_id?.trim() || undefined
  });
}

interface DispatchFileSnapshot {
  planPath: string;
  plan: OptionalFileSnapshot;
  sidecarPath: string;
  sidecar: OptionalFileSnapshot;
}

interface OptionalFileSnapshot {
  exists: boolean;
  content: string;
}

async function snapshotDispatchFiles(planPath: string): Promise<DispatchFileSnapshot> {
  const sidecarPath = resolveDispatchThreadPath(planPath);
  const [plan, sidecar] = await Promise.all([
    readOptionalFile(planPath),
    readOptionalFile(sidecarPath)
  ]);

  return {
    planPath,
    plan,
    sidecarPath,
    sidecar
  };
}

async function readOptionalFile(filePath: string): Promise<OptionalFileSnapshot> {
  try {
    return {
      exists: true,
      content: await fs.readFile(filePath, "utf8")
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false, content: "" };
    }

    throw error;
  }
}

async function restoreDispatchFiles(snapshot: DispatchFileSnapshot): Promise<void> {
  await Promise.all([
    restoreOptionalFile(snapshot.planPath, snapshot.plan),
    restoreOptionalFile(snapshot.sidecarPath, snapshot.sidecar)
  ]);
}

async function restoreOptionalFile(filePath: string, snapshot: OptionalFileSnapshot): Promise<void> {
  if (snapshot.exists) {
    await fs.writeFile(filePath, snapshot.content, "utf8");
    return;
  }

  await fs.rm(filePath, { force: true });
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

function deriveAgentTypeFromModelCode(modelCode: string, defaultAgentType: string): string {
  const normalized = modelCode.trim().toUpperCase();
  if (normalized.startsWith("CODEX")) {
    return "codex";
  }
  if (normalized.startsWith("CLAUDE")) {
    return "claude";
  }
  if (normalized.startsWith("GEMINI")) {
    return "gemini";
  }
  if (normalized.startsWith("CURSOR")) {
    return "cursor";
  }

  return defaultAgentType;
}

async function killOrphanedLaunchThread(
  threadId: string,
  killThread: (threadId: string) => Promise<KillThreadResult>
): Promise<void> {
  const result = await killThread(threadId);
  if (!result.ok) {
    throw new Error(`orphan cleanup failed for thread ${threadId}: ${result.error ?? "Kill failed"}`);
  }
}

async function defaultKillThread(threadId: string): Promise<KillThreadResult> {
  return killTool.execute({ thread_id: threadId });
}

function normalizeThreadId(threadId: string | undefined): string | undefined {
  const normalized = threadId?.trim();
  return normalized ? normalized : undefined;
}

function isLocalToolBootstrapFailure(message: string): boolean {
  return /(?:^|[\s:])(EACCES|ENOENT|EPERM)(?:[\s:]|$)/i.test(message)
    || message.includes("/tmp/tsx-")
    || /\btsx\b/i.test(message)
    || /\brun launch failed\b/i.test(message)
    || /\bspawn failed: Command failed\b/i.test(message)
    || /\bspawn failed: spawn\b/i.test(message)
    || /\bNode (?:CLI )?(?:startup|loader)\b/i.test(message);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
