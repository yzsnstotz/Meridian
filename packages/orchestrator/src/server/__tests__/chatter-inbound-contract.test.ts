import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { RoleRegistry } from "../../roles/role-registry";
import type { RoleRunner } from "../../roles/role-runner";
import type { HubResult } from "../../types";
import { createRoleHandlers } from "../role-handlers";

describe("/api/chatter-inbound contract", () => {
  it("preserves structured inline co-edit targets through parsing and dispatch", async () => {
    const dispatched: HubResult[] = [];
    const runner = {
      dispatch: vi.fn(async (result: HubResult) => {
        dispatched.push(result);
      })
    } as unknown as RoleRunner;
    const handlers = createRoleHandlers({
      runner,
      registry: new RoleRegistry(),
      log: makeLogger()
    });
    const coeditTarget = {
      label: "第 1 段 / 摘要",
      path: "outline.segments[0].summary",
      block_id: "outline.segments.0.summary",
      story_id: "story-lx-coedit",
      value: "旧摘要"
    };
    const request = createJsonRequest("POST", "/api/chatter-inbound", {
      trace_id: "55555555-5555-4555-8555-555555555555",
      thread_id: "chatter-mumu-user-coedit",
      source: "ads",
      status: "success",
      run_state: "completed",
      content: "把这一段改得更强",
      attachments: [],
      timestamp: "2026-05-24T00:00:00.000Z",
      payload: {
        chatter: {
          mode: "session",
          chatter_session_id: "story-create-coedit-turn",
          system_prompt_id: "create_from_template",
          coedit_target: coeditTarget
        }
      }
    });
    const response = createJsonResponse();

    const handled = await handlers.handle(request, response.raw);

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      dispatched: true,
      trace_id: "55555555-5555-4555-8555-555555555555",
      thread_id: "chatter-mumu-user-coedit"
    });
    expect(dispatched).toHaveLength(1);
    const dispatchedChatter = dispatched[0]?.payload?.chatter as { coedit_target?: unknown } | undefined;
    expect(dispatchedChatter?.coedit_target).toEqual(coeditTarget);
  });
});

function createJsonRequest(method: string, url: string, body: unknown): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    url,
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function createJsonResponse(): {
  raw: ServerResponse;
  statusCode: number;
  body: string;
} {
  const capture = { statusCode: 200, body: "", headersSent: false };
  const raw = {
    setHeader: () => undefined,
    end(chunk?: string) {
      capture.body = chunk ?? "";
      capture.headersSent = true;
    }
  } as unknown as ServerResponse;
  Object.defineProperty(raw, "statusCode", {
    get() {
      return capture.statusCode;
    },
    set(value: number) {
      capture.statusCode = value;
    }
  });
  Object.defineProperty(raw, "headersSent", {
    get() {
      return capture.headersSent;
    },
    set(value: boolean) {
      capture.headersSent = value;
    }
  });
  return {
    raw,
    get statusCode() {
      return capture.statusCode;
    },
    get body() {
      return capture.body;
    }
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}
