// Meridian Gateway — login / onboarding GUI (strictly additive).
//
// Adds a small, self-contained web UI plus three JSON endpoints on the SAME
// gateway HTTP server that serves `/v1`. Lets a non-technical user sign in to
// their Claude / ChatGPT / Gemini subscriptions (which back the `/v1` routes)
// without a terminal, and copy the OpenAI-compatible base URL.
//
// Routes added here (all wired from v1-gateway.ts):
//   GET  /                       → the GUI HTML
//   GET  /providers/status       → { claude, codex, gemini } connection state
//   POST /providers/:id/login    → kick off (or describe) sign-in for one CLI
//
// NOTHING here touches /health or /v1/*. Detection is read-only (status
// commands + credential files); only POST /providers/:id/login spawns a CLI,
// and it does so detached so the browser flow never blocks the gateway.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeAgentConfig } from "../../agents/claude";
import { codexAgentConfig } from "../../agents/codex";
import { geminiAgentConfig } from "../../agents/gemini";

export type ProviderId = "claude" | "codex" | "gemini";

export interface ProviderState {
  connected: boolean;
  detail?: string;
}

export interface ProvidersStatus {
  claude: ProviderState;
  codex: ProviderState;
  gemini: ProviderState;
}

export interface LoginResult {
  started?: boolean;
  manual?: boolean;
  url?: string;
  hint?: string;
}

/** Run a short-lived command and resolve its exit code + captured output. */
function runProbe(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    let child: ReturnType<typeof spawn>;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      resolve({ code, out });
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // command not found / not spawnable → treat as a failed probe
      resolve({ code: null, out: "" });
      return;
    }
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
}

// ── Per-provider detection ──────────────────────────────────────────────────

/**
 * claude: `claude auth status` (exit 0 + signed-in signal). Modern CLI prints
 * a JSON object ({ loggedIn, email, subscriptionType, ... }); older builds
 * print a human line. Fall back to ~/.claude/.credentials.json existing.
 */
async function detectClaude(): Promise<ProviderState> {
  const { code, out } = await runProbe(claudeAgentConfig.command, ["auth", "status"]);
  const text = out.trim();
  if (code === 0 && text) {
    try {
      const j = JSON.parse(text) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
      if (j.loggedIn) {
        const plan = j.subscriptionType ? `${j.subscriptionType} plan` : undefined;
        const detail = [j.email, plan].filter(Boolean).join(" · ") || "Signed in";
        return { connected: true, detail };
      }
    } catch {
      // non-JSON output: look for an affirmative signal
      if (/logged ?in|signed ?in|authenticated/i.test(text) && !/not /i.test(text)) {
        return { connected: true, detail: text.split("\n")[0]?.slice(0, 80) };
      }
    }
  }
  // Fallback: credentials file present means a prior successful OAuth login.
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) {
    return { connected: true, detail: "Signed in" };
  }
  return { connected: false };
}

/** codex: `codex login status` → "Logged in ..." means connected. */
async function detectCodex(): Promise<ProviderState> {
  const { out } = await runProbe(codexAgentConfig.command, ["login", "status"]);
  const line = out.trim().split("\n").find((l) => l.trim().length > 0)?.trim();
  if (line && /logged in/i.test(line) && !/not logged in/i.test(line)) {
    return { connected: true, detail: line };
  }
  return { connected: false };
}

/**
 * gemini: no status command — read ~/.gemini/oauth_creds.json. Connected when
 * it parses AND (expiry_date is in the future OR a refresh_token is present, so
 * an expired access token that can be silently refreshed still counts).
 */
async function detectGemini(): Promise<ProviderState> {
  const credPath = join(homedir(), ".gemini", "oauth_creds.json");
  if (!existsSync(credPath)) return { connected: false };
  try {
    const creds = JSON.parse(readFileSync(credPath, "utf8")) as {
      expiry_date?: number;
      refresh_token?: string;
    };
    const future = typeof creds.expiry_date === "number" && creds.expiry_date > Date.now();
    const refreshable = typeof creds.refresh_token === "string" && creds.refresh_token.length > 0;
    if (future || refreshable) {
      const detail = future
        ? `Authorized · token valid until ${new Date(creds.expiry_date as number).toLocaleString()}`
        : "Authorized · auto-refreshing";
      return { connected: true, detail };
    }
    return { connected: false };
  } catch {
    return { connected: false };
  }
}

export async function getProvidersStatus(): Promise<ProvidersStatus> {
  const [claude, codex, gemini] = await Promise.all([detectClaude(), detectCodex(), detectGemini()]);
  return { claude, codex, gemini };
}

// ── Login kick-off ───────────────────────────────────────────────────────────

const URL_RE = /(https?:\/\/[^\s'"]+)/;

/**
 * Spawn an interactive sign-in CLI detached so it survives this request and
 * opens the user's browser. Listen ~3s for any printed auth URL, then detach.
 */
function startBrowserLogin(command: string, args: string[]): Promise<LoginResult> {
  return new Promise((resolve) => {
    let url: string | undefined;
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      try {
        child.unref();
      } catch {
        // ignore
      }
      resolve({ started: true, url });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch {
      resolve({ started: false });
      return;
    }
    const scan = (chunk: Buffer): void => {
      const m = URL_RE.exec(chunk.toString());
      if (m && !url) {
        url = m[1];
        // Got the URL — return promptly so the GUI can show / open it.
        finish();
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", () => finish());
    // Detach after a short capture window even if no URL was printed (the CLI
    // may open the browser itself without echoing the URL).
    setTimeout(finish, 3000);
  });
}

export async function startLogin(id: ProviderId): Promise<LoginResult> {
  if (id === "claude") {
    return startBrowserLogin(claudeAgentConfig.command, ["auth", "login"]);
  }
  if (id === "codex") {
    return startBrowserLogin(codexAgentConfig.command, ["login"]);
  }
  // gemini has no headless login command.
  return {
    manual: true,
    hint: `Run \`${geminiAgentConfig.command}\` once and choose ‘Login with Google’ to connect.`,
  };
}

// ── GUI ───────────────────────────────────────────────────────────────────────

/**
 * The single self-contained onboarding page. All CSS + JS is inlined so it
 * works offline inside an iframe with no external/CDN dependencies. `port` is
 * the actual bound port so the displayed endpoint is correct.
 *
 * Wording is provider-neutral: this is described only as a local
 * OpenAI-compatible endpoint, usable by any client.
 */
export function renderLoginPage(port: number): string {
  const endpoint = `http://127.0.0.1:${port}/v1`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Meridian Gateway</title>
<style>
  :root {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --panel-2: #fbfcfd;
    --border: #e6e8ec;
    --border-strong: #d6d9df;
    --text: #1d2127;
    --muted: #646b76;
    --faint: #8a909a;
    --accent: #4f46e5;
    --ok: #1aa260;
    --ok-bg: rgba(26,162,96,.12);
    --off: #aab0bb;
    --shadow: 0 1px 2px rgba(16,18,22,.04), 0 8px 24px rgba(16,18,22,.06);
    --shadow-sm: 0 1px 2px rgba(16,18,22,.05);
    --radius: 16px;
    --radius-sm: 11px;
    --claude: #d97757;
    --codex: #10a37f;
    --gemini: #4285f4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --panel: #181b21;
      --panel-2: #1d2128;
      --border: #272b33;
      --border-strong: #333944;
      --text: #e8eaed;
      --muted: #9aa1ac;
      --faint: #6b7280;
      --accent: #8b8bff;
      --ok: #36d399;
      --ok-bg: rgba(54,211,153,.14);
      --off: #4a515c;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 32px rgba(0,0,0,.4);
      --shadow-sm: 0 1px 2px rgba(0,0,0,.3);
      --claude: #e08a6b;
      --codex: #2bbf99;
      --gemini: #5b9bff;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    padding: 28px 20px 56px;
  }
  .wrap { max-width: 660px; margin: 0 auto; }

  header.top {
    display: flex; align-items: center; gap: 12px;
    margin: 4px 2px 26px;
  }
  .logo {
    width: 38px; height: 38px; border-radius: 11px; flex: none;
    background: linear-gradient(135deg, var(--accent), #8b5cf6);
    display: grid; place-items: center;
    box-shadow: var(--shadow-sm);
  }
  .logo svg { width: 21px; height: 21px; }
  .title h1 { font-size: 19px; font-weight: 680; margin: 0; letter-spacing: -.01em; }
  .title p { margin: 1px 0 0; font-size: 12.5px; color: var(--faint); }
  .pill {
    margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; font-weight: 600; color: var(--ok);
    background: var(--ok-bg); border-radius: 999px; padding: 6px 12px 6px 10px;
    white-space: nowrap;
  }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); position: relative; }
  .pill .dot::after {
    content: ""; position: absolute; inset: -4px; border-radius: 50%;
    background: var(--ok); opacity: .35; animation: ping 1.8s ease-out infinite;
  }
  @keyframes ping { 0% { transform: scale(.6); opacity: .5; } 100% { transform: scale(2.2); opacity: 0; } }

  section { margin-bottom: 22px; }
  .sec-head { margin: 0 2px 11px; }
  .sec-head h2 { font-size: 13px; font-weight: 640; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); margin: 0; }
  .sec-head p { margin: 4px 0 0; font-size: 13px; color: var(--faint); }

  .cards { display: grid; gap: 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 16px 18px;
    display: flex; align-items: center; gap: 14px;
    transition: border-color .15s ease;
  }
  .card .ico {
    width: 42px; height: 42px; border-radius: 12px; flex: none;
    display: grid; place-items: center; font-weight: 700; font-size: 16px; color: #fff;
  }
  .ico.claude { background: var(--claude); }
  .ico.codex  { background: var(--codex); }
  .ico.gemini { background: var(--gemini); }
  .card .body { flex: 1 1 auto; min-width: 0; }
  .card .name { font-weight: 640; font-size: 15px; }
  .card .stat { display: inline-flex; align-items: center; gap: 7px; margin-top: 3px; font-size: 13px; color: var(--muted); }
  .card .stat .sdot { width: 9px; height: 9px; border-radius: 50%; background: var(--off); flex: none; }
  .card.connected .stat .sdot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .card .detail {
    margin-top: 4px; font-size: 12.5px; color: var(--faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
  }
  .card .actions { flex: none; }

  button.btn {
    appearance: none; border: 0; cursor: pointer; font: inherit; font-weight: 600;
    border-radius: 10px; padding: 9px 16px; color: #fff; background: var(--accent);
    transition: filter .12s ease, transform .04s ease;
  }
  button.btn:hover { filter: brightness(1.06); }
  button.btn:active { transform: translateY(1px); }
  button.btn:disabled { opacity: .55; cursor: default; filter: none; transform: none; }
  .card.claude  button.btn { background: var(--claude); }
  .card.codex   button.btn { background: var(--codex); }
  .card.gemini  button.btn { background: var(--gemini); }
  .badge-ok {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 13px; font-weight: 600; color: var(--ok);
    background: var(--ok-bg); border-radius: 999px; padding: 6px 12px;
  }
  .badge-ok svg { width: 14px; height: 14px; }

  .hintbox {
    margin-top: 11px; font-size: 13px; line-height: 1.5; color: var(--muted);
    background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 10px 13px; display: none;
  }
  .hintbox.show { display: block; }
  .hintbox code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12.5px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 1px 6px;
  }
  .hintbox .spin {
    display: inline-block; width: 12px; height: 12px; margin-right: 7px; vertical-align: -1px;
    border: 2px solid var(--border-strong); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .endpoint-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 18px;
  }
  .endpoint-row { display: flex; gap: 10px; align-items: stretch; }
  .endpoint-url {
    flex: 1 1 auto; min-width: 0; display: flex; align-items: center;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 14px;
    background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: 10px;
    padding: 0 14px; color: var(--text); overflow-x: auto; white-space: nowrap;
  }
  button.copy {
    appearance: none; border: 1px solid var(--border-strong); background: var(--panel-2);
    color: var(--text); font: inherit; font-weight: 600; cursor: pointer;
    border-radius: 10px; padding: 10px 16px; flex: none; min-width: 92px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background .12s ease, border-color .12s ease, color .12s ease;
  }
  button.copy:hover { border-color: var(--accent); color: var(--accent); }
  button.copy.done { background: var(--ok-bg); border-color: var(--ok); color: var(--ok); }
  button.copy svg { width: 15px; height: 15px; }
  .endpoint-note { margin: 13px 2px 0; font-size: 13px; color: var(--muted); line-height: 1.55; }
  .endpoint-note + .endpoint-note { margin-top: 7px; color: var(--faint); }
  .endpoint-note code, .endpoint-note kbd {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px;
  }

  .models {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); overflow: hidden;
  }
  .model-row {
    display: flex; align-items: center; gap: 12px; padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .model-row:first-child { border-top: 0; }
  .model-row .mid {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 13.5px;
    font-weight: 600; color: var(--text);
  }
  .model-row .by {
    margin-left: auto; font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
    text-transform: uppercase; color: var(--muted);
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px;
  }
  .by.claude { color: var(--claude); border-color: color-mix(in srgb, var(--claude) 35%, var(--border)); }
  .by.codex  { color: var(--codex);  border-color: color-mix(in srgb, var(--codex) 35%, var(--border)); }
  .by.gemini { color: var(--gemini); border-color: color-mix(in srgb, var(--gemini) 35%, var(--border)); }
  .empty { padding: 18px 16px; color: var(--faint); font-size: 13.5px; }
  footer { margin: 30px 2px 0; text-align: center; font-size: 12px; color: var(--faint); }
</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".95"/>
          <circle cx="12" cy="12" r="3.4" fill="#fff"/>
        </svg>
      </div>
      <div class="title">
        <h1>Meridian Gateway</h1>
        <p>Local OpenAI-compatible endpoint</p>
      </div>
      <span class="pill" id="runPill"><span class="dot"></span>Running</span>
    </header>

    <section>
      <div class="sec-head">
        <h2>Connect your AI subscriptions</h2>
        <p>Sign in to the subscriptions you already pay for. Each model below uses its matching account — no API keys needed.</p>
      </div>
      <div class="cards" id="cards">
        <div class="card claude" data-id="claude">
          <div class="ico claude">C</div>
          <div class="body">
            <div class="name">Claude</div>
            <div class="stat"><span class="sdot"></span><span class="stat-text">Checking…</span></div>
            <div class="detail"></div>
            <div class="hintbox"></div>
          </div>
          <div class="actions"></div>
        </div>
        <div class="card codex" data-id="codex">
          <div class="ico codex">O</div>
          <div class="body">
            <div class="name">ChatGPT <span style="color:var(--faint);font-weight:500;font-size:13px">(Codex)</span></div>
            <div class="stat"><span class="sdot"></span><span class="stat-text">Checking…</span></div>
            <div class="detail"></div>
            <div class="hintbox"></div>
          </div>
          <div class="actions"></div>
        </div>
        <div class="card gemini" data-id="gemini">
          <div class="ico gemini">G</div>
          <div class="body">
            <div class="name">Gemini</div>
            <div class="stat"><span class="sdot"></span><span class="stat-text">Checking…</span></div>
            <div class="detail"></div>
            <div class="hintbox"></div>
          </div>
          <div class="actions"></div>
        </div>
      </div>
    </section>

    <section>
      <div class="sec-head"><h2>Your endpoint</h2></div>
      <div class="endpoint-card">
        <div class="endpoint-row">
          <div class="endpoint-url" id="endpointUrl">${endpoint}</div>
          <button class="copy" id="copyBtn" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="copy-label">Copy</span>
          </button>
        </div>
        <p class="endpoint-note">Point any OpenAI-compatible app at this base URL. Any text works as the API key — it runs locally and isn’t authenticated.</p>
        <p class="endpoint-note">Each model needs its matching subscription connected above.</p>
      </div>
    </section>

    <section>
      <div class="sec-head"><h2>Models</h2></div>
      <div class="models" id="models"><div class="empty">Loading models…</div></div>
    </section>

    <footer>Served locally by Meridian Gateway · this page never leaves your machine</footer>
  </div>

<script>
(function () {
  "use strict";
  var POLL_MS = 2000;
  var IDLE_REFRESH_MS = 6000;
  var BACKED_BY = {
    "anthropic-subscription": { id: "claude", label: "Claude" },
    "openai-subscription":    { id: "codex",  label: "ChatGPT" },
    "gemini-subscription":    { id: "gemini", label: "Gemini" }
  };
  var pollTimers = {};

  function el(card, sel) { return card.querySelector(sel); }
  function cardFor(id) { return document.querySelector('.card[data-id="' + id + '"]'); }

  function okBadge() {
    return '<span class="badge-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Connected</span>';
  }

  function renderProvider(id, state) {
    var card = cardFor(id);
    if (!card) return;
    var statText = el(card, ".stat-text");
    var detail = el(card, ".detail");
    var actions = el(card, ".actions");
    if (state && state.connected) {
      card.classList.add("connected");
      statText.textContent = "Connected";
      detail.textContent = state.detail || "";
      detail.style.display = state.detail ? "" : "none";
      actions.innerHTML = okBadge();
      stopPoll(id);
    } else {
      card.classList.remove("connected");
      statText.textContent = "Not connected";
      detail.textContent = (state && state.detail) || "";
      detail.style.display = (state && state.detail) ? "" : "none";
      if (!actions.querySelector("button")) {
        actions.innerHTML = '<button class="btn" type="button">Connect</button>';
        actions.querySelector("button").addEventListener("click", function () { connect(id); });
      }
    }
  }

  function showHint(id, html, withSpinner) {
    var card = cardFor(id);
    if (!card) return;
    var box = el(card, ".hintbox");
    box.innerHTML = (withSpinner ? '<span class="spin"></span>' : "") + html;
    box.classList.add("show");
  }

  function connect(id) {
    var card = cardFor(id);
    var btn = card && el(card, ".actions button");
    if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
    fetch("/providers/" + id + "/login", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.manual) {
          showHint(id, (res.hint || "Sign in manually to connect."), false);
          if (btn) { btn.disabled = false; btn.textContent = "Connect"; }
          startPoll(id);
          return;
        }
        var msg = "Opening your browser — finish signing in there; this updates automatically.";
        if (res && res.url) {
          msg += ' If it didn’t open, <a href="' + res.url + '" target="_blank" rel="noopener">use this link</a>.';
        }
        showHint(id, msg, true);
        startPoll(id);
      })
      .catch(function () {
        showHint(id, "Couldn’t start sign-in. Please try again.", false);
        if (btn) { btn.disabled = false; btn.textContent = "Connect"; }
      });
  }

  function startPoll(id) {
    stopPoll(id);
    pollTimers[id] = setInterval(function () { refreshStatus(true); }, POLL_MS);
  }
  function stopPoll(id) {
    if (pollTimers[id]) { clearInterval(pollTimers[id]); delete pollTimers[id]; }
  }

  function refreshStatus(quiet) {
    return fetch("/providers/status")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        ["claude", "codex", "gemini"].forEach(function (id) { renderProvider(id, s[id]); });
      })
      .catch(function () { if (!quiet) { /* keep last known state on transient errors */ } });
  }

  function renderModels(data) {
    var box = document.getElementById("models");
    var list = (data && data.data) || [];
    if (!list.length) { box.innerHTML = '<div class="empty">No models available.</div>'; return; }
    box.innerHTML = list.map(function (m) {
      var b = BACKED_BY[m.owned_by] || { id: "", label: (m.owned_by || "?") };
      return '<div class="model-row"><span class="mid">' + esc(m.id) + '</span>' +
             '<span class="by ' + b.id + '">' + esc(b.label) + '</span></div>';
    }).join("");
  }

  function loadModels() {
    fetch("/v1/models")
      .then(function (r) { return r.json(); })
      .then(renderModels)
      .catch(function () {
        document.getElementById("models").innerHTML = '<div class="empty">Couldn’t load models — is the gateway still running?</div>';
      });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Copy endpoint.
  var copyBtn = document.getElementById("copyBtn");
  copyBtn.addEventListener("click", function () {
    var url = document.getElementById("endpointUrl").textContent.trim();
    var label = copyBtn.querySelector(".copy-label");
    var mark = function () {
      copyBtn.classList.add("done");
      label.textContent = "Copied!";
      setTimeout(function () { copyBtn.classList.remove("done"); label.textContent = "Copy"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(mark, function () { legacyCopy(url, mark); });
    } else {
      legacyCopy(url, mark);
    }
  });
  function legacyCopy(text, cb) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy");
      document.body.removeChild(ta); cb();
    } catch (e) { /* clipboard unavailable in this iframe */ }
  }

  // Initial load + gentle idle auto-refresh (independent of per-provider polls).
  refreshStatus(true);
  loadModels();
  setInterval(function () { refreshStatus(true); }, IDLE_REFRESH_MS);
})();
</script>
</body>
</html>`;
}
