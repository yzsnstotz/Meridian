import * as fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("system monitor public assets", () => {
  it("adds a top-level monitor page and nav alarm dot", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const indexHtml = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    const roleHtml = await fs.readFile(path.join(publicDir, "role.html"), "utf8");
    const schedulerHtml = await fs.readFile(path.join(publicDir, "scheduler.html"), "utf8");
    const monitorHtml = await fs.readFile(path.join(publicDir, "monitor.html"), "utf8");

    for (const html of [indexHtml, roleHtml, schedulerHtml, monitorHtml]) {
      expect(html).toContain('href="/monitor"');
      expect(html).toContain('id="nav-monitor-red-dot"');
    }

    expect(monitorHtml).toContain('data-page="system-monitor"');
    expect(monitorHtml).toContain('id="monitor-indicator-grid"');
    expect(monitorHtml).toContain('id="monitor-alarm-banner"');
    expect(monitorHtml).toContain('<script defer src="/monitor.js"></script>');
  });

  it("polls /api/system-monitor and renders expandable high-contrast cards", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const monitorScript = await fs.readFile(path.join(publicDir, "monitor.js"), "utf8");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const styleCss = await fs.readFile(path.join(publicDir, "style.css"), "utf8");

    expect(monitorScript).toContain('fetchJson("/api/system-monitor")');
    expect(monitorScript).toContain("setInterval(refresh, MONITOR_POLL_INTERVAL_MS)");
    expect(monitorScript).toContain('<details class="monitor-indicator-card');
    expect(monitorScript).toContain('data-monitor-id="');
    expect(monitorScript).toContain("getOpenMonitorCardIds");
    expect(monitorScript).toContain('open ? " open" : ""');
    expect(monitorScript).toContain('<summary class="monitor-card-summary"');
    expect(monitorScript).toContain('aria-label="Open indicator details for');
    expect(monitorScript).toContain("renderMonitorCardDetails");
    expect(monitorScript).toContain("renderMonitorItems");
    expect(monitorScript).toContain("safeMonitorHref");
    expect(monitorScript).toContain("monitor-item-list");
    expect(monitorScript).toContain("monitor-card-state-red");
    expect(monitorScript).toContain("monitor-card-state-yellow");
    expect(monitorScript).toContain("monitor-card-state-unknown");

    expect(appScript).toContain("setupMonitorNavAlarm");
    expect(appScript).toContain('fetchJson("/api/system-monitor")');
    expect(styleCss).toContain(".monitor-card-state-red");
    expect(styleCss).toContain("--monitor-card-bg:");
    expect(styleCss).toContain("--monitor-card-text:");
    expect(styleCss).toContain("color: var(--monitor-card-text);");
    expect(styleCss).toContain(".monitor-card-details");
    expect(styleCss).toContain(".monitor-item-list");
    expect(styleCss).toContain("@keyframes monitorAlarmPulse");
  });
});
