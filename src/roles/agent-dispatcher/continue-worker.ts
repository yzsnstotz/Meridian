import * as fs from "node:fs/promises";

import { resolveConfiguredDispatchRepoRoot } from "./dispatch-paths";
import { resolveDispatchModelMapFromMarkdown, resolveImplicitDispatchModelOverride } from "./model-routing";
import { isHumanDispatchRow } from "./service-continuation";
import { launchDispatchWorker, type LaunchDispatchWorkerConfig, type LaunchDispatchWorkerResult } from "./worker-launcher";
import { executeResumeWorkerAction } from "../../tool-gateway/tools/resume-worker";
import killTool from "../../tool-gateway/tools/kill";
import type { AgentDispatcherConfig } from "../../types";

type ResumeWorkerResult = Awaited<ReturnType<typeof executeResumeWorkerAction>>;
type KillThreadResult = Awaited<ReturnType<typeof killTool.execute>>;

type ContinueWorkerConfig = Pick<
  AgentDispatcherConfig,
  | "dispatch_plan_path"
  | "command_file_path"
  | "mode"
  | "agent_type"
  | "kill_policy"
  | "auto_approve"
  | "model_map"
  | "dispatch_repo_root"
>;

export interface ContinueDispatchPlanRow {
  status: string;
  worker: string;
  model: string;
  notes?: string | null;
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
  config: ContinueWorkerConfig,
  dispatchPlanRows: ContinueDispatchPlanRow[],
  workerId: string,
  launchWorker: (config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult> = launchDispatchWorker,
  killThread: (threadId: string) => Promise<KillThreadResult> = defaultKillThread
): Promise<ContinueDispatchWorkerResult> {
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
  config: ContinueWorkerConfig,
  dispatchPlanRow: ContinueDispatchPlanRow,
  launchWorker: (config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult>
): Promise<LaunchDispatchWorkerResult> {
  const markdown = await fs.readFile(config.dispatch_plan_path, "utf8");
  const resolvedModelMap = resolveDispatchModelMapFromMarkdown(markdown, config.model_map);
  const modelCode = dispatchPlanRow.model.trim();
  const resolvedModel = modelCode
    ? resolvedModelMap[modelCode] ?? resolveImplicitDispatchModelOverride(modelCode)
    : undefined;

  return launchWorker({
    agentType: resolvedModel?.provider?.trim() || deriveAgentTypeFromModelCode(modelCode, config.agent_type),
    mode: config.mode,
    killPolicy: config.kill_policy,
    autoApprove: config.auto_approve,
    commandFilePath: config.command_file_path,
    dispatchPlanPath: config.dispatch_plan_path,
    dispatchRepoRoot: resolveConfiguredDispatchRepoRoot(config),
    workerId: dispatchPlanRow.worker,
    modelId: resolvedModel?.model_id?.trim() || undefined
  });
}

function deriveAgentTypeFromModelCode(modelCode: string, defaultAgentType: string): string {
  const normalized = modelCode.trim().toUpperCase();
  if (normalized.startsWith("CODEX")) {
    return "codex";
  }
  if (normalized === "OPUS" || normalized === "SONNET" || normalized.startsWith("CLAUDE")) {
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
    || /\bspawn failed: Meridian API unreachable\b/i.test(message)
    || /\bNode (?:CLI )?(?:startup|loader)\b/i.test(message);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
