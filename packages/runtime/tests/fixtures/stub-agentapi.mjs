#!/usr/bin/env node
/**
 * Minimal stub for agentapi used by integration tests.
 * Invoked as: node stub-agentapi.mjs server --type=codex --socket=/path/to.sock -- codex
 * Listens on the given Unix socket and responds to GET /status and POST /message.
 */

import http from "node:http";

const socketPath = process.argv.find((a) => a.startsWith("--socket="))?.slice("--socket=".length);
if (!socketPath) {
  console.error("Missing --socket= path");
  process.exit(1);
}

const messages = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  const send = (statusCode, body) => {
    const json = typeof body === "object" ? JSON.stringify(body) : body;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(json);
  };

  if (req.method === "GET" && pathname === "/status") {
    return send(200, { status: "idle" });
  }
  if (req.method === "GET" && pathname === "/messages") {
    return send(200, { messages });
  }
  if (req.method === "POST" && pathname === "/message") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      messages.push({ id: messages.length + 1, content: "pong", role: "agent" });
      send(200, { id: messages.length, content: "pong" });
    });
    return;
  }
  send(404, { error: "not found" });
});

server.listen(socketPath, () => {
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
});
