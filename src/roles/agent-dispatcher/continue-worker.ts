import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";

import { resolveConfiguredDispatchRepoRoot } from "./dispatch-paths";
import { LifecycleStore } from "./lifecycle-store";
import {
  parseDispatchModelCode,
  resolveDispatchModelMapFromMarkdown,
  resolveImplicitDispatchModelOverride
} from "./model-routing";
import { isHumanDispatchRow } from "./service-continuation";
import { isValidationEnabledForWorker } from "./validator-orchestrator";
import { launchDispatchWorker, type LaunchDispatchWorkerConfig, type LaunchDispatchWorkerResult } from "./worker-launcher";
import { executeResumeWorkerAction } from "../../tool-gateway/tools/resume-worker";
import killTool from "../../tool-gateway/tools/kill";
import type { AgentDispatcherConfig, DispatchWorkerState } from "../../types";

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
  | "validator"
>;

export interface ContinueDispatchPlanRow {
  status: string;
  worker: string;
  model: string;
  reasoningEffort?: string;
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
  killThread: (threadId: string) => Promise<KillThreadResult> = defaultKillThread,
  otherDispatchPlanPaths: readonly string[] = []
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

    // Guard: refuse to re-dispatch a worker that already reached a terminal
    // success state in the lifecycle store. The plan markdown may show 🔄 due
    // to a stale sync, but the lifecycle store is authoritative. Without this
    // guard, shouldResetWorkerBeforeContinue would wipe the completed state
    // back to pending and cause an infinite re-dispatch loop.
    const lifecycleStore = new LifecycleStore(
      path.join(path.dirname(config.dispatch_plan_path), "dispatch_threads.json")
    );
    const currentWorkerState = lifecycleStore.load().workers[workerId];
    if (currentWorkerState?.status === "completed" || currentWorkerState?.status === "skipped") {
      return {
        ok: true,
        workerId,
        threadId: currentWorkerState.thread_id
      };
    }

    // fix_requested workers keep their existing thread alive — just return it
    // so the caller (role-handlers) can deliver validator feedback to it.
    // Exception: if the recorded thread id has been cleared (e.g. by
    // clearWorkerThreadForRelaunch after a failed feedback delivery), fall
    // through to launchWorkerFromDispatchPlan so a fresh thread is launched.
    // The lifecycle-preserved validation feedback is surfaced into the new
    // thread via buildPreviousAttemptContext.
    if (currentWorkerState?.status === "fix_requested" && currentWorkerState.thread_id?.trim()) {
      return {
        ok: true,
        workerId,
        threadId: currentWorkerState.thread_id
      };
    }

    // running workers with a recorded thread_id are already in flight.
    // Returning the existing thread id (instead of falling through to
    // launchWorkerFromDispatchPlan) prevents the dispatcher from spawning
    // a parallel agent against the same task — the regression observed
    // on agent-dispatcher-4db5c870 where continue ticks kept stacking new
    // worker threads on C-01 even though the lifecycle already showed it
    // running. The reconciler / watchdog is responsible for transitioning
    // the worker to abandoned/failed if its Hub thread is actually dead;
    // until that happens, this short-circuit is the correct behavior.
    if (currentWorkerState?.status === "running" && currentWorkerState.thread_id?.trim()) {
      return {
        ok: true,
        workerId,
        threadId: currentWorkerState.thread_id
      };
    }

    if (shouldResetWorkerBeforeContinue(dispatchPlanRow)) {
      resumeResult = await executeResumeWorkerAction({
        planPath: config.dispatch_plan_path,
        workerId,
        action: "retry",
        // Service-owned recovery should count against the automatic retry cap.
        incrementRetryCountOnRetry: true
      });
    }

    const launched = await launchWorkerFromDispatchPlan(
      config,
      dispatchPlanRow,
      launchWorker,
      currentWorkerState,
      otherDispatchPlanPaths
    );
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

    // Synchronously bind the worker to the spawned thread in the lifecycle
    // store BEFORE returning. launchDispatchWorker fires the run handoff as
    // a microtask (Promise.resolve().then(...)), and the runTool's
    // recordWorkerStart only lands after several async file reads — leaving
    // a window where dispatch_threads.json shows no worker entry but the
    // continue response already advertises `continued: <workerId>`. The
    // dispatcher's next tick then sees "no entry" and spawns again. Writing
    // a placeholder here closes that race; runTool's recordWorkerStart will
    // overwrite the row with the full preamble + expected_outputs shortly
    // after.
    const launchedThreadId = normalizeThreadId(launched.threadId);
    if (launchedThreadId) {
      try {
        lifecycleStore.recordWorkerLaunchInitiated(workerId, launchedThreadId);
      } catch (lifecycleError) {
        // Don't fail the launch if the lifecycle write fails — the run
        // handoff will record the worker properly. Just log it.
        console.warn("recordWorkerLaunchInitiated failed; relying on run handoff for lifecycle entry", {
          workerId,
          threadId: launchedThreadId,
          error: getErrorMessage(lifecycleError)
        });
      }
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
  launchWorker: (config: LaunchDispatchWorkerConfig) => Promise<LaunchDispatchWorkerResult>,
  currentWorkerState?: DispatchWorkerState | null,
  otherDispatchPlanPaths: readonly string[] = []
): Promise<LaunchDispatchWorkerResult> {
  const markdown = await fs.readFile(config.dispatch_plan_path, "utf8");
  const resolvedModelMap = resolveDispatchModelMapFromMarkdown(markdown, config.model_map);
  const parsedModel = parseDispatchModelCode(dispatchPlanRow.model);
  const modelCode = (parsedModel?.modelCode ?? dispatchPlanRow.model).trim();
  const resolvedModel = modelCode
    ? resolvedModelMap[modelCode] ?? resolveImplicitDispatchModelOverride(modelCode)
    : undefined;
  const appliedModel = currentWorkerState?.applied_model_id?.trim();
  const resolvedEffort = currentWorkerState?.applied_reasoning_effort
    ?? parsedModel?.reasoningEffort
    ?? resolvedModel?.reasoning_effort
    ?? dispatchPlanRow.reasoningEffort;
  const modelId = appliedModel ?? resolvedModel?.model_id?.trim();
  const resolvedAgentType = modelCode
    ? deriveAgentTypeFromModelCode(modelId ?? modelCode, config.agent_type)
    : config.agent_type;

  const workerSpawnDir = resolveLaunchSpawnDir(config, dispatchPlanRow.worker);

  return launchWorker({
    agentType: resolvedModel?.provider?.trim() || resolvedAgentType,
    mode: config.mode,
    killPolicy: config.kill_policy,
    autoApprove: config.auto_approve,
    commandFilePath: config.command_file_path,
    dispatchPlanPath: config.dispatch_plan_path,
    dispatchRepoRoot: workerSpawnDir,
    workerId: dispatchPlanRow.worker,
    modelId,
    effort: resolvedEffort,
    validationMaxFixCycles: resolveValidationMaxFixCycles(config, dispatchPlanRow),
    otherDispatchPlanPaths
  });
}

function resolveLaunchSpawnDir(config: ContinueWorkerConfig, workerId: string): string {
  if (config.dispatch_repo_root?.trim()) {
    return resolveConfiguredDispatchRepoRoot(config);
  }

  return resolveWorkerSpawnDir(config.dispatch_plan_path, workerId)
    ?? resolveConfiguredDispatchRepoRoot(config);
}

function resolveValidationMaxFixCycles(
  config: ContinueWorkerConfig,
  dispatchPlanRow: ContinueDispatchPlanRow
): number | undefined {
  const validatorConfig = config.validator;
  if (!validatorConfig?.enabled) {
    return undefined;
  }

  return isValidationEnabledForWorker(validatorConfig, {
    status: dispatchPlanRow.status,
    worker: dispatchPlanRow.worker,
    model: dispatchPlanRow.model,
    depends_on: [],
    notes: dispatchPlanRow.notes ?? null
  })
    ? validatorConfig.max_fix_cycles
    : undefined;
}

function deriveAgentTypeFromModelCode(modelCode: string, defaultAgentType: string): string {
  const normalized = modelCode.trim().toUpperCase();
  if (normalized.startsWith("CODEX")) {
    return "codex";
  }
  if (normalized.startsWith("GPT")) {
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

/**
 * Reads the worker file (`<WORKER_ID>.md` next to the dispatch plan) and extracts
 * the `Repo:` field value if present. This allows multi-repo dispatch plans to
 * spawn each worker in its designated repository instead of using a single
 * `dispatch_repo_root` for all workers.
 *
 * Returns null if the worker file does not exist or has no Repo field.
 */
export function resolveWorkerSpawnDir(
  dispatchPlanPath: string,
  workerId: string
): string | null {
  const workerFilePath = path.join(path.dirname(dispatchPlanPath), `${workerId}.md`);

  let content: string;
  try {
    content = fsSync.readFileSync(workerFilePath, "utf8");
  } catch {
    return null;
  }

  const repoField = extractRepoFieldFromWorkerFile(content);
  if (!repoField || isReadOnlyMultiRepoAlias(repoField)) {
    return null;
  }

  const explicitPath = resolvePathLikeRepoField(repoField, dispatchPlanPath);
  if (explicitPath) {
    return explicitPath;
  }

  return resolveRepoMapPath(dispatchPlanPath, repoField, workerId);
}

const REPO_FIELD_PATTERN = /^[-*]\s*\*{0,2}Repo\*{0,2}\s*:\s*(.+?)\s*$/m;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s(])((?:~|\/)[^`)\s]+)/;

export function extractRepoFieldFromWorkerFile(content: string): string | null {
  const match = content.match(REPO_FIELD_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const rawRepoField = match[1].trim();
  const backtickValues = Array.from(
    rawRepoField.matchAll(/`([^`]+)`/g),
    (value) => value[1]?.trim() ?? ""
  ).filter((value) => value.length > 0);
  const absoluteBacktickPath = backtickValues.find(isAbsoluteOrHomePath);
  if (absoluteBacktickPath) {
    return absoluteBacktickPath;
  }

  const absolutePath = rawRepoField.match(ABSOLUTE_PATH_PATTERN)?.[1]?.trim();
  if (absolutePath) {
    return absolutePath;
  }

  const repoPath = stripRepoQualifier(rawRepoField.replace(/`/g, ""));
  return repoPath.length > 0 ? repoPath : null;
}

interface RepoMapEntry {
  prefixes: string[];
  repo: string;
  repoPath: string;
}

function resolveRepoMapPath(
  dispatchPlanPath: string,
  repoField: string,
  workerId: string
): string | null {
  let dispatchPlanMarkdown: string;
  try {
    dispatchPlanMarkdown = fsSync.readFileSync(dispatchPlanPath, "utf8");
  } catch {
    return null;
  }

  const repoMapEntries = extractRepoMapEntries(dispatchPlanMarkdown);
  if (repoMapEntries.length === 0) {
    return null;
  }

  const normalizedRepoField = normalizeRepoAlias(repoField);
  const aliasMatch = repoMapEntries.find((entry) => {
    return normalizeRepoAlias(entry.repo) === normalizedRepoField
      && isUsableRepoMapPath(entry.repoPath);
  });
  if (aliasMatch) {
    return stripMarkdownCell(aliasMatch.repoPath);
  }

  const prefixMatch = repoMapEntries.find((entry) => {
    return isUsableRepoMapPath(entry.repoPath)
      && entry.prefixes.some((prefix) => repoPrefixMatchesWorker(prefix, workerId));
  });
  return prefixMatch ? stripMarkdownCell(prefixMatch.repoPath) : null;
}

function extractRepoMapEntries(markdown: string): RepoMapEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: RepoMapEntry[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const headerCells = splitMarkdownTableRow(line).map((cell) => normalizeRepoAlias(cell));
    if (!headerCells.includes("prefix") || !headerCells.includes("repo") || !headerCells.includes("path")) {
      continue;
    }

    const prefixIndex = headerCells.indexOf("prefix");
    const repoIndex = headerCells.indexOf("repo");
    const pathIndex = headerCells.indexOf("path");

    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex] ?? "";
      if (!row.trim().startsWith("|")) {
        break;
      }
      if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(row)) {
        continue;
      }

      const cells = splitMarkdownTableRow(row);
      const repoPath = cells[pathIndex] ? stripMarkdownCell(cells[pathIndex]) : "";
      entries.push({
        prefixes: splitRepoPrefixes(cells[prefixIndex] ?? ""),
        repo: stripMarkdownCell(cells[repoIndex] ?? ""),
        repoPath
      });
    }

    break;
  }

  return entries;
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return [];
  }

  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function splitRepoPrefixes(value: string): string[] {
  return stripMarkdownCell(value)
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
}

function repoPrefixMatchesWorker(prefix: string, workerId: string): boolean {
  const normalizedPrefix = normalizeRepoPrefix(prefix);
  if (!normalizedPrefix) {
    return false;
  }

  const normalizedWorker = workerId.trim().toUpperCase();
  if (!normalizedPrefix.includes("*")) {
    return normalizedPrefix === normalizedWorker;
  }

  const pattern = new RegExp(`^${escapeRegExp(normalizedPrefix).replace(/\\\*/g, ".*")}$`);
  return pattern.test(normalizedWorker);
}

function resolvePathLikeRepoField(repoField: string, dispatchPlanPath: string): string | null {
  const trimmed = repoField.trim();
  if (path.isAbsolute(trimmed) || trimmed.startsWith("~/")) {
    return trimmed;
  }

  if (trimmed.startsWith(".") || trimmed.includes("/") || trimmed.includes("\\")) {
    return path.resolve(path.dirname(dispatchPlanPath), trimmed);
  }

  return null;
}

function isUsableRepoMapPath(repoPath: string): boolean {
  const normalized = normalizeRepoAlias(repoPath);
  return normalized.length > 0 && normalized !== "n/a" && normalized !== "na";
}

function isReadOnlyMultiRepoAlias(value: string): boolean {
  const normalized = normalizeRepoAlias(value);
  return normalized === "both" || normalized === "both repos" || normalized === "read only";
}

function stripRepoQualifier(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/g, "").trim();
}

function stripMarkdownCell(value: string): string {
  return stripRepoQualifier(value.replace(/[`*_]/g, "")).trim();
}

function normalizeRepoAlias(value: string): string {
  return stripMarkdownCell(value)
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");
}

function normalizeRepoPrefix(value: string): string {
  return stripMarkdownCell(value)
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isAbsoluteOrHomePath(value: string): boolean {
  return path.isAbsolute(value) || value.startsWith("~/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
