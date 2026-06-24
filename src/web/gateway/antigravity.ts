// Antigravity provider — one-shot `agy -p "<prompt>" --model <model>`.
//
// The gateway advertises Antigravity-owned models as `antigravity/<agy-model>`
// so Gemini-looking ids from Antigravity do not route to the legacy gemini CLI.
// Before invoking the CLI, strip only that gateway prefix and pass the real
// model id to `agy`.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, EXEC_TIMEOUT_MS, type ChatCompletionRequest, type CompletionResult } from "./shared";

export const ANTIGRAVITY_MODELS: string[] = [];

const ANTIGRAVITY_COMMAND = "agy";
const DEFAULT_ANTIGRAVITY_MODEL = "antigravity-default";

export function matchesAntigravity(model: string | undefined): boolean {
  return !!model && /^antigravity\//i.test(model);
}

function antigravityModelId(model: string | undefined): string | undefined {
  return model && matchesAntigravity(model) ? model.replace(/^antigravity\//i, "") : undefined;
}

function estimateTokenCount(value: string): number {
  const text = value.trim();
  if (!text) return 0;
  const cjkChars = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const withoutCjk = text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ");
  const pieces = withoutCjk.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? [];
  const nonCjkTokens = pieces.reduce((sum, piece) => {
    return sum + (/^[A-Za-z0-9_]+$/.test(piece) ? Math.ceil(piece.length / 4) : 1);
  }, 0);
  return Math.max(1, cjkChars + nonCjkTokens);
}

export async function completeAntigravity(req: ChatCompletionRequest): Promise<CompletionResult> {
  const { system, prompt } = buildPrompt(req.messages);
  const fullPrompt = system ? `System: ${system}\n\n${prompt}` : prompt;
  const workDir = mkdtempSync(join(tmpdir(), "antigravity-gw-"));
  const selectedModel = antigravityModelId(req.model);
  const args = ["-p", fullPrompt];
  if (selectedModel) args.push("--model", selectedModel);

  try {
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(ANTIGRAVITY_COMMAND, args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`agy -p timed out after ${Math.round(EXEC_TIMEOUT_MS / 1000)}s`));
        }, EXEC_TIMEOUT_MS);
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (closeCode) => {
          clearTimeout(timer);
          resolve({ code: closeCode, stdout, stderr });
        });
      }
    );

    if (code !== 0) {
      const message = stderr.trim() || stdout.trim() || "unknown error";
      return {
        text: "",
        model: req.model ?? DEFAULT_ANTIGRAVITY_MODEL,
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0 },
        isError: true,
        errorMessage: `antigravity exited ${code}: ${message}`
      };
    }

    return {
      text: stdout.trim(),
      model: req.model ?? DEFAULT_ANTIGRAVITY_MODEL,
      finishReason: "stop",
      usage: {
        promptTokens: estimateTokenCount(fullPrompt),
        completionTokens: estimateTokenCount(stdout)
      }
    };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of the throwaway working directory
    }
  }
}
