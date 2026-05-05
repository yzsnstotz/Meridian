#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_METRICS_URLS = [
  "http://127.0.0.1:20241",
  "http://127.0.0.1:20242",
  "http://127.0.0.1:20243",
  "http://127.0.0.1:20244",
  "http://127.0.0.1:20245"
];

export function parseReadyPayload(payload) {
  const parsed = JSON.parse(payload);
  return {
    status: Number(parsed.status),
    readyConnections: Number(parsed.readyConnections ?? 0),
    connectorId: typeof parsed.connectorId === "string" ? parsed.connectorId : null
  };
}

export function loadConfigFromEnv(env = process.env) {
  return {
    externalUrl: env.IOEX_HEALTHCHECK_EXTERNAL_URL || "https://ioex.io",
    originUrl: env.IOEX_HEALTHCHECK_ORIGIN_URL || "http://127.0.0.1:3100",
    metricsUrls: splitList(env.IOEX_HEALTHCHECK_METRICS_URLS, DEFAULT_METRICS_URLS),
    minReadyConnections: positiveInt(env.IOEX_HEALTHCHECK_MIN_READY_CONNECTIONS, 1),
    timeoutMs: positiveInt(env.IOEX_HEALTHCHECK_TIMEOUT_MS, 8000),
    restartService: env.IOEX_HEALTHCHECK_RESTART_SERVICE || "system/com.cloudflare.cloudflared",
    restartOnTunnelFailure: env.IOEX_HEALTHCHECK_DISABLE_RESTART !== "1",
    dryRun: env.IOEX_HEALTHCHECK_DRY_RUN === "1",
    notifyCooldownMs: positiveInt(env.IOEX_HEALTHCHECK_NOTIFY_COOLDOWN_MS, 300_000),
    notifyDesktop: env.IOEX_HEALTHCHECK_SKIP_DESKTOP_NOTIFY !== "1",
    stateFile: env.IOEX_HEALTHCHECK_STATE_FILE || "/var/tmp/ioex-tunnel-healthcheck-state.json",
    syslog: env.IOEX_HEALTHCHECK_DISABLE_SYSLOG !== "1"
  };
}

export async function runHealthcheck(config, deps = defaultDeps()) {
  const checks = {
    tunnel: await checkTunnelReady(config, deps),
    origin: await checkHttpEndpoint("origin", config.originUrl, config, deps),
    external: await checkHttpEndpoint("external", config.externalUrl, config, deps)
  };

  const failures = Object.values(checks)
    .filter((check) => !check.ok)
    .map((check) => check.message);

  const actions = [];
  if (!checks.tunnel.ok && config.restartOnTunnelFailure) {
    actions.push(restartCloudflared(config, deps));
  }

  const ok = failures.length === 0;
  const event = {
    time: new Date(deps.now()).toISOString(),
    level: ok ? "info" : "error",
    ok,
    checks,
    failures,
    actions
  };

  if (!ok) {
    maybeNotify(config, deps, failures);
  } else {
    clearFailureState(config, deps);
  }

  emit(config, deps, event);
  return { ok, checks, failures, actions };
}

async function checkTunnelReady(config, deps) {
  const errors = [];
  for (const metricsUrl of config.metricsUrls) {
    const readyUrl = toReadyUrl(metricsUrl);
    try {
      const response = await fetchWithTimeout(deps, readyUrl, "GET", config.timeoutMs);
      const text = await response.text();
      const ready = parseReadyPayload(text);
      const ok = ready.status === 200 && ready.readyConnections >= config.minReadyConnections;
      return {
        ok,
        kind: "tunnel",
        url: readyUrl,
        status: ready.status,
        readyConnections: ready.readyConnections,
        connectorId: ready.connectorId,
        message: ok
          ? `tunnel ready at ${readyUrl}: readyConnections=${ready.readyConnections}`
          : `tunnel unhealthy at ${readyUrl}: status=${ready.status} readyConnections=${ready.readyConnections}`
      };
    } catch (error) {
      errors.push(`${readyUrl}: ${error.message}`);
    }
  }

  return {
    ok: false,
    kind: "tunnel",
    url: config.metricsUrls.map(toReadyUrl).join(","),
    message: `tunnel readiness unavailable: ${errors.join("; ")}`
  };
}

async function checkHttpEndpoint(kind, url, config, deps) {
  try {
    const response = await fetchWithTimeout(deps, url, "HEAD", config.timeoutMs);
    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      kind,
      url,
      status: response.status,
      message: ok ? `${kind} ${url} returned HTTP ${response.status}` : `${kind} ${url} returned HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      kind,
      url,
      message: `${kind} ${url} failed: ${error.message}`
    };
  }
}

async function fetchWithTimeout(deps, url, method, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await deps.fetch(url, { method, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function restartCloudflared(config, deps) {
  if (config.dryRun) {
    return `dry-run: would kickstart ${config.restartService}`;
  }

  const result = deps.runCommand("/bin/launchctl", ["kickstart", "-k", config.restartService]);
  if (result.status === 0) {
    return `kickstarted ${config.restartService}`;
  }

  return `failed to kickstart ${config.restartService}: ${result.stderr || result.stdout || `exit ${result.status}`}`;
}

function maybeNotify(config, deps, failures) {
  if (!config.stateFile) {
    if (config.notifyDesktop) {
      sendDesktopNotification(deps, failures);
    }
    return;
  }

  const now = deps.now();
  const failureKey = failures.join("\n");
  const previous = deps.readState(config.stateFile);
  const lastNotifyAt = Number(previous?.lastNotifyAt ?? 0);
  const shouldNotify = previous?.lastFailureKey !== failureKey || now - lastNotifyAt >= config.notifyCooldownMs;

  writeStateNonFatal(config, deps, {
    lastFailureKey: failureKey,
    lastFailureAt: now,
    lastNotifyAt: shouldNotify ? now : lastNotifyAt
  });

  if (shouldNotify && config.notifyDesktop) {
    sendDesktopNotification(deps, failures);
  }
}

function clearFailureState(config, deps) {
  if (!config.stateFile) {
    return;
  }

  const previous = deps.readState(config.stateFile);
  if (!previous) {
    return;
  }

  writeStateNonFatal(config, deps, {
    ...previous,
    lastHealthyAt: deps.now(),
    lastFailureKey: null
  });
}

function writeStateNonFatal(config, deps, state) {
  try {
    deps.writeState(config.stateFile, state);
  } catch (error) {
    deps.log(
      JSON.stringify({
        time: new Date(deps.now()).toISOString(),
        level: "warn",
        ok: true,
        message: `state file not writable: ${error.message}`
      })
    );
  }
}

function sendDesktopNotification(deps, failures) {
  const body = failures.join("\n").slice(0, 220);
  const script = `display notification "${escapeAppleScript(body)}" with title "ioex.io tunnel health"`;
  const userResult = deps.runCommand("/usr/bin/stat", ["-f", "%Su", "/dev/console"]);
  const consoleUser = userResult.status === 0 ? userResult.stdout.trim() : "";

  if (consoleUser && consoleUser !== "root") {
    const uidResult = deps.runCommand("/usr/bin/id", ["-u", consoleUser]);
    const uid = uidResult.status === 0 ? uidResult.stdout.trim() : "";
    if (uid) {
      deps.runCommand("/bin/launchctl", [
        "asuser",
        uid,
        "/usr/bin/sudo",
        "-u",
        consoleUser,
        "/usr/bin/osascript",
        "-e",
        script
      ]);
      return;
    }
  }

  deps.runCommand("/usr/bin/osascript", ["-e", script]);
}

function emit(config, deps, event) {
  const line = JSON.stringify(event);
  deps.log(line);
  if (config.syslog && !event.ok) {
    deps.runCommand("/usr/bin/logger", ["-t", "ioex-tunnel-healthcheck", line]);
  }
}

function toReadyUrl(metricsUrl) {
  return metricsUrl.endsWith("/ready") ? metricsUrl : `${metricsUrl.replace(/\/$/, "")}/ready`;
}

function splitList(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeAppleScript(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function defaultDeps() {
  return {
    now: Date.now,
    fetch: globalThis.fetch,
    runCommand(command, args) {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? ""
      };
    },
    readState(path) {
      if (!existsSync(path)) {
        return null;
      }
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    },
    writeState(path, state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
    },
    log(line) {
      console.log(line);
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfigFromEnv();
  const result = await runHealthcheck(config);
  process.exit(result.ok ? 0 : 1);
}
