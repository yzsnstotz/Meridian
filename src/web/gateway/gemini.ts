// Gemini provider — one-shot `gemini -p "<prompt>" -o json --approval-mode plan`
// (category-b). Drives the real OAuth-logged-in `gemini` CLI (v0.37.0) off the
// user's Gemini subscription in non-interactive (headless), read-only mode and
// returns a normalized CompletionResult. Mirrors claude.ts.
//
// Probed shapes (gemini 0.37.0):
//   success  → stdout JSON: { session_id, response: "<text>",
//                stats: { models: { "<modelId>": { tokens: {
//                  prompt, candidates, total, ... } } } } }
//   api error → either stdout JSON { error: { type, message, code } } OR
//                (for some unknown-model ids) empty stdout + stack on stderr.
// We feed the prompt on stdin (the model name is too long / unsafe to inline as
// an arg) and pass an empty `-p` so the CLI stays headless and appends stdin.
import { spawn } from "node:child_process";
import { geminiAgentConfig } from "../../agents/gemini";
import { buildPrompt, type ChatCompletionRequest, type CompletionResult, type FinishReason } from "./shared";

// Kept for old imports only. Gateway model advertisement is live via
// ProviderModelCatalog rather than hardcoded Gemini CLI guesses.
export const GEMINI_MODELS: string[] = [];

export function matchesGemini(model: string | undefined): boolean {
  return !!model && /^gemini/i.test(model);
}

interface GeminiModelTokens {
  input?: number;
  prompt?: number;
  candidates?: number;
  total?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
}

interface GeminiJsonResult {
  session_id?: string;
  response?: string;
  error?: { type?: string; message?: string; code?: number };
  stats?: {
    models?: Record<string, { tokens?: GeminiModelTokens }>;
  };
}

function errorResult(req: ChatCompletionRequest, message: string): CompletionResult {
  return {
    text: "",
    model: req.model ?? "gemini",
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0 },
    isError: true,
    errorMessage: message,
  };
}

export async function completeGemini(req: ChatCompletionRequest): Promise<CompletionResult> {
  const { system, prompt } = buildPrompt(req.messages);
  // The gemini CLI has no dedicated system-prompt flag in headless mode, so we
  // prepend the system block to the transcript fed on stdin.
  const stdinPrompt = system ? `${system}\n\n${prompt}` : prompt;

  // `-p ""` keeps the CLI in non-interactive (headless) mode; the actual prompt
  // is appended from stdin. `-o json` gives a single parseable JSON object.
  // `--approval-mode plan` forces read-only (no file edits / tool side effects).
  const args = ["-p", "", "-o", "json", "--approval-mode", "plan"];
  if (req.model && /^gemini/i.test(req.model)) args.push("--model", req.model);

  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(geminiAgentConfig.command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("gemini -p timed out after 180s"));
      }, 180_000);
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
      child.stdin.write(stdinPrompt);
      child.stdin.end();
    },
  );

  // Try to parse JSON from stdout regardless of exit code: gemini emits a JSON
  // `error` object on stdout for some API failures while still exiting non-zero.
  let parsed: GeminiJsonResult | undefined;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed) as GeminiJsonResult;
    } catch {
      // Not JSON — fall through to error handling below.
    }
  }

  if (parsed?.error) {
    return errorResult(req, parsed.error.message ?? "gemini reported an error");
  }

  if (code !== 0 && !parsed?.response) {
    // Non-zero exit with no usable JSON response (e.g. unknown model id whose
    // stack went entirely to stderr).
    return errorResult(req, `gemini exited ${code}: ${stderr.trim() || trimmed || "unknown error"}`);
  }

  if (!parsed) {
    return errorResult(req, `parse gemini output failed; raw=${stdout.slice(0, 400)}`);
  }

  // Resolve the actual upstream model + token usage from stats.models.
  const modelEntry = parsed.stats?.models ? Object.entries(parsed.stats.models)[0] : undefined;
  const usedModel = modelEntry?.[0] ?? req.model ?? "gemini";
  const tokens = modelEntry?.[1]?.tokens;
  const promptTokens = tokens?.prompt ?? tokens?.input ?? 0;
  const completionTokens = tokens?.candidates ?? 0;

  const finishReason: FinishReason = "stop";
  return {
    text: parsed.response ?? "",
    model: usedModel,
    finishReason,
    usage: { promptTokens, completionTokens },
  };
}
