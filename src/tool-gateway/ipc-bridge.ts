/**
 * IPC bridge for Meridian-roles tool-gateway.
 *
 * After R-05 the tool-gateway no longer opens direct Hub sockets for
 * cross-service Meridian operations. Spawn/run/kill go through the
 * Meridian HTTP API client; notify uses the HTTP relay with a file-relay
 * fallback. This module retains only the HTTP relay transport.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";

import { GUI_PORT } from "../config";
import { HubResultSchema, type HubMessage, type HubResult } from "../types";

const DEFAULT_HTTP_RELAY_TIMEOUT_MS = 120_000;
const MERIDIAN_TOOL_CHAT_ID = "service:meridian-tool";
const HUB_RELAY_URL_ENV = "MERIDIAN_HUB_RELAY_URL";

function getHubRelayUrl(): string {
  const configured = process.env[HUB_RELAY_URL_ENV]?.trim();
  if (configured) {
    return configured;
  }

  return `http://127.0.0.1:${GUI_PORT}/api/hub-relay`;
}

function buildInlineOutboundMessage(hubMessage: Partial<HubMessage>, traceId: string): Partial<HubMessage> {
  return {
    ...hubMessage,
    trace_id: traceId,
    reply_channel: hubMessage.reply_channel ?? {
      channel: "web",
      chat_id: MERIDIAN_TOOL_CHAT_ID
    }
  };
}

export function sendViaHttpRelay(
  hubMessage: Partial<HubMessage>,
  timeoutMs: number
): Promise<HubResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const traceId = typeof hubMessage.trace_id === "string" && hubMessage.trace_id.trim()
      ? hubMessage.trace_id
      : randomUUID();
    const outboundMessage = buildInlineOutboundMessage(hubMessage, traceId);
    const body = JSON.stringify(outboundMessage);
    const relayUrl = new URL(getHubRelayUrl());
    const requestOptions: http.RequestOptions = {
      hostname: relayUrl.hostname,
      port: relayUrl.port,
      path: relayUrl.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      },
      timeout: timeoutMs > 0 ? timeoutMs : undefined
    };

    const request = http.request(requestOptions, (response) => {
      let rawResponse = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        rawResponse += chunk;
      });
      response.on("end", () => {
        if (settled) {
          return;
        }

        settled = true;
        if (!rawResponse.trim()) {
          reject(buildRelayError({
            baseMessage: "HTTP relay completed without a response body",
            traceId,
            requestAccepted: true,
            responsePathFailure: "empty-body"
          }));
          return;
        }

        try {
          const result = HubResultSchema.parse(JSON.parse(rawResponse));
          resolve(result);
        } catch (error) {
          reject(buildRelayError({
            baseMessage: `Invalid HTTP relay response: ${asError(error).message}`,
            traceId,
            requestAccepted: true,
            responsePathFailure: "invalid-body"
          }));
        }
      });
    });

    request.on("timeout", () => {
      if (settled) {
        return;
      }

      settled = true;
      request.destroy(new Error(`HTTP relay timed out after ${timeoutMs}ms`));
    });

    request.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(asError(error));
    });

    request.end(body);
  });
}

function buildRelayError(args: {
  baseMessage: string;
  traceId: string;
  requestAccepted: boolean;
  responsePathFailure: string;
}): Error {
  return new Error(
    `${args.baseMessage}; trace_id=${args.traceId}; transport=http-relay; `
    + `request_delivery=${args.requestAccepted ? "request-may-have-reached-hub" : "request-not-sent"}; `
    + `response_path_failure=${args.responsePathFailure}`
  );
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
