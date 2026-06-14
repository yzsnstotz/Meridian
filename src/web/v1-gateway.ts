// Meridian Gateway — OpenAI-compatible `/v1` completion layer (P1 PoC).
//
// Strictly additive: a NEW, standalone HTTP entry-point. It does NOT touch the
// Telegram bot, the hub, the web GUI, or any existing mode. It drives the real,
// OAuth-logged-in coding-agent CLI in one-shot `--print` mode (category-b), so
// the user's *subscription* produces completions without API keys and without
// the banned direct-OAuth-proxy approach.
//
// P1 scope: Claude only, non-streaming. Codex + Gemini return 501 until P2.
import http from "node:http";
import { spawn } from "node:child_process";
import { claudeAgentConfig } from "../agents/claude";

const PORT = Number(process.env.MERIDIAN_GATEWAY_PORT ?? process.env.PORT ?? 8789);
const HOST = process.env.MERIDIAN_GATEWAY_HOST ?? "127.0.0.1";

type Role = "system" | "user" | "assistant" | "tool";
interface ChatMessage {
  role: Role;
  content: string | Array<{ type?: string; text?: string }>;
}
interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  return "";
}

/** Map OpenAI-style messages onto a single Claude `--print` invocation. */
function buildClaudePrompt(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => contentToText(m.content))
    .join("\n\n")
    .trim();
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "Assistant" : "Human"}: ${contentToText(m.content)}`)
    .join("\n\n");
  return { system, prompt: turns };
}

function mapStopReason(stop: string | null | undefined): string {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

interface ClaudePrintResult {
  result?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  session_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

/** Run the real `claude --print` CLI one-shot and return its parsed JSON. */
function runClaude(req: ChatCompletionRequest): Promise<ClaudePrintResult> {
  const { system, prompt } = buildClaudePrompt(req.messages);
  const args = ["--print", "--output-format", "json"];
  if (req.model && /^claude/i.test(req.model)) args.push("--model", req.model);
  if (system) args.push("--append-system-prompt", system);

  return new Promise((resolve, reject) => {
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
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ClaudePrintResult);
      } catch (e) {
        reject(new Error(`failed to parse claude output: ${(e as Error).message}; raw=${stdout.slice(0, 400)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function providerFor(model: string | undefined): "claude" | "codex" | "gemini" {
  const m = (model ?? "claude").toLowerCase();
  if (/^(gpt|o\d|codex|chatgpt)/.test(m)) return "codex";
  if (/^gemini/.test(m)) return "gemini";
  return "claude";
}

async function handleChatCompletion(req: ChatCompletionRequest): Promise<{ status: number; body: unknown }> {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { status: 400, body: { error: { message: "messages[] required", type: "invalid_request_error" } } };
  }
  if (req.stream) {
    return { status: 501, body: { error: { message: "streaming not implemented in P1 (P2)", type: "not_implemented" } } };
  }
  const provider = providerFor(req.model);
  if (provider !== "claude") {
    return {
      status: 501,
      body: { error: { message: `${provider} provider wired in P2; P1 supports claude only`, type: "not_implemented" } },
    };
  }

  const out = await runClaude(req);
  if (out.is_error) {
    return { status: 502, body: { error: { message: out.result ?? "claude reported an error", type: "upstream_error" } } };
  }
  const usedModel =
    out.modelUsage && Object.keys(out.modelUsage)[0]
      ? Object.keys(out.modelUsage)[0].replace(/\[.*\]$/, "")
      : (req.model ?? "claude");
  const inTok = out.usage?.input_tokens ?? 0;
  const outTok = out.usage?.output_tokens ?? 0;
  return {
    status: 200,
    body: {
      id: `chatcmpl-${out.session_id ?? Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: usedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: out.result ?? "" },
          finish_reason: mapStopReason(out.stop_reason),
        },
      ],
      usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
    },
  };
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (c) => (data += c));
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { status: "ok", providers: { claude: "ready", codex: "p2", gemini: "p2" } });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(response, 200, {
          object: "list",
          data: [
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
          ].map((id) => ({ id, object: "model", owned_by: "anthropic-subscription" })),
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
  console.log(`[meridian-gateway] /v1 listening on http://${HOST}:${PORT} (claude=ready, codex/gemini=P2)`);
});
