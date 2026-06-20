// Meridian Gateway — Anthropic-native `/v1/messages` adapter.
//
// Strictly additive. Accepts the Anthropic Messages request shape, maps it to
// the gateway's internal ChatCompletionRequest (reusing buildPrompt via the
// provider completions), and renders either a non-stream Anthropic message
// object or the Anthropic SSE event sequence.
//
//   non-stream → { id, type:"message", role:"assistant", model, content:[{type:"text",text}],
//                  stop_reason, stop_sequence, usage:{ input_tokens, output_tokens } }
//   stream     → message_start → content_block_start → content_block_delta* →
//                content_block_stop → message_delta → message_stop
//
//   • claude  → real incremental token streaming (content_block_delta per slice).
//   • codex/gemini/antigravity → buffered: run the one-shot, then emit the whole text as a
//     single content_block_delta (see the buffered-fallback caveat).
import type http from "node:http";
import { completeAntigravity, matchesAntigravity } from "./antigravity";
import { completeCodex, matchesCodex } from "./codex";
import { completeGemini, matchesGemini } from "./gemini";
import { streamClaude } from "./claude";
import { complete } from "./router";
import { contentToText, type ChatMessage, type ChatCompletionRequest, type CompletionResult, type FinishReason } from "./shared";

// ── Anthropic request shape ───────────────────────────────────────────────────
type AnthropicContentBlock = { type?: string; text?: string };
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}
export interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "access-control-allow-origin": "*",
};

function messageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Map an Anthropic stop/finish reason to the Anthropic wire `stop_reason`. */
function toAnthropicStop(reason: FinishReason): "end_turn" | "max_tokens" | "tool_use" {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

/** Normalize an Anthropic content value (string | block[]) to plain text. */
function anthropicContentToText(content: AnthropicMessage["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return contentToText(content as ChatMessage["content"]);
  return "";
}

/**
 * Translate an Anthropic Messages request into the gateway's internal
 * ChatCompletionRequest. The `system` field becomes a leading system message so
 * buildPrompt (inside each provider) folds it in exactly like /v1/chat.
 */
export function toChatRequest(body: AnthropicMessagesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  const system = anthropicContentToText(body.system).trim();
  if (system) messages.push({ role: "system", content: system });
  for (const m of body.messages ?? []) {
    messages.push({ role: m.role, content: anthropicContentToText(m.content) });
  }
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stream: body.stream,
  };
}

// ── Non-streaming response ────────────────────────────────────────────────────
export interface AnthropicResult {
  status: number;
  body: unknown;
  completion?: CompletionResult;
}

/** Build the non-stream Anthropic message object (or an Anthropic-shaped error). */
export async function handleAnthropicMessages(body: AnthropicMessagesRequest): Promise<AnthropicResult> {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "messages[] required" } },
    };
  }
  const out = await complete(toChatRequest(body));
  if (out.isError) {
    return {
      status: 502,
      body: { type: "error", error: { type: "api_error", message: out.errorMessage ?? "upstream error" } },
    };
  }
  return {
    status: 200,
    completion: out,
    body: {
      id: messageId(),
      type: "message",
      role: "assistant",
      model: out.model,
      content: [{ type: "text", text: out.text }],
      stop_reason: toAnthropicStop(out.finishReason),
      stop_sequence: null,
      usage: { input_tokens: out.usage.promptTokens, output_tokens: out.usage.completionTokens },
    },
  };
}

// ── Streaming response (Anthropic SSE event sequence) ─────────────────────────
function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Emit the Anthropic SSE event sequence for a /v1/messages request with
 * `stream:true`. Headers are written here; the caller must not have started the
 * response.
 */
export async function streamAnthropicMessages(res: http.ServerResponse, body: AnthropicMessagesRequest): Promise<CompletionResult | null> {
  res.writeHead(200, SSE_HEADERS);
  const id = messageId();
  const requestedModel = body.model ?? "claude";
  const chatReq = toChatRequest(body);

  // message_start — usage.output_tokens filled in on message_delta.
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  sse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  const emitTextDelta = (text: string): void => {
    if (!text) return;
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
  };

  let stopReason: "end_turn" | "max_tokens" | "tool_use" = "end_turn";
  let outputTokens = 0;
  let inputTokens = 0;
  let finalModel = requestedModel;
  let completion: CompletionResult | null = null;

  if (!matchesAntigravity(body.model) && !matchesCodex(body.model) && !matchesGemini(body.model)) {
    // claude: real token streaming
    let errored: Error | null = null;
    await streamClaude(chatReq, {
      onDelta: (text) => emitTextDelta(text),
      onDone: (info) => {
        stopReason = toAnthropicStop(info.finishReason);
        outputTokens = info.usage.completionTokens;
        inputTokens = info.usage.promptTokens;
        finalModel = info.model;
        completion = {
          text: "",
          model: info.model,
          finishReason: info.finishReason,
          usage: info.usage
        };
      },
      onError: (err) => {
        errored = err;
      },
    });
    if (errored) emitTextDelta(`\n[error: ${(errored as Error).message}]`);
  } else {
    // codex / gemini / antigravity: buffered single-block fallback
    const out = await (matchesAntigravity(body.model)
      ? completeAntigravity(chatReq)
      : matchesCodex(body.model)
        ? completeCodex(chatReq)
        : completeGemini(chatReq));
    finalModel = out.model;
    if (out.isError) {
      emitTextDelta(`[error: ${out.errorMessage ?? "upstream error"}]`);
    } else {
      emitTextDelta(out.text);
      stopReason = toAnthropicStop(out.finishReason);
      outputTokens = out.usage.completionTokens;
      inputTokens = out.usage.promptTokens;
      completion = out;
    }
  }

  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
  return completion ?? {
    text: "",
    model: finalModel,
    finishReason: stopReason === "max_tokens" ? "length" : stopReason === "tool_use" ? "tool_calls" : "stop",
    usage: { promptTokens: inputTokens, completionTokens: outputTokens },
    isError: inputTokens === 0 && outputTokens === 0,
    errorMessage: inputTokens === 0 && outputTokens === 0 ? "stream ended without usage" : undefined
  };
}
