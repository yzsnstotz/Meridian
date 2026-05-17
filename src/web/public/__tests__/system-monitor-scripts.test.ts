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

  it("polls /api/system-monitor and includes red/yellow/unknown card states", async () => {
    const publicDir = path.resolve(process.cwd(), "src/web/public");
    const monitorScript = await fs.readFile(path.join(publicDir, "monitor.js"), "utf8");
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
    const styleCss = await fs.readFile(path.join(publicDir, "style.css"), "utf8");

    expect(monitorScript).toContain('fetchJson("/api/system-monitor")');
    expect(monitorScript).toContain("setInterval(refresh, MONITOR_POLL_INTERVAL_MS)");
    expect(monitorScript).toContain('role="status"');
    expect(monitorScript).toContain("monitor-card-state-red");
    expect(monitorScript).toContain("monitor-card-state-yellow");
    expect(monitorScript).toContain("monitor-card-state-unknown");

    expect(appScript).toContain("setupMonitorNavAlarm");
    expect(appScript).toContain('fetchJson("/api/system-monitor")');
    expect(styleCss).toContain(".monitor-card-state-red");
    expect(styleCss).toContain("@keyframes monitorAlarmPulse");
  });
});
