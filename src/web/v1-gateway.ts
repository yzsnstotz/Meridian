// Meridian Gateway — OpenAI-compatible `/v1` completion layer.
//
// Strictly additive, standalone HTTP entry-point. Does NOT touch the Telegram
// bot, hub, web GUI, or any existing mode. Each provider drives the real,
// OAuth-logged-in coding-agent CLI in one-shot mode (category-b), so the user's
// *subscription* serves completions without API keys and without the banned
// direct-OAuth-proxy approach.
import http from "node:http";
import { completeClaude, matchesClaude, CLAUDE_MODELS } from "./gateway/claude";
import { completeCodex, matchesCodex, CODEX_MODELS } from "./gateway/codex";
import { completeGemini, matchesGemini, GEMINI_MODELS } from "./gateway/gemini";
import type { ChatCompletionRequest, CompletionResult } from "./gateway/shared";
import { getProvidersStatus, startLogin, renderLoginPage, type ProviderId } from "./gateway/login";

const PORT = Number(process.env.MERIDIAN_GATEWAY_PORT ?? process.env.PORT ?? 8789);
const HOST = process.env.MERIDIAN_GATEWAY_HOST ?? "127.0.0.1";

const MODEL_OWNER: Record<string, string> = {};
for (const m of CLAUDE_MODELS) MODEL_OWNER[m] = "anthropic-subscription";
for (const m of CODEX_MODELS) MODEL_OWNER[m] = "openai-subscription";
for (const m of GEMINI_MODELS) MODEL_OWNER[m] = "gemini-subscription";

function complete(req: ChatCompletionRequest): Promise<CompletionResult> {
  if (matchesCodex(req.model)) return completeCodex(req);
  if (matchesGemini(req.model)) return completeGemini(req);
  return completeClaude(req); // default + all claude*
}

async function handleChatCompletion(req: ChatCompletionRequest): Promise<{ status: number; body: unknown }> {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { status: 400, body: { error: { message: "messages[] required", type: "invalid_request_error" } } };
  }
  if (req.stream) {
    return { status: 501, body: { error: { message: "streaming not implemented yet (P2)", type: "not_implemented" } } };
  }
  const out = await complete(req);
  if (out.isError) {
    return { status: 502, body: { error: { message: out.errorMessage ?? "upstream error", type: "upstream_error" } } };
  }
  return {
    status: 200,
    body: {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: out.model,
      choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: out.finishReason }],
      usage: {
        prompt_tokens: out.usage.promptTokens,
        completion_tokens: out.usage.completionTokens,
        total_tokens: out.usage.promptTokens + out.usage.completionTokens,
      },
    },
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS });
  res.end(html);
}

/** The actual bound port (handles ephemeral `PORT=0`), falling back to PORT. */
function boundPort(): number {
  const addr = server.address();
  return addr && typeof addr === "object" ? addr.port : PORT;
}

const LOGIN_ROUTE_RE = /^\/providers\/(claude|codex|gemini)\/login$/;

const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, CORS_HEADERS);
        return response.end();
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { status: "ok", providers: ["claude", "codex", "gemini"] });
      }
      // ── Login / onboarding GUI (strictly additive; does not touch /v1) ──────
      if (request.method === "GET" && url.pathname === "/") {
        return sendHtml(response, 200, renderLoginPage(boundPort()));
      }
      if (request.method === "GET" && url.pathname === "/providers/status") {
        return sendJson(response, 200, await getProvidersStatus());
      }
      {
        const m = request.method === "POST" ? LOGIN_ROUTE_RE.exec(url.pathname) : null;
        if (m) {
          return sendJson(response, 200, await startLogin(m[1] as ProviderId));
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(response, 200, {
          object: "list",
          data: Object.keys(MODEL_OWNER).map((id) => ({ id, object: "model", owned_by: MODEL_OWNER[id] })),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const raw = await readBody(request);
        let parsed: ChatCompletionRequest;
        try {
          parsed = JSON.parse(raw) as ChatCompletionRequest;
        } catch {
          return sendJson(response, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
        }
        const { status, body } = await handleChatCompletion(parsed);
        return sendJson(response, status, body);
      }
      return sendJson(response, 404, { error: { message: `no route ${request.method} ${url.pathname}`, type: "not_found" } });
    } catch (err) {
      return sendJson(response, 500, { error: { message: (err as Error).message, type: "internal_error" } });
    }
  })();
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[meridian-gateway] /v1 listening on http://${HOST}:${PORT}`);
});
