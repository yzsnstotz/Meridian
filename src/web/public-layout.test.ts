import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const publicDir = path.resolve(__dirname, "public");

test("shared layout baseline css enforces full-width and full-height viewport", async () => {
  const layoutCss = await fs.promises.readFile(path.join(publicDir, "layout-base.css"), "utf8");

  assert.match(layoutCss, /html,\s*body\s*\{[\s\S]*width:\s*100%/);
  assert.match(layoutCss, /html,\s*body\s*\{[\s\S]*min-height:\s*100%/);
  assert.match(layoutCss, /body\s*\{[\s\S]*min-height:\s*100vh/);
  assert.match(layoutCss, /body\s*\{[\s\S]*min-height:\s*100dvh/);
});

test("hub layout does not hard-cap content width on large screens", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
  assert.match(indexHtml, /#app\s*\{[\s\S]*width:\s*100%/);
  assert.doesNotMatch(indexHtml, /#app\s*\{[\s\S]*max-width:\s*80rem/);
});

test("hub layout pulls viewport baseline from shared css", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
});

test("hub layout exposes provider selection and persists spawn preferences", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /id="spawn-provider"/);
  assert.match(indexHtml, /SPAWN_PROVIDER_STORAGE_KEY/);
  assert.match(indexHtml, /SPAWN_AUTO_APPROVE_STORAGE_KEY/);
  assert.match(indexHtml, /type:\s*providerEl && providerEl\.value \? providerEl\.value : "codex"/);
});

test("hub layout renders log footprint monitoring from the main page", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /id="log-overview"/);
  assert.match(indexHtml, /id="log-list"/);
  assert.match(indexHtml, /\/api\/logs/);
  assert.match(indexHtml, /function renderLogInventory\(payload\)/);
});

test("bridge layout does not hard-cap content width on large screens", async () => {
  const bridgeHtml = await fs.promises.readFile(path.join(publicDir, "bridge.html"), "utf8");

  assert.match(bridgeHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
  assert.match(bridgeHtml, /#app\s*\{[\s\S]*width:\s*100%/);
  assert.doesNotMatch(bridgeHtml, /#app\s*\{[\s\S]*max-width:\s*42rem/);
  assert.doesNotMatch(bridgeHtml, /#app\s*\{[\s\S]*margin:\s*0\s*auto/);
});

test("terminal layout references shared viewport baseline css", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
});

test("terminal explorer does not call find via /api/run", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.doesNotMatch(terminalHtml, /runCommand\("find \\. -maxdepth 2 -not -path '\*\/\.\*'"\)/);
  assert.match(terminalHtml, /\/api\/files\?thread_id=/);
});

test("terminal view wires fit addon for full-size terminal rendering", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /xterm-addon-fit@\d/);
  assert.match(terminalHtml, /new window\.FitAddon\.FitAddon\(\)/);
  assert.match(terminalHtml, /term\.loadAddon\(fitAddon\)/);
  assert.match(terminalHtml, /fitAddon\.fit\(\)/);
});

test("terminal approval actions use dedicated terminal_input API", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /\/api\/terminal_input/);
  assert.match(terminalHtml, /Allow for this session/);
  assert.match(terminalHtml, /sendTerminalText\(opt\.(submit|key)\)/);
});

test("terminal explorer renders a collapsible directory tree", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /expandedDirs/);
  assert.match(terminalHtml, /renderFileTree/);
  assert.match(terminalHtml, /tree-toggle/);
});

test("terminal explorer persists expanded directories in session storage", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /EXPANDED_DIRS_STORAGE_KEY/);
  assert.match(terminalHtml, /sessionStorage\.getItem\(EXPANDED_DIRS_STORAGE_KEY/);
  assert.match(terminalHtml, /sessionStorage\.setItem\(EXPANDED_DIRS_STORAGE_KEY/);
});

test("terminal chat history restores from local storage and disables replay when present", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /CHAT_HISTORY_STORAGE_KEY/);
  assert.match(terminalHtml, /restoreChatHistory\(\)/);
  assert.match(terminalHtml, /restoreServerChatHistory\(entries\)/);
  assert.match(terminalHtml, /serverHistoryRestored = restoreServerChatHistory\(entries\)/);
  assert.match(terminalHtml, /replay_lines=/);
});

test("terminal canonical restore polls durable progress and suppresses reconnect replay when history is authoritative", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /\/api\/progress\//);
  assert.match(terminalHtml, /buildProgressMessageKey/);
  assert.match(terminalHtml, /activeProgressMessageKey/);
  assert.match(terminalHtml, /clearActiveProgressBubble/);
  assert.match(terminalHtml, /serverHistoryRestored \? 0 : 100/);
});

test("terminal chat keeps a content-fingerprint dedupe safety net for replayed agent bubbles", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /makeBubbleContentFingerprint/);
  assert.match(terminalHtml, /hasRecentBubbleWithContentFingerprint/);
  assert.match(terminalHtml, /data-content-fingerprint/);
});

test("terminal layout includes sidebar session history and model picker", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /data-sidebar-tab="sessions"/);
  assert.match(terminalHtml, /id="session-list"/);
  assert.match(terminalHtml, /\/api\/history_threads/);
  assert.match(terminalHtml, /id="model-select"/);
  assert.match(terminalHtml, /\/api\/models\?thread_id=/);
  assert.match(terminalHtml, /fetchWithAuth\("\/api\/models",\s*\{/);
  assert.match(terminalHtml, /Model: unavailable/);
  assert.match(terminalHtml, /Model: Custom\.\.\./);
  assert.match(terminalHtml, /window\.prompt\("Enter provider model id:"/);
});

test("terminal mobile header keeps overflow menu on the top-right and renders current-model fallback", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /\.header-right > \.header-overflow\s*\{[\s\S]*order:\s*3/);
  assert.match(terminalHtml, /\.header-overflow \.overflow-dropdown\s*\{[\s\S]*left:\s*auto/);
  assert.match(terminalHtml, /function renderCurrentOnly\(modelLabelOrId\)/);
  assert.match(terminalHtml, /if \(currentModelId\) \{\s*renderCurrentOnly\(currentModelId\);/);
});

test("terminal chat prioritizes structured /api/run result to avoid pane replay mixing", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /runCommand\(cmd\)\s*\.then/);
  assert.match(terminalHtml, /renderAgentContent\(resultContent\)/);
  assert.match(terminalHtml, /lastFlushedContent = stripAnsi\(resultContent\)/);
  assert.match(terminalHtml, /chatBuffer = ""/);
});

test("terminal explorer directory rows expose keyboard accessible toggles", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /row\.setAttribute\("role", "button"\)/);
  assert.match(terminalHtml, /row\.setAttribute\("tabindex", "0"\)/);
  assert.match(terminalHtml, /row\.setAttribute\("aria-expanded"/);
});
