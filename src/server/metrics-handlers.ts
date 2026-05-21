import type { IncomingMessage, ServerResponse } from "node:http";

import { renderChatterPrometheusMetrics } from "../roles/chatter/observability";

export interface MetricsHandlers {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export function createMetricsHandlers(): MetricsHandlers {
  return {
    async handle(request, response): Promise<boolean> {
      if (request.method !== "GET" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/metrics") {
        return false;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(renderChatterPrometheusMetrics());
      return true;
    }
  };
}
