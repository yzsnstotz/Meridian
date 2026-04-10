import fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { GUI_LISTEN_HOST, GUI_PORT } from "../config";
import type { Logger } from "../roles/base-role";
import type { PromptHandlers } from "./prompt-handlers";
import type { RoleHandlers } from "./role-handlers";

export interface HttpServerOptions {
  port?: number;
  host?: string;
  roleHandlers: RoleHandlers;
  promptHandlers: PromptHandlers;
  publicDir?: string;
  log?: Logger;
}

export class HttpServer {
  private readonly port: number;
  private readonly host: string | undefined;
  private readonly publicDir: string;
  private readonly log: Logger;
  private readonly roleHandlers: RoleHandlers;
  private readonly promptHandlers: PromptHandlers;
  private server: Server | null = null;

  constructor(options: HttpServerOptions) {
    this.port = options.port ?? GUI_PORT;
    this.host = normalizeOptionalHost(options.host ?? GUI_LISTEN_HOST);
    this.publicDir = options.publicDir ?? resolvePublicDir();
    this.log = options.log ?? console;
    this.roleHandlers = options.roleHandlers;
    this.promptHandlers = options.promptHandlers;
  }

  async listen(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const onListen = () => {
        server.removeListener("error", reject);
        resolve();
      };

      if (this.host) {
        server.listen(this.port, this.host, onListen);
        return;
      }

      server.listen(this.port, onListen);
    });

    this.server = server;
    this.log.info("HTTP server listening", {
      port: this.port,
      host: this.host ?? "(default)",
      publicDir: this.publicDir
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (await this.promptHandlers.handle(request, response)) {
        return;
      }

      if (await this.roleHandlers.handle(request, response)) {
        return;
      }

      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const asset = mapPublicAsset(pathname);
      if (!asset) {
        if (pathname.startsWith("/api/")) {
          writeJson(response, 404, { error: "Not found" });
          return;
        }

        writeText(response, 404, "Not found\n");
        return;
      }

      const filePath = path.join(this.publicDir, asset.fileName);
      const body = await fs.readFile(filePath);
      response.statusCode = 200;
      response.setHeader("content-type", asset.contentType);
      response.end(body);
    } catch (error) {
      this.log.error("HTTP request failed", {
        url: request.url,
        error: error instanceof Error ? error.message : String(error)
      });

      if (!response.headersSent) {
        if ((request.url ?? "").startsWith("/api/")) {
          writeJson(response, 500, { error: "Internal server error" });
        } else {
          writeText(response, 500, "Internal server error\n");
        }
      } else {
        response.end();
      }
    }
  }
}

function resolvePublicDir(): string {
  const direct = path.resolve(__dirname, "../web/public");
  const fallback = path.resolve(__dirname, "../../src/web/public");

  return fsSync.existsSync(direct) ? direct : fallback;
}

function normalizeOptionalHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mapPublicAsset(pathname: string): { fileName: string; contentType: string } | null {
  if (pathname === "/" || pathname === "/index.html") {
    return { fileName: "index.html", contentType: "text/html; charset=utf-8" };
  }

  if (/^\/role\/[^/]+$/.test(pathname)) {
    return { fileName: "role.html", contentType: "text/html; charset=utf-8" };
  }

  if (/^\/role\/[^/]+\/prompts$/.test(pathname)) {
    return { fileName: "prompts.html", contentType: "text/html; charset=utf-8" };
  }

  if (/^\/role\/[^/]+\/config$/.test(pathname)) {
    return { fileName: "config.html", contentType: "text/html; charset=utf-8" };
  }

  if (pathname === "/app.js") {
    return { fileName: "app.js", contentType: "text/javascript; charset=utf-8" };
  }

  if (pathname === "/style.css") {
    return { fileName: "style.css", contentType: "text/css; charset=utf-8" };
  }

  return null;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function writeText(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}
