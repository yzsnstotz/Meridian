// Meridian Gateway — OpenAI-compatible `/v1` completion layer.
//
// Strictly additive, standalone HTTP entry-point. Does NOT touch the Telegram
// bot, hub, web GUI, or any existing mode. Each provider drives the real,
// OAuth-logged-in coding-agent CLI in one-shot mode (category-b), so the user's
// *subscription* serves completions without API keys and without the banned
// direct-OAuth-proxy approach.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderModelCatalog } from "../shared/model-catalog";
import { matchesClaude } from "./gateway/claude";
import { matchesCodex } from "./gateway/codex";
import { matchesGemini } from "./gateway/gemini";
import type { ChatCompletionRequest, CompletionResult } from "./gateway/shared";
import { normalizeModel } from "./gateway/shared";
import { complete, providerForModel } from "./gateway/router";
import { streamChatCompletion } from "./gateway/streaming";
import {
  handleAnthropicMessages,
  streamAnthropicMessages,
  type AnthropicMessagesRequest,
} from "./gateway/anthropic";
import { getProvidersStatus, startLogin, installProvider, logoutProvider, ensureSpawnPath, renderLoginPage, type ProviderId } from "./gateway/login";
import { listGatewayModels, ownerForProvider } from "./gateway/model-list";
import { runGatewayDirectTest } from "./gateway/direct-test";
import { GatewayUsageLedger, type GatewayUsageSurface } from "./gateway/usage-ledger";

const PORT = Number(process.env.MERIDIAN_GATEWAY_PORT ?? process.env.PORT ?? 8789);
const HOST = process.env.MERIDIAN_GATEWAY_HOST ?? "127.0.0.1";

const gatewayModelCatalog = new ProviderModelCatalog();

// ── API key (generated, persisted, enforced, rotatable) ────────────────────────
//
// A real key gives non-technical users an OpenAI-shaped credential instead of
// the confusing "type anything" behaviour. It's loaded (or generated) on
// startup and held in memory; only POST /v1/chat/completions enforces it.
const KEY_DIR = join(homedir(), ".meridian-gateway");
const KEY_PATH = join(KEY_DIR, "gateway-key");
const USAGE_PATH = join(KEY_DIR, "usage.jsonl");
const usageLedger = new GatewayUsageLedger(USAGE_PATH);

/** Generate a fresh key in the `mgw-` + 32-hex-char format. */
function generateKey(): string {
  return `mgw-${randomBytes(16).toString("hex")}`;
}

/** Persist the key to $HOME/.meridian-gateway/gateway-key (dir 0700, file 0600). */
function persistKey(key: string): void {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEY_PATH, `${key}\n`, { mode: 0o600 });
}

/** Load the on-disk key, or generate + persist a new one if absent/empty. */
function loadOrCreateKey(): string {
  if (existsSync(KEY_PATH)) {
    try {
      const existing = readFileSync(KEY_PATH, "utf8").trim();
      if (existing) return existing;
    } catch {
      // unreadable → fall through and regenerate
    }
  }
  const fresh = generateKey();
  persistKey(fresh);
  return fresh;
}

let apiKey = loadOrCreateKey();

/** Regenerate + persist a new key, replacing the in-memory one. */
function rotateKey(): string {
  apiKey = generateKey();
  persistKey(apiKey);
  return apiKey;
}

/**
 * True when the request carries the current API key. OpenAI clients send it as
 * `Authorization: Bearer <key>`; Anthropic clients (and anything hitting the
 * /v1/messages surface) send it as `x-api-key: <key>`. Accept either so both
 * wire formats authenticate against the same generated key.
 */
function isAuthorized(request: http.IncomingMessage): boolean {
  const header = request.headers["authorization"];
  if (typeof header === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m && m[1].trim() === apiKey) return true;
  }
  const xApiKey = request.headers["x-api-key"];
  return typeof xApiKey === "string" && xApiKey.trim() === apiKey;
}

async function recordCompletionUsage(
  surface: GatewayUsageSurface,
  completion: CompletionResult | null | undefined,
  startedAt: number,
  providerOverride?: ProviderId
): Promise<void> {
  if (!completion || completion.isError) return;
  try {
    await usageLedger.record({
      provider: providerOverride ?? providerForModel(completion.model),
      model: completion.model,
      surface,
      promptTokens: completion.usage.promptTokens,
      completionTokens: completion.usage.completionTokens,
      durationMs: Date.now() - startedAt
    });
  } catch {
    // Local usage history should never make a successful model call fail.
  }
}

async function handleChatCompletion(req: ChatCompletionRequest): Promise<{ status: number; body: unknown; completion?: CompletionResult }> {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { status: 400, body: { error: { message: "messages[] required", type: "invalid_request_error" } } };
  }
  // Streaming (req.stream === true) is handled directly in the route below via
  // streamChatCompletion(); this non-stream path is unchanged.
  const out = await complete(req);
  if (out.isError) {
    return { status: 502, body: { error: { message: out.errorMessage ?? "upstream error", type: "upstream_error" } } };
  }
  return {
    status: 200,
    completion: out,
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
const INSTALL_ROUTE_RE = /^\/providers\/(claude|codex|gemini)\/install$/;
const LOGOUT_ROUTE_RE = /^\/providers\/(claude|codex|gemini)\/logout$/;
const TEST_ROUTE_RE = /^\/providers\/(claude|codex|gemini)\/test$/;
const MODEL_RETRIEVE_RE = /^\/v1\/models\/(.+)$/;

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
      {
        // One-click CLI install (npm install -g <pkg>) so a non-technical user
        // never needs a terminal. Slow by nature; installProvider has its own
        // generous timeout. On failure it returns the command for a GUI fallback.
        const m = request.method === "POST" ? INSTALL_ROUTE_RE.exec(url.pathname) : null;
        if (m) {
          return sendJson(response, 200, await installProvider(m[1] as ProviderId));
        }
      }
      {
        const m = request.method === "POST" ? LOGOUT_ROUTE_RE.exec(url.pathname) : null;
        if (m) {
          const result = await logoutProvider(m[1] as ProviderId);
          return sendJson(response, result.ok ? 200 : 500, result);
        }
      }
      {
        const m = request.method === "POST" ? TEST_ROUTE_RE.exec(url.pathname) : null;
        if (m) {
          const startedAt = Date.now();
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            return sendJson(response, 400, { ok: false, error: "invalid JSON body" });
          }
          const provider = m[1] as ProviderId;
          const result = await runGatewayDirectTest(provider, parsed && typeof parsed === "object" ? parsed : {});
          if (result.ok && result.usage) {
            await usageLedger.record({
              provider,
              model: result.model || provider,
              surface: "direct-test",
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
              durationMs: Date.now() - startedAt
            }).catch(() => undefined);
          }
          return sendJson(response, result.ok ? 200 : 502, result);
        }
      }
      // API key endpoints (open — the GUI reads/rotates from inside the iframe).
      if (request.method === "GET" && url.pathname === "/key") {
        return sendJson(response, 200, { key: apiKey });
      }
      if (request.method === "POST" && url.pathname === "/key/rotate") {
        return sendJson(response, 200, { key: rotateKey() });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const status = await getProvidersStatus();
        return sendJson(response, 200, await listGatewayModels(status, gatewayModelCatalog));
      }
      if (request.method === "GET" && url.pathname === "/usage") {
        const rawLimit = Number(url.searchParams.get("limit") ?? 200);
        return sendJson(response, 200, usageLedger.snapshot({ limit: Number.isFinite(rawLimit) ? rawLimit : 200 }));
      }
      {
        // OpenAI "retrieve model" — GET /v1/models/{id}. clawso's custom-provider
        // "Test connection" probe (check_llm_provider_health → probe_openai_model)
        // does GET {base}/v1/models/{model} with the stored Bearer key; without
        // this route it 404s and the connection check fails. Key-enforced so a
        // wrong/empty key surfaces as 401 (clawso maps 401/403 → "invalid
        // credential", 2xx → healthy). The id is normalized so a namespaced
        // `custom-meridian-gateway/gpt-5.5` resolves to the bare model.
        const m = request.method === "GET" ? MODEL_RETRIEVE_RE.exec(url.pathname) : null;
        if (m) {
          if (!isAuthorized(request)) {
            return sendJson(response, 401, {
              error: { message: "invalid API key", type: "authentication_error" },
            });
          }
          const id = normalizeModel(decodeURIComponent(m[1]));
          if (!id) {
            return sendJson(response, 404, {
              error: { message: "model id is required", type: "not_found" },
            });
          }
          // Health-check semantics: a valid key + a reachable gateway is 200.
          // clawso's "Test connection" probes reachability + credential, NOT
          // model availability — so we deliberately do NOT 404 a model whose
          // CLI isn't signed in yet (login state shows in the GUI, and the
          // login-aware /v1/models list already filters the catalog). The CLI
          // validates the model id at completion time. Owner is best-effort
          // from the routing matchers.
          const owner =
            matchesGemini(id)
              ? "gemini-subscription"
              : matchesCodex(id)
                ? "openai-subscription"
                : matchesClaude(id)
                  ? "anthropic-subscription"
                  : ownerForProvider("claude");
          return sendJson(response, 200, { id, object: "model", owned_by: owner });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        // Key-enforced route. /v1/models, /health, /, /providers/* stay open.
        if (!isAuthorized(request)) {
          return sendJson(response, 401, {
            error: { message: "invalid API key", type: "authentication_error" },
          });
        }
        const raw = await readBody(request);
        let parsed: ChatCompletionRequest;
        try {
          parsed = JSON.parse(raw) as ChatCompletionRequest;
        } catch {
          return sendJson(response, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
        }
        // Strip any `<providerId>/` namespace clawso prepends so the request
        // routes to the right CLI instead of misrouting to the Claude default.
        parsed.model = normalizeModel(parsed.model);
        // Streaming path: emit OpenAI-compatible SSE chunks. Validate the body
        // shape first so a bad request still gets a clean JSON 400 (not SSE).
        if (parsed.stream) {
          if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
            return sendJson(response, 400, {
              error: { message: "messages[] required", type: "invalid_request_error" },
            });
          }
          const startedAt = Date.now();
          const completion = await streamChatCompletion(response, parsed);
          await recordCompletionUsage("openai-chat-stream", completion, startedAt);
          return;
        }
        const startedAt = Date.now();
        const { status, body, completion } = await handleChatCompletion(parsed);
        await recordCompletionUsage("openai-chat", completion, startedAt);
        return sendJson(response, status, body);
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        // Anthropic-native messages endpoint. Key-enforced, same as /v1/chat.
        if (!isAuthorized(request)) {
          return sendJson(response, 401, {
            error: { message: "invalid API key", type: "authentication_error" },
          });
        }
        const raw = await readBody(request);
        let parsed: AnthropicMessagesRequest;
        try {
          parsed = JSON.parse(raw) as AnthropicMessagesRequest;
        } catch {
          return sendJson(response, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: "invalid JSON body" },
          });
        }
        // Same namespace-strip as /v1/chat/completions.
        parsed.model = normalizeModel(parsed.model);
        if (parsed.stream) {
          if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
            return sendJson(response, 400, {
              type: "error",
              error: { type: "invalid_request_error", message: "messages[] required" },
            });
          }
          const startedAt = Date.now();
          const completion = await streamAnthropicMessages(response, parsed);
          await recordCompletionUsage("anthropic-messages-stream", completion, startedAt);
          return;
        }
        const startedAt = Date.now();
        const { status, body, completion } = await handleAnthropicMessages(parsed);
        await recordCompletionUsage("anthropic-messages", completion, startedAt);
        return sendJson(response, status, body);
      }
      return sendJson(response, 404, { error: { message: `no route ${request.method} ${url.pathname}`, type: "not_found" } });
    } catch (err) {
      return sendJson(response, 500, { error: { message: (err as Error).message, type: "internal_error" } });
    }
  })();
});

// Resolve + prepend the npm global bin dir (plus common dirs) to PATH ONCE at
// startup so every subsequent spawn — status detection, login, /v1 completions,
// and freshly `npm install -g`'d CLIs — can find its binary. (The openclaw
// spawn-PATH lesson: a launcher/GUI-inherited PATH often omits the npm global
// bin dir, leaving just-installed CLIs unspawnable.)
const npmBinDir = ensureSpawnPath();

server.listen(PORT, HOST, () => {
  console.log(`[meridian-gateway] /v1 listening on http://${HOST}:${PORT}`);
  console.log(`[meridian-gateway] PATH augmented with npm global bin dir: ${npmBinDir ?? "(npm not resolvable)"}`);
});
