// Meridian Gateway — SSE streaming helpers (OpenAI-compatible chat chunks).
//
// Strictly additive. `streamChatCompletion` is invoked by v1-gateway.ts when a
// POST /v1/chat/completions carries `stream:true`. It writes `text/event-stream`
// and emits OpenAI `chat.completion.chunk` events, then a terminal
// `data: [DONE]`.
//
//   • claude  → real incremental token streaming via streamClaude().
//   • codex/gemini → their one-shots aren't cleanly incremental, so we run the
//     existing non-stream completion and emit the whole result as a single
//     `delta.content` chunk (still valid SSE; see the buffered-fallback caveat).
import type http from "node:http";
import { completeCodex, matchesCodex } from "./codex";
import { completeGemini, matchesGemini } from "./gemini";
import { streamClaude } from "./claude";
import type { ChatCompletionRequest, FinishReason } from "./shared";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "access-control-allow-origin": "*",
};

function chunkId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface ChunkChoiceDelta {
  role?: "assistant";
  content?: string;
}

/** Serialize one OpenAI chat.completion.chunk as an SSE `data:` line. */
function sseChunk(
  res: http.ServerResponse,
  id: string,
  created: number,
  model: string,
  delta: ChunkChoiceDelta,
  finishReason: FinishReason | null,
): void {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Stream a chat completion as OpenAI-compatible SSE. The caller has already
 * validated auth + the request body and has NOT written any headers yet.
 */
export async function streamChatCompletion(res: http.ServerResponse, req: ChatCompletionRequest): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  const id = chunkId();
  const created = Math.floor(Date.now() / 1000);
  // Provisional model label for the role chunk; refined on the final chunk for
  // claude (the CLI reports the resolved model id) but stable for codex/gemini.
  const requestedModel = req.model ?? "claude";

  // Opening chunk: announce the assistant role (OpenAI convention).
  sseChunk(res, id, created, requestedModel, { role: "assistant" }, null);

  // ── claude: real token streaming ──────────────────────────────────────────
  if (!matchesCodex(req.model) && !matchesGemini(req.model)) {
    let finalModel = requestedModel;
    let finalReason: FinishReason = "stop";
    let errored: Error | null = null;
    await streamClaude(req, {
      onDelta: (text) => {
        if (text) sseChunk(res, id, created, finalModel, { content: text }, null);
      },
      onDone: (info) => {
        finalModel = info.model;
        finalReason = info.finishReason;
      },
      onError: (err) => {
        errored = err;
      },
    });
    if (errored) {
      // Surface the failure inside the stream so the client sees something
      // actionable, then close cleanly.
      sseChunk(res, id, created, finalModel, { content: `\n[error: ${(errored as Error).message}]` }, null);
    }
    sseChunk(res, id, created, finalModel, {}, finalReason);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // ── codex / gemini: buffered fallback (single content chunk) ──────────────
  const out = await (matchesCodex(req.model) ? completeCodex(req) : completeGemini(req));
  if (out.isError) {
    sseChunk(res, id, created, out.model, { content: `[error: ${out.errorMessage ?? "upstream error"}]` }, null);
    sseChunk(res, id, created, out.model, {}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  if (out.text) sseChunk(res, id, created, out.model, { content: out.text }, null);
  sseChunk(res, id, created, out.model, {}, out.finishReason);
  res.write("data: [DONE]\n\n");
  res.end();
}
