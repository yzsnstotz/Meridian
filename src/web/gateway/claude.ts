// Claude provider — one-shot `claude --print --output-format json` (category-b)
// plus a real token-streaming variant (`--output-format stream-json`).
// Validated in P1 against the real Claude subscription.
import { spawn } from "node:child_process";
import { claudeAgentConfig } from "../../agents/claude";
import { buildPrompt, type ChatCompletionRequest, type CompletionResult, type FinishReason } from "./shared";

// Kept for old imports only. Gateway model advertisement is live via
// ProviderModelCatalog rather than hardcoded Claude CLI guesses.
export const CLAUDE_MODELS: string[] = [];

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

// ── Real token streaming via `claude --print --output-format stream-json` ──────
//
// The CLI emits one JSON object per line. The shapes we care about:
//   { "type": "assistant", "message": { "content": [ { "type":"text","text":"…" } ] } }
//       → an assistant turn. With `--include-partial-messages` these arrive as
//         incremental partial chunks; we diff against what we've already emitted
//         so the consumer receives only the *new* text each time.
//   { "type": "stream_event", "event": { "type":"content_block_delta",
//       "delta": { "type":"text_delta","text":"…" } } }
//       → an incremental text delta (partial-message mode). Forwarded as-is.
//   { "type": "result", "result":"…", "stop_reason":…, "usage":{…},
//       "modelUsage":{…} } → the terminal event (finish reason + usage).
//
// We tolerate any extra event types (system/init, tool_use, etc.) by ignoring
// them, and we tolerate partial lines by buffering until a newline arrives.

export interface ClaudeStreamCallbacks {
  /** Called with each *incremental* slice of assistant text. */
  onDelta: (text: string) => void;
  /** Called once at the end with the finish reason + resolved model + usage. */
  onDone: (info: {
    model: string;
    finishReason: FinishReason;
    usage: { promptTokens: number; completionTokens: number };
  }) => void;
  /** Called on a hard failure (spawn error, non-zero exit, in-stream error). */
  onError: (err: Error) => void;
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  // stream_event partial-message shape
  event?: { type?: string; delta?: { type?: string; text?: string } };
  // result (terminal) shape — same fields as ClaudePrintResult
  result?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

/** Pull the concatenated text out of an assistant message's content blocks. */
function assistantText(msg: ClaudeStreamEvent["message"]): string {
  if (!msg?.content || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * Drive `claude --print --output-format stream-json` and surface assistant text
 * as incremental deltas. Returns a promise that resolves when the child exits.
 * Errors are reported through `onError` (the promise still resolves so the HTTP
 * layer can close the SSE stream cleanly).
 */
export function streamClaude(req: ChatCompletionRequest, cb: ClaudeStreamCallbacks): Promise<void> {
  const { system, prompt } = buildPrompt(req.messages);
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (req.model && /^claude/i.test(req.model)) args.push("--model", req.model);
  if (system) args.push("--append-system-prompt", system);

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let child;
    try {
      child = spawn(claudeAgentConfig.command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      cb.onError(e as Error);
      finish();
      return;
    }

    let buf = "";
    let stderr = "";
    // Cumulative assistant text we've already forwarded as deltas, so that a
    // full assistant snapshot (non-partial mode) only emits the new tail.
    let emitted = "";
    let doneEmitted = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cb.onError(new Error("claude stream timed out after 180s"));
      finish();
    }, 180_000);

    const emitDelta = (full: string): void => {
      if (full.length > emitted.length && full.startsWith(emitted)) {
        cb.onDelta(full.slice(emitted.length));
        emitted = full;
      } else if (full && full !== emitted && !full.startsWith(emitted)) {
        // Non-monotonic snapshot (rare): emit the whole thing and reset.
        cb.onDelta(full);
        emitted = full;
      }
    };

    const handleEvent = (evt: ClaudeStreamEvent): void => {
      // Incremental text delta (partial-message mode).
      if (
        evt.type === "stream_event" &&
        evt.event?.type === "content_block_delta" &&
        evt.event.delta?.type === "text_delta" &&
        typeof evt.event.delta.text === "string"
      ) {
        cb.onDelta(evt.event.delta.text);
        emitted += evt.event.delta.text;
        return;
      }
      // Full assistant message snapshot — diff against what we've emitted.
      if (evt.type === "assistant") {
        emitDelta(assistantText(evt.message));
        return;
      }
      // Terminal result event.
      if (evt.type === "result") {
        if (evt.is_error) {
          cb.onError(new Error(evt.result ?? "claude reported an error"));
          return;
        }
        // Catch any trailing text the deltas missed (defensive).
        if (typeof evt.result === "string") emitDelta(evt.result);
        const usedModel =
          evt.modelUsage && Object.keys(evt.modelUsage)[0]
            ? Object.keys(evt.modelUsage)[0].replace(/\[.*\]$/, "")
            : (req.model ?? "claude");
        doneEmitted = true;
        cb.onDone({
          model: usedModel,
          finishReason: mapStop(evt.stop_reason),
          usage: {
            promptTokens: evt.usage?.input_tokens ?? 0,
            completionTokens: evt.usage?.output_tokens ?? 0,
          },
        });
      }
    };

    const drain = (): void => {
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt: ClaudeStreamEvent;
        try {
          evt = JSON.parse(line) as ClaudeStreamEvent;
        } catch {
          continue; // tolerate non-JSON noise
        }
        handleEvent(evt);
      }
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      drain();
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      cb.onError(err);
      finish();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Flush any trailing buffered line without a final newline.
      if (buf.trim()) {
        buf += "\n";
        drain();
      }
      if (code !== 0 && !doneEmitted) {
        cb.onError(new Error(`claude stream exited ${code}: ${stderr.trim() || "unknown error"}`));
      } else if (!doneEmitted) {
        // Stream ended without a result event; synthesize a stop.
        cb.onDone({
          model: req.model ?? "claude",
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0 },
        });
      }
      finish();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
