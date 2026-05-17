const MONITOR_POLL_INTERVAL_MS = 5000;
const MONITOR_GROUP_LABELS = {
  process_pressure: "Process Pressure",
  hub_health: "Hub Health",
  loop_detectors: "Loop Detectors",
  system_resources: "System Resources",
  lifecycle_anomaly: "Lifecycle Anomaly",
  wedge_staleness: "Wedge / Staleness"
};
const MONITOR_GROUP_ORDER = [
  "process_pressure",
  "hub_health",
  "loop_detectors",
  "system_resources",
  "lifecycle_anomaly",
  "wedge_staleness"
];
const MONITOR_CARD_STATE_CLASSES = new Set([
  "monitor-card-state-green",
  "monitor-card-state-yellow",
  "monitor-card-state-red",
  "monitor-card-state-unknown",
  "monitor-card-state-info"
]);
const MONITOR_DETAIL_HINTS = {
  C1: "Log detector: counts terminal worker cleanup kill failures in the meridian-roles log.",
  C2: "Log detector: counts A2A hub-registration retry lines in the meridian-roles log.",
  C3: "Log detector: counts validator transport-stall lines in the meridian-roles log.",
  C4: "Log detector: counts PM resolver start events in the meridian-roles log.",
  C5: "Log detector: counts watchdog stall-detection lines in the meridian-roles log.",
  C6: "Log detector: counts dispatcher launch-breaker trips in the meridian-roles log.",
  C7: "Log detector: counts worker-breaker trips in the meridian-roles log.",
  D2: "Log file metric: measures the current meridian-roles log file size.",
  D3: "Log file metric: compares the meridian-roles log size with the previous monitor poll.",
  D4: "Log file metric: measures the current Meridian hub log file size."
};

document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "system-monitor") {
    setupSystemMonitor();
  }
});

function setupSystemMonitor() {
  const grid = document.getElementById("monitor-indicator-grid");
  const banner = document.getElementById("monitor-alarm-banner");
  const lastPoll = document.getElementById("monitor-last-poll");
  const staleBadge = document.getElementById("monitor-stale-badge");
  const spinner = document.getElementById("monitor-spinner");
  const feedback = document.getElementById("monitor-feedback");
  if (!grid) {
    return;
  }

  let failureCount = 0;
  let lastSnapshot = null;

  async function refresh() {
    if (spinner) spinner.classList.add("monitor-spinner-active");
    try {
      const data = await fetchJson("/api/system-monitor");
      if (!data || !Array.isArray(data.indicators)) {
        throw new Error("monitor response missing indicators");
      }
      failureCount = 0;
      lastSnapshot = data;
      renderMonitorSnapshot(data);
      setMonitorNavRedDot(Boolean(data.any_red));
      if (feedback) feedback.textContent = "";
      if (staleBadge) staleBadge.hidden = true;
      if (spinner) spinner.textContent = "";
    } catch (error) {
      failureCount += 1;
      if (staleBadge) staleBadge.hidden = false;
      if (spinner) spinner.textContent = failureCount >= 3 ? "!" : "";
      if (feedback) feedback.textContent = `Failed to refresh monitor: ${getErrorMessage(error)}`;
      if (lastSnapshot) {
        renderMonitorSnapshot(lastSnapshot, { stale: true, failureCount, error: getErrorMessage(error) });
      } else if (banner) {
        banner.hidden = false;
        banner.classList.add("monitor-alarm-banner-red");
        banner.textContent = `System monitor unavailable: ${getErrorMessage(error)}`;
      }
    } finally {
      if (spinner) spinner.classList.remove("monitor-spinner-active");
    }
  }

  function renderMonitorSnapshot(snapshot, options = {}) {
    if (lastPoll) {
      const time = snapshot.polled_at ? new Date(snapshot.polled_at).toLocaleTimeString() : "--";
      lastPoll.textContent = `last poll: ${time}`;
    }

    const groups = groupIndicators(snapshot.indicators);
    grid.replaceChildren();
    for (const group of MONITOR_GROUP_ORDER) {
      const indicators = groups.get(group);
      if (!indicators || indicators.length === 0) {
        continue;
      }
      const section = document.createElement("section");
      section.className = "monitor-group";
      section.innerHTML = `
        <div class="monitor-group-heading">
          <h2>${escapeHtml(MONITOR_GROUP_LABELS[group] || group)}</h2>
          <span class="monitor-group-count">${indicators.length}</span>
        </div>
        <div class="monitor-card-grid">
          ${indicators.map(renderMonitorCard).join("")}
        </div>
      `;
      grid.appendChild(section);
    }

    const redCount = snapshot.indicators.filter((indicator) => indicator.state === "red").length;
    const yellowCount = snapshot.indicators.filter((indicator) => indicator.state === "yellow").length;
    const unknownCount = snapshot.indicators.filter((indicator) => indicator.state === "unknown").length;
    if (!banner) {
      return;
    }
    if (redCount > 0 || options.failureCount >= 3) {
      banner.hidden = false;
      banner.classList.add("monitor-alarm-banner-red");
      banner.textContent = options.failureCount >= 3
        ? `Monitor polling failed ${options.failureCount} times: ${options.error || "unknown error"}`
        : `${redCount} indicator${redCount === 1 ? "" : "s"} in RED state`;
    } else if (options.stale) {
      banner.hidden = false;
      banner.classList.remove("monitor-alarm-banner-red");
      banner.textContent = "Showing stale monitor values from the previous successful poll.";
    } else if (yellowCount > 0 || unknownCount > 0) {
      banner.hidden = false;
      banner.classList.remove("monitor-alarm-banner-red");
      banner.textContent = `${yellowCount} yellow, ${unknownCount} unknown`;
    } else {
      banner.hidden = true;
      banner.classList.remove("monitor-alarm-banner-red");
      banner.textContent = "";
    }
  }

  refresh();
  setInterval(refresh, MONITOR_POLL_INTERVAL_MS);
}

function groupIndicators(indicators) {
  const groups = new Map();
  for (const indicator of indicators) {
    const key = indicator.group || "other";
    const group = groups.get(key) || [];
    group.push(indicator);
    groups.set(key, group);
  }
  return groups;
}

function renderMonitorCard(indicator) {
  const state = indicator.state || "unknown";
  const stateClass = MONITOR_CARD_STATE_CLASSES.has(`monitor-card-state-${state}`)
    ? `monitor-card-state-${state}`
    : "monitor-card-state-unknown";
  const source = indicator.source_learning || "";
  const value = formatMonitorValue(indicator.value, indicator.unit);
  const threshold = renderThreshold(indicator);
  const evidence = renderMonitorEvidence(indicator);
  return `
    <details class="monitor-indicator-card ${stateClass}" data-monitor-state="${escapeHtml(state)}" aria-live="polite">
      <summary class="monitor-card-summary" aria-label="Open indicator details for ${escapeHtml(indicator.id)}">
        <div class="monitor-card-top">
          <span class="monitor-state-dot" aria-label="${escapeHtml(state)}"></span>
          <span class="monitor-card-id">${escapeHtml(indicator.id)}</span>
        </div>
        <h3>${escapeHtml(indicator.name)}</h3>
        <div class="monitor-card-value">${value}</div>
        <div class="monitor-card-threshold">${threshold}</div>
        <span class="monitor-card-expand" aria-hidden="true">+</span>
      </summary>
      <div class="monitor-card-details">
        ${renderMonitorCardDetails(indicator, { value, threshold, source, evidence })}
      </div>
    </details>
  `;
}

function renderMonitorCardDetails(indicator, { value, threshold, source, evidence }) {
  return `
    <dl class="monitor-detail-list">
      <div class="monitor-card-detail-row">
        <dt>State</dt>
        <dd>${escapeHtml(indicator.state || "unknown")}</dd>
      </div>
      <div class="monitor-card-detail-row">
        <dt>Value</dt>
        <dd>${value}</dd>
      </div>
      <div class="monitor-card-detail-row">
        <dt>Threshold</dt>
        <dd>${threshold}</dd>
      </div>
      ${evidence ? `
        <div class="monitor-card-detail-row">
          <dt>Evidence</dt>
          <dd>${escapeHtml(evidence)}</dd>
        </div>
      ` : ""}
      <div class="monitor-card-detail-row">
        <dt>Source</dt>
        <dd>${source ? `<code>${escapeHtml(source)}</code>` : '<span class="muted">none</span>'}</dd>
      </div>
    </dl>
  `;
}

function renderMonitorEvidence(indicator) {
  if (indicator.detail) {
    return indicator.detail;
  }
  return MONITOR_DETAIL_HINTS[indicator.id] || "";
}

function renderThreshold(indicator) {
  const thresholds = indicator.thresholds || {};
  if (indicator.state === "info") {
    return "informational";
  }
  if (thresholds.red !== undefined && thresholds.yellow !== undefined) {
    return `yellow ${formatThreshold(thresholds.yellow, indicator.unit)} / red ${formatThreshold(thresholds.red, indicator.unit)}`;
  }
  return indicator.state === "unknown" ? "no data" : "no threshold";
}

function formatThreshold(value, unit) {
  if (typeof value === "number") {
    return formatMonitorValue(value, unit);
  }
  return escapeHtml(value);
}

function formatMonitorValue(value, unit) {
  if (value === null || value === undefined || value === "") {
    return '<span class="muted">no data</span>';
  }
  if (typeof value !== "number") {
    return `<span>${escapeHtml(value)}</span>`;
  }
  if (unit === "bytes") {
    return `<span>${formatBytes(value)}</span>`;
  }
  if (unit === "bytes/s") {
    return `<span>${formatBytes(value)}/s</span>`;
  }
  if (unit === "tokens" || unit === "tokens/min") {
    return `<span>${formatTokens(value)}${unit === "tokens/min" ? "/min" : ""}</span>`;
  }
  if (unit === "ms") {
    return `<span>${value.toLocaleString()} ms</span>`;
  }
  if (unit === "seconds") {
    return `<span>${value.toLocaleString()} s</span>`;
  }
  return `<span>${value.toLocaleString()}${unit ? ` ${escapeHtml(unit)}` : ""}</span>`;
}

function formatBytes(value) {
  const abs = Math.abs(value);
  if (abs >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (abs >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (abs >= 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${value.toLocaleString()} B`;
}

function setMonitorNavRedDot(isRed) {
  const dot = document.getElementById("nav-monitor-red-dot");
  if (dot) {
    dot.hidden = !isRed;
  }
}
