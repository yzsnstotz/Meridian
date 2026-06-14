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
import { completeClaude, matchesClaude, CLAUDE_MODELS } from "./gateway/claude";
import { completeCodex, matchesCodex, CODEX_MODELS } from "./gateway/codex";
import { completeGemini, matchesGemini, GEMINI_MODELS } from "./gateway/gemini";
import type { ChatCompletionRequest, CompletionResult } from "./gateway/shared";
import { getProvidersStatus, startLogin, installProvider, ensureSpawnPath, renderLoginPage, type ProviderId } from "./gateway/login";

const PORT = Number(process.env.MERIDIAN_GATEWAY_PORT ?? process.env.PORT ?? 8789);
const HOST = process.env.MERIDIAN_GATEWAY_HOST ?? "127.0.0.1";

const MODEL_OWNER: Record<string, string> = {};
for (const m of CLAUDE_MODELS) MODEL_OWNER[m] = "anthropic-subscription";
for (const m of CODEX_MODELS) MODEL_OWNER[m] = "openai-subscription";
for (const m of GEMINI_MODELS) MODEL_OWNER[m] = "gemini-subscription";

// ── API key (generated, persisted, enforced, rotatable) ────────────────────────
//
// A real key gives non-technical users an OpenAI-shaped credential instead of
// the confusing "type anything" behaviour. It's loaded (or generated) on
// startup and held in memory; only POST /v1/chat/completions enforces it.
const KEY_DIR = join(homedir(), ".meridian-gateway");
const KEY_PATH = join(KEY_DIR, "gateway-key");

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

/** True when the request carries `Authorization: Bearer <current key>` exactly. */
function isAuthorized(request: http.IncomingMessage): boolean {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return !!m && m[1].trim() === apiKey;
}

/**
 * Models filtered by which backing CLI is currently signed in. Used by
 * /v1/models so a client's "refresh models" only ever lists usable models.
 */
function connectedModels(status: { claude: { connected: boolean }; codex: { connected: boolean }; gemini: { connected: boolean } }): Array<{ id: string; object: "model"; owned_by: string }> {
  const out: Array<{ id: string; object: "model"; owned_by: string }> = [];
  for (const id of Object.keys(MODEL_OWNER)) {
    let provider: ProviderId;
    if (matchesGemini(id)) provider = "gemini";
    else if (matchesCodex(id)) provider = "codex";
    else if (matchesClaude(id)) provider = "claude";
    else continue;
    if (!status[provider].connected) continue;
    out.push({ id, object: "model", owned_by: MODEL_OWNER[id] });
  }
  return out;
}

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
const INSTALL_ROUTE_RE = /^\/providers\/(claude|codex|gemini)\/install$/;

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
      // API key endpoints (open — the GUI reads/rotates from inside the iframe).
      if (request.method === "GET" && url.pathname === "/key") {
        return sendJson(response, 200, { key: apiKey });
      }
      if (request.method === "POST" && url.pathname === "/key/rotate") {
        return sendJson(response, 200, { key: rotateKey() });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        // Login-aware: only advertise models whose backing CLI is connected, so
        // a client's "refresh models" shows only what it can actually call.
        const status = await getProvidersStatus();
        return sendJson(response, 200, { object: "list", data: connectedModels(status) });
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        // The ONLY enforced route. /v1/models, /health, /, /providers/* stay open.
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
        const { status, body } = await handleChatCompletion(parsed);
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
  // eslint-disable-next-line no-console
  console.log(`[meridian-gateway] /v1 listening on http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[meridian-gateway] PATH augmented with npm global bin dir: ${npmBinDir ?? "(npm not resolvable)"}`);
});
