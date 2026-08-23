import assert from "node:assert/strict";
import { test } from "node:test";

import type { HubMessage } from "../types";
import { InstanceRegistry } from "./registry";
import { HubRouter } from "./router";

function baseMessage(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    thread_id: "codex_01",
    actor_id: "owner",
    intent: "run",
    target: "codex_01",
    payload: {
      content: "hello",
      attachments: []
    },
    mode: "bridge",
    reply_channel: {
      channel: "telegram",
      chat_id: "100"
    },
    ...overrides
  };
}

test("HubRouter routes non-built-in intents through ServiceRegistry", async () => {
  const router = new HubRouter(new InstanceRegistry(), {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "idle" })
    })
  });
  router.registerServiceEndpoint({
    service: "coordinator",
    socket_path: "/tmp/coordinator.sock",
    intents: ["delegate"]
  });

  (router as unknown as { dispatchToService: (endpoint: unknown, message: HubMessage) => Promise<unknown> }).dispatchToService =
    async (_endpoint, message) => ({
      trace_id: message.trace_id,
      thread_id: "delegated_01",
      source: "codex",
      status: "success",
      content: `delegated:${message.intent}`,
      attachments: [],
      timestamp: new Date().toISOString()
    });

  const result = await router.route(
    baseMessage({
      intent: "delegate",
      thread_id: "external",
      target: "coordinator"
    })
  );

  assert.equal(result.status, "success");
  assert.equal(result.thread_id, "delegated_01");
  assert.equal(result.content, "delegated:delegate");
});

test("HubRouter keeps built-in intents out of ServiceRegistry lookup", async () => {
  let externalCallCount = 0;
  const router = new HubRouter(new InstanceRegistry(), {
    clientFactory: () => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      sendMessage: async () => ({ content: "unused" }),
      getStatus: async () => ({ status: "idle" })
    })
  });
  router.registerServiceEndpoint({
    service: "coordinator",
    socket_path: "/tmp/coordinator.sock",
    intents: ["list"]
  });

  (router as unknown as { dispatchToService: (endpoint: unknown, message: HubMessage) => Promise<unknown> }).dispatchToService =
    async () => {
      externalCallCount += 1;
      return {
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "wrong",
        source: "codex",
        status: "success",
        content: "should not be used",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    };

  const result = await router.route(baseMessage({ intent: "list", target: "all", thread_id: "global" }));
  assert.equal(result.status, "success");
  assert.match(result.content, /No active agent instances/);
  assert.equal(externalCallCount, 0);
});
