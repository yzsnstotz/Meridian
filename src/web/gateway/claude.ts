// Claude provider — one-shot `claude --print --output-format json` (category-b).
// Validated in P1 against the real Claude subscription.
import { spawn } from "node:child_process";
import { claudeAgentConfig } from "../../agents/claude";
import { buildPrompt, type ChatCompletionRequest, type CompletionResult, type FinishReason } from "./shared";

export const CLAUDE_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

export function matchesClaude(model: string | undefined): boolean {
  return !model || /^claude/i.test(model);
}

interface ClaudePrintResult {
  result?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  session_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

function mapStop(stop: string | null | undefined): FinishReason {
  if (stop === "max_tokens") return "length";
  if (stop === "tool_use") return "tool_calls";
  return "stop";
}

export async function completeClaude(req: ChatCompletionRequest): Promise<CompletionResult> {
  const { system, prompt } = buildPrompt(req.messages);
  const args = ["--print", "--output-format", "json"];
  if (req.model && /^claude/i.test(req.model)) args.push("--model", req.model);
  if (system) args.push("--append-system-prompt", system);

  const out = await new Promise<ClaudePrintResult>((resolve, reject) => {
    const child = spawn(claudeAgentConfig.command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude --print timed out after 180s"));
    }, 180_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
      try {
        resolve(JSON.parse(stdout) as ClaudePrintResult);
      } catch (e) {
        reject(new Error(`parse claude output failed: ${(e as Error).message}; raw=${stdout.slice(0, 400)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });

  const usedModel =
    out.modelUsage && Object.keys(out.modelUsage)[0]
      ? Object.keys(out.modelUsage)[0].replace(/\[.*\]$/, "")
      : (req.model ?? "claude");
  return {
    text: out.result ?? "",
    model: usedModel,
    finishReason: mapStop(out.stop_reason),
    usage: { promptTokens: out.usage?.input_tokens ?? 0, completionTokens: out.usage?.output_tokens ?? 0 },
    isError: out.is_error,
    errorMessage: out.is_error ? (out.result ?? "claude reported an error") : undefined,
  };
}
