import * as fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Process Monitor GUI features — token-increase green flash + departed-process
// history. App.js is a vanilla module that runs at load; these tests verify
// the relevant string contracts (markup, class names, animation, helpers) are
// present in the static files. Logic correctness for the per-pid comparison
// is small enough that wrong shape would be visible at a glance — these tests
// catch accidental removal during future GUI refactors.

describe("processes tab — token flash + history", () => {
  const publicDir = path.resolve(process.cwd(), "src/web/public");

  it("HTML exposes the departed-processes history table with the documented columns", async () => {
    const html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    expect(html).toContain('id="processes-history-shell"');
    expect(html).toContain('id="processes-history-empty"');
    expect(html).toContain('id="processes-history-table"');
    expect(html).toContain('id="processes-history-body"');
    // Title + help line establish what this section means; if either gets
    // dropped the section becomes mysterious without changing functionality.
    expect(html).toContain("Departed processes");
    expect(html).toContain("Capped at 100 entries");
    expect(html).toContain("No departed processes recorded yet");
    expect(html).toContain("Keep this Processes tab open");
    expect(html).toContain('<div id="processes-history-shell" class="table-shell history-shell">');
    // Column headers — order matters for the renderHistoryRow string output.
    const headersOrder = [
      "<th>PID</th>",
      "<th>origin</th>",
      "<th>agent</th>",
      "<th>thread_id</th>",
      "tokens (final)",
      "<th>session file</th>",
      "<th>last seen</th>",
      "<th>command</th>"
    ];
    let cursor = html.indexOf("processes-history-shell");
    expect(cursor).toBeGreaterThan(0);
    for (const h of headersOrder) {
      const idx = html.indexOf(h, cursor);
      expect(idx, `expected ${h} after history-shell start`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("CSS defines the green token-uptick flash and history demotion styles", async () => {
    const css = await fs.readFile(path.join(publicDir, "style.css"), "utf8");
    // Keyframe + class binding. The animation duration must be in the 2s
    // ballpark per product requirement ("stay in the color for 2 seconds").
    expect(css).toContain("@keyframes process-token-flash");
    expect(css).toContain(".row-token-flash td");
    expect(css).toMatch(/animation:\s*process-token-flash\s+2s/);
    expect(css).toContain("85%  { background-color: rgba(34, 197, 94, 0.30); }");
    // Green hue at start of animation. Exact rgba is mutable but the
    // green-ish channel should dominate.
    expect(css).toMatch(/process-token-flash[\s\S]{0,200}rgba\(\s*34\s*,\s*197\s*,\s*94/);
    // History section styles must exist (visually demoted but present).
    expect(css).toContain(".history-shell");
    expect(css).toContain(".history-title");
    expect(css).toContain(".row-history td");
    expect(css).toContain(".history-cmd");
    expect(css).toContain(".history-session-file");
  });

  it("app.js wires per-pid token comparison + departed-process capture into refresh()", async () => {
    const js = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    // Per-pid previous-total map and history map exist in module scope of
    // setupProcessMonitor (the only function that owns them).
    expect(js).toContain("const prevTokenTotals = new Map();");
    expect(js).toContain("const processHistory = new Map();");
    // Capture functions. The applyTokenFlashing function must flash the first
    // observed token-carrying row and later only on strict growth (not >=,
    // which would flash on every poll for inactive processes).
    expect(js).toContain("function applyTokenFlashing");
    expect(js).toMatch(/_tokenIncreased\s*=\s*\(cur !== null && Number\.isFinite\(cur\) && \(prev === undefined \|\| cur > prev\)\)/);
    expect(js).toContain("function captureDepartedProcesses");
    // Renderer must consult the flag and add the row-token-flash class.
    expect(js).toContain('row-token-flash');
    expect(js).toContain("function renderHistory");
    expect(js).toContain("function renderHistoryRow");
    expect(js).toContain('document.getElementById("processes-history-empty")');
    expect(js).toContain('document.getElementById("processes-history-table")');
    expect(js).toMatch(/historyTable\.hidden\s*=\s*true/);
    // Cap enforcement (FIFO) — the cap constant must be referenced so the
    // history map can't grow without bound.
    expect(js).toContain("PROCESS_HISTORY_CAP");
    expect(js).toMatch(/processHistory\.size\s*>\s*PROCESS_HISTORY_CAP/);
    // refresh() must call both helpers in the right order (capture compares
    // *previous* snapshot to current, so it MUST run before lastProcesses is
    // overwritten). Anchor inside setupProcessMonitor — app.js now has
    // multiple `async function refresh()` definitions across different
    // setups, so the bare anchor would land on the wrong one.
    const monitorStart = js.indexOf("function setupProcessMonitor");
    expect(monitorStart, "setupProcessMonitor present").toBeGreaterThan(0);
    const refreshStart = js.indexOf("async function refresh()", monitorStart);
    expect(refreshStart, "refresh() defined inside setupProcessMonitor").toBeGreaterThan(monitorStart);
    const refreshSlice = js.slice(refreshStart, refreshStart + 800);
    const idxApply = refreshSlice.indexOf("applyTokenFlashing(data.processes)");
    const idxCapture = refreshSlice.indexOf("captureDepartedProcesses(data.processes, previousSnapshot)");
    const idxAssign = refreshSlice.indexOf("lastProcesses = data.processes;");
    expect(idxApply).toBeGreaterThan(0);
    expect(idxCapture).toBeGreaterThan(idxApply);
    expect(idxAssign).toBeGreaterThan(idxCapture);
  });

  it("history cap is 100 (documented browser-session bound)", async () => {
    const js = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    expect(js).toContain("const PROCESS_HISTORY_CAP = 100;");
  });

  it("truncateMiddle helper exists and behaves correctly", async () => {
    const js = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    expect(js).toContain("function truncateMiddle(");
    // Sanity-evaluate the helper in isolation by extracting and Function-eval.
    const match = js.match(/function truncateMiddle\([\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${match![0]}; return truncateMiddle;`)() as (s: string, n: number) => string;
    expect(fn("short", 60)).toBe("short");
    expect(fn("abcdefghijklmnop", 8)).toMatch(/^[a-z]+…[a-z]+$/);
    expect(fn("abcdefghijklmnop", 8).length).toBeLessThanOrEqual(8);
    expect(fn("anything", 3)).toBe("anything"); // max < 6 → pass through
  });
});
