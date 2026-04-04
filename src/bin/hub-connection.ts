/**
 * Service connection utility for Meridian CLI.
 *
 * Connects to Meridian hub via HTTP (preferred for CLI) with fallback logic.
 * Does NOT import hub internals — communicates only through public HTTP API.
 */

import http from "node:http";
import net from "node:net";

// ── Service discovery (env-based, per PRD §6.2) ────────────────────────────

const MERIDIAN_SOCKET = process.env.MERIDIAN_SOCKET ?? "/tmp/hub-core.sock";
const MERIDIAN_HTTP = process.env.MERIDIAN_HTTP ?? "http://localhost:3000";

export interface HubConnection {
  /** Base URL for HTTP requests to the hub */
  httpBase: string;
  /** Socket path if available */
  socketPath: string | null;
  /** Which transport was verified */
  transport: "http" | "socket";
}

/**
 * Verify that the hub is reachable. Tries HTTP first, then socket.
 * Throws if neither transport is available.
 */
export async function connectToHub(): Promise<HubConnection> {
  // Try HTTP first — easier for CLI usage
  if (await isHttpReachable(MERIDIAN_HTTP)) {
    return {
      httpBase: MERIDIAN_HTTP,
      socketPath: MERIDIAN_SOCKET,
      transport: "http",
    };
  }

  // Try socket
  if (await isSocketReachable(MERIDIAN_SOCKET)) {
    return {
      httpBase: MERIDIAN_HTTP,
      socketPath: MERIDIAN_SOCKET,
      transport: "socket",
    };
  }

  throw new Error(
    `Cannot reach Meridian hub (tried HTTP=${MERIDIAN_HTTP}, socket=${MERIDIAN_SOCKET})`
  );
}

/**
 * Make an HTTP request to the hub and return the parsed JSON response.
 */
export async function hubHttpRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = new URL(path, MERIDIAN_HTTP);

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: body
          ? { "Content-Type": "application/json" }
          : undefined,
        timeout: 10_000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("HTTP request timed out"));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ── Internal transport checks ───────────────────────────────────────────────

function isHttpReachable(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL("/api/instances", baseUrl);
    const req = http.request(url, { method: "GET", timeout: 3_000 }, (res) => {
      // Any response means the server is up
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function isSocketReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3_000);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}
