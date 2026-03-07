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

test("terminal approval actions use dedicated terminal_input API", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /\/api\/terminal_input/);
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

test("terminal explorer directory rows expose keyboard accessible toggles", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /row\.setAttribute\("role", "button"\)/);
  assert.match(terminalHtml, /row\.setAttribute\("tabindex", "0"\)/);
  assert.match(terminalHtml, /row\.setAttribute\("aria-expanded"/);
});
