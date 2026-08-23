import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { PromptStore, PromptStoreNotFoundError } from "../roles/prompt-store";

const SystemPromptPatchSchema = z.object({
  system_prompt: z.string()
});

const InstructionTemplatePatchSchema = z.object({
  instruction_template: z.string().min(1)
});

type PromptRouteMatch =
  | { kind: "get-prompts"; threadId: string }
  | { kind: "patch-system-prompt"; threadId: string }
  | { kind: "patch-task-template"; threadId: string; taskId: string }
  | { kind: "delete-task-template"; threadId: string; taskId: string };

export interface PromptHandlers {
  getPrompts(
    threadId: string
  ): Promise<{ system_prompt?: string; tasks: Array<{ task_id: string; instruction: string; instruction_template?: string }> }>;
  patchSystemPrompt(threadId: string, body: unknown): Promise<{ ok: true }>;
  patchTaskTemplate(threadId: string, taskId: string, body: unknown): Promise<{ ok: true }>;
  deleteTaskTemplate(threadId: string, taskId: string): Promise<{ ok: true }>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export function createPromptHandlers(promptStore: PromptStore): PromptHandlers {
  const handlers: PromptHandlers = {
    getPrompts: (threadId) => promptStore.getPrompts(threadId),
    patchSystemPrompt: async (threadId, body) => {
      const parsed = SystemPromptPatchSchema.safeParse(body);
      if (!parsed.success) {
        throw createBadRequestError("Invalid body: expected { system_prompt: string }");
      }

      await promptStore.setSystemPrompt(threadId, parsed.data.system_prompt);
      return { ok: true };
    },
    patchTaskTemplate: async (threadId, taskId, body) => {
      const parsed = InstructionTemplatePatchSchema.safeParse(body);
      if (!parsed.success) {
        throw createBadRequestError("Invalid body: expected { instruction_template: string }");
      }

      await promptStore.setTaskTemplate(threadId, taskId, parsed.data.instruction_template);
      return { ok: true };
    },
    deleteTaskTemplate: async (threadId, taskId) => {
      await promptStore.deleteTaskTemplate(threadId, taskId);
      return { ok: true };
    },
    handle: async (request, response) => {
      const route = matchPromptRoute(request);
      if (!route) {
        return false;
      }

      try {
        switch (route.kind) {
          case "get-prompts":
            writeJson(response, 200, await handlers.getPrompts(route.threadId));
            return true;
          case "patch-system-prompt":
            writeJson(response, 200, await handlers.patchSystemPrompt(route.threadId, await readJsonBody(request)));
            return true;
          case "patch-task-template":
            writeJson(response, 200, await handlers.patchTaskTemplate(route.threadId, route.taskId, await readJsonBody(request)));
            return true;
          case "delete-task-template":
            writeJson(response, 200, await handlers.deleteTaskTemplate(route.threadId, route.taskId));
            return true;
        }
      } catch (error) {
        const statusCode = getStatusCode(error);
        writeJson(response, statusCode, { error: getErrorMessage(error) });
        return true;
      }
    }
  };

  return handlers;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    throw createBadRequestError("Request body must be valid JSON");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw createBadRequestError("Request body must be valid JSON");
  }
}

function matchPromptRoute(request: IncomingMessage): PromptRouteMatch | null {
  const method = request.method?.toUpperCase();
  const url = request.url;
  if (!method || !url) {
    return null;
  }

  const pathname = new URL(url, "http://127.0.0.1").pathname;
  const parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

  if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "role" && parts[3] === "prompts") {
    return { kind: "get-prompts", threadId: parts[2] };
  }

  if (method === "PATCH" && parts.length === 4 && parts[0] === "api" && parts[1] === "role" && parts[3] === "prompt") {
    return { kind: "patch-system-prompt", threadId: parts[2] };
  }

  if (
    method === "PATCH" &&
    parts.length === 6 &&
    parts[0] === "api" &&
    parts[1] === "role" &&
    parts[3] === "task" &&
    parts[5] === "template"
  ) {
    return { kind: "patch-task-template", threadId: parts[2], taskId: parts[4] };
  }

  if (
    method === "DELETE" &&
    parts.length === 6 &&
    parts[0] === "api" &&
    parts[1] === "role" &&
    parts[3] === "task" &&
    parts[5] === "template"
  ) {
    return { kind: "delete-task-template", threadId: parts[2], taskId: parts[4] };
  }

  return null;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (!response.headersSent) {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
  }

  response.end(`${JSON.stringify(body)}\n`);
}

function createBadRequestError(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}

function getStatusCode(error: unknown): number {
  if (error instanceof PromptStoreNotFoundError) {
    return error.statusCode;
  }

  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }

  return 500;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}
