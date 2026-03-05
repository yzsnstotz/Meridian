import fs from "node:fs";
import net from "node:net";

import { config } from "../config";
import { createLogger } from "../logger";
import {
  AgentTypeSchema,
  HubMessageSchema,
  HubResultSchema,
  InboundUIEventSchema,
  type AgentType,
  type HubMessage,
  type HubResult
} from "../types";
import { normalizeInboundEvent } from "./normalizer";
import { ResultSender } from "./result-sender";
import { InstanceRegistry } from "./registry";
import { HubRouter } from "./router";

interface InboundEnvelope {
  chatId?: string;
  chat_id?: string;
  event: unknown;
}

export interface HubServerOptions {
  socketPath?: string;
  router?: HubRouter;
  resultSender?: ResultSender;
}

export class HubServer {
  private readonly log = createLogger("hub");
  private readonly socketPath: string;
  private readonly router: HubRouter;
  private readonly resultSender: ResultSender;
  private server: net.Server | null = null;

  constructor(options: HubServerOptions = {}) {
    this.socketPath = options.socketPath ?? config.HUB_SOCKET_PATH;
    this.router = options.router ?? new HubRouter(new InstanceRegistry());
    this.resultSender = options.resultSender ?? new ResultSender();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await this.removeStaleSocket();

    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let raw = "";

      socket.on("data", (chunk: string) => {
        raw += chunk;
      });

      socket.on("end", () => {
        void this.handleRawPayload(raw);
      });

      socket.on("error", (error) => {
        this.log.error({ trace_id: null, thread_id: null, err: String(error) }, "Hub socket connection failed");
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolve());
    });

    this.log.info({ trace_id: null, thread_id: null, socket_path: this.socketPath }, "Hub server listening");
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    await fs.promises.unlink(this.socketPath).catch(() => undefined);
    this.log.info({ trace_id: null, thread_id: null, socket_path: this.socketPath }, "Hub server stopped");
  }

  private async handleRawPayload(raw: string): Promise<void> {
    let message: HubMessage | null = null;

    try {
      if (!raw.trim()) {
        throw new Error("Empty IPC payload");
      }

      const parsed = JSON.parse(raw) as unknown;
      message = this.normalizeIncomingMessage(parsed);
      const result = await this.router.route(message);
      const validatedResult = HubResultSchema.parse(result);
      await this.resultSender.sendResult(validatedResult, message.reply_channel);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.log.error(
        {
          trace_id: message?.trace_id ?? null,
          thread_id: message?.thread_id ?? null,
          err: errorMessage
        },
        "Failed to process inbound hub payload"
      );

      if (!message) {
        return;
      }

      const fallbackResult: HubResult = HubResultSchema.parse({
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: this.resolveSource(message.target),
        status: "error",
        content: `Hub processing failed: ${errorMessage}`,
        attachments: [],
        timestamp: new Date().toISOString()
      });

      await this.resultSender.sendResult(fallbackResult, message.reply_channel).catch((sendError) => {
        this.log.error(
          {
            trace_id: message?.trace_id ?? null,
            thread_id: message?.thread_id ?? null,
            err: sendError instanceof Error ? sendError.message : String(sendError)
          },
          "Failed to deliver fallback HubResult"
        );
      });
    }
  }

  private normalizeIncomingMessage(payload: unknown): HubMessage {
    const hubMessage = HubMessageSchema.safeParse(payload);
    if (hubMessage.success) {
      return hubMessage.data;
    }

    const envelope = payload as InboundEnvelope;
    if (envelope && typeof envelope === "object" && "event" in envelope) {
      const normalizedEvent = InboundUIEventSchema.parse(envelope.event);
      const chatId = envelope.chatId ?? envelope.chat_id;
      if (!chatId) {
        throw new Error("Inbound envelope is missing chatId");
      }

      return normalizeInboundEvent(normalizedEvent, { chatId });
    }

    throw new Error(`Invalid HubMessage payload: ${hubMessage.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  private resolveSource(target: string): AgentType {
    const parsed = AgentTypeSchema.safeParse(target);
    if (parsed.success) {
      return parsed.data;
    }
    return "codex";
  }

  private async removeStaleSocket(): Promise<void> {
    await fs.promises.unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
