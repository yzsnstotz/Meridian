// Codex provider — one-shot `codex exec --json` (category-b).
// Drives the real `codex` CLI off the ChatGPT subscription in non-interactive
// headless mode and returns a normalized CompletionResult. Mirrors claude.ts.
//
// codex exec --json prints a JSONL event stream to stdout. The assistant text
// arrives in `item.completed` events whose `item.type === "agent_message"`;
// codex may run read-only shell commands first (skills / AGENTS.md), so there
// can be several non-message items — we take the LAST agent_message. Token
// usage arrives in the `turn.completed` event. Upstream failures (e.g. an
// unsupported model on a ChatGPT account) come back as `error` / `turn.failed`
// events while the process may still exit 0, so we inspect the stream, not just
// the exit code.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAgentConfig } from "../../agents/codex";
import { buildPrompt, type ChatCompletionRequest, type CompletionResult, type FinishReason } from "./shared";

// Only `gpt-5.5` is accepted on a ChatGPT subscription via `codex exec`
// (the -codex / -mini variants 400 with "not supported when using Codex with a
// ChatGPT account"). The CLI's own config.toml default is also gpt-5.5, so we
// deliberately do NOT forward a `-m` flag and let codex pick the subscription
// model — this list is what the gateway advertises / normalizes against.
export const CODEX_MODELS = ["gpt-5.5"];

const DEFAULT_CODEX_MODEL = "gpt-5.5";

export function matchesCodex(model: string | undefined): boolean {
  return !!model && /^(gpt|o\d|codex|chatgpt)/i.test(model);
}

interface CodexEvent {
  type?: string;
  item?: { id?: string; type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  message?: string;
  error?: { message?: string };
}

interface CodexParsed {
  text: string;
  promptTokens: number;
  completionTokens: number;
  errorMessage?: string;
}

/** Parse the JSONL event stream emitted by `codex exec --json`. */
function parseCodexStream(stdout: string): CodexParsed {
  let text = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let errorMessage: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: CodexEvent;
    try {
      evt = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue; // tolerate non-JSON noise interleaved on stdout
    }
    if (evt.type === "item.completed" && evt.item?.type === "agent_message" && typeof evt.item.text === "string") {
      // Last agent_message wins (codex may emit several items per turn).
      text = evt.item.text;
    } else if (evt.type === "turn.completed" && evt.usage) {
      promptTokens = evt.usage.input_tokens ?? 0;
      completionTokens = evt.usage.output_tokens ?? 0;
    } else if (evt.type === "error" || evt.type === "turn.failed") {
      errorMessage = evt.error?.message ?? evt.message ?? "codex reported an error";
    }
  }

  return { text, promptTokens, completionTokens, errorMessage };
}

function mapFinish(): FinishReason {
  // `codex exec --json` does not emit a stop reason; a completed turn is "stop".
  return "stop";
}

export async function completeCodex(req: ChatCompletionRequest): Promise<CompletionResult> {
  const { system, prompt } = buildPrompt(req.messages);
  // codex exec has no separate system channel in headless mode — fold the
  // system block into the head of the prompt transcript.
  const fullPrompt = system ? `System: ${system}\n\n${prompt}` : prompt;

  // Run from a throwaway dir with a read-only sandbox so the agent can never
  // modify the caller's files, and skip the git-repo trust gate that headless
  // exec cannot answer.
  const workDir = mkdtempSync(join(tmpdir(), "codex-gw-"));
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    workDir,
    "-", // read the prompt from stdin
  ];

  try {
    const parsed = await new Promise<CodexParsed>((resolve, reject) => {
      const child = spawn(codexAgentConfig.command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("codex exec timed out after 180s"));
      }, 180_000);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // codex exits non-zero on hard failures; soft (in-stream) failures may
        // still exit 0 and are surfaced via parsed.errorMessage below.
        if (code !== 0) {
          const result = parseCodexStream(stdout);
          if (result.errorMessage || result.text) return resolve(result);
          return reject(new Error(`codex exec exited ${code}: ${stderr.trim() || stdout.trim().slice(0, 400)}`));
        }
        resolve(parseCodexStream(stdout));
      });
      child.stdin.write(fullPrompt);
      child.stdin.end();
    });

    const model = req.model && matchesCodex(req.model) ? req.model : DEFAULT_CODEX_MODEL;
    const isError = !!parsed.errorMessage;
    return {
      text: isError ? "" : parsed.text,
      model,
      finishReason: mapFinish(),
      usage: { promptTokens: parsed.promptTokens, completionTokens: parsed.completionTokens },
      isError: isError || undefined,
      errorMessage: parsed.errorMessage,
    };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of the throwaway working directory
    }
  }
}
