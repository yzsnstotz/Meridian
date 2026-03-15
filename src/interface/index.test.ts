import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MERIDIAN_DISABLE_INTERFACE_AUTOSTART = "true";
process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
process.env.ALLOWED_USER_IDS ??= "123456789";

const interfaceModulePromise = import("./index");

function createLogger() {
  return {
    infoCalls: [] as Array<{ payload: unknown; message: string }>,
    errorCalls: [] as Array<{ payload: unknown; message: string }>,
    info(...args: unknown[]) {
      const [payload, message] = args;
      this.infoCalls.push({ payload, message: typeof message === "string" ? message : String(message) });
    },
    warn(..._args: unknown[]) {
      // Not needed in these tests.
    },
    error(...args: unknown[]) {
      const [payload, message] = args;
      this.errorCalls.push({ payload, message: typeof message === "string" ? message : String(message) });
    }
  };
}

function createRuntime(botId = "123456789") {
  const deleteWebhookCalls: Array<{ drop_pending_updates?: boolean } | undefined> = [];
  const setWebhookCalls: Array<{ url: string; options?: { secret_token?: string } }> = [];
  const startCalls: Array<{ onStart?: (botInfo: { id: number; username?: string }) => void | Promise<void> } | undefined> = [];
  let initCalls = 0;

  const botInfo = { id: Number(botId), username: `bot_${botId}` };
  const runtime = {
    botId,
    bot: {
      api: {
        deleteWebhook: async (options?: { drop_pending_updates?: boolean }) => {
          deleteWebhookCalls.push(options);
        },
        setWebhook: async (url: string, options?: { secret_token?: string }) => {
          setWebhookCalls.push({ url, options });
        }
      },
      botInfo,
      init: async () => {
        initCalls += 1;
      },
      start: async (options?: { onStart?: (botInfo: { id: number; username?: string }) => void | Promise<void> }) => {
        startCalls.push(options);
        await options?.onStart?.(botInfo);
      },
      stop: () => undefined
    }
  };

  return {
    runtime,
    deleteWebhookCalls,
    setWebhookCalls,
    startCalls,
    get initCalls() {
      return initCalls;
    }
  };
}

test("startInterface uses long polling when WEBHOOK_URL is empty", async () => {
  const { startInterface } = await interfaceModulePromise;
  const logger = createLogger();
  const fake = createRuntime();
  let syncCalls = 0;

  await startInterface({
    runtimes: [fake.runtime],
    syncBotCommands: async () => {
      syncCalls += 1;
    },
    webhookUrl: "",
    logger
  });

  assert.equal(syncCalls, 1);
  assert.deepEqual(fake.deleteWebhookCalls, [{ drop_pending_updates: false }]);
  assert.equal(fake.startCalls.length, 1);
  assert.equal(fake.setWebhookCalls.length, 0);
  assert.equal(logger.infoCalls.length, 1);
  assert.equal(logger.infoCalls[0]?.message, "Telegram bot started with long polling");
});

test("startInterface uses webhook mode when WEBHOOK_URL is set", async () => {
  const { buildWebhookPublicUrl, buildWebhookRoutePath, startInterface } = await interfaceModulePromise;
  const logger = createLogger();
  const fake = createRuntime("777");
  let syncCalls = 0;
  let listenedPort: number | null = null;

  await startInterface({
    runtimes: [fake.runtime],
    syncBotCommands: async () => {
      syncCalls += 1;
    },
    webhookUrl: "https://bot.example.com/webhook",
    webhookPort: 8080,
    webhookSecretToken: "secret-token",
    logger,
    webhookHandlerFactory: () => async () => undefined,
    serverFactory: () => ({
      listen: (port: number, listeningListener?: () => void) => {
        listenedPort = port;
        listeningListener?.();
      },
      close: () => undefined
    })
  });

  assert.equal(syncCalls, 1);
  assert.equal(fake.initCalls, 1);
  assert.equal(fake.startCalls.length, 0);
  assert.equal(fake.deleteWebhookCalls.length, 0);
  assert.equal(listenedPort, 8080);
  assert.equal(buildWebhookRoutePath("https://bot.example.com/webhook", "777", 1), "/webhook");
  assert.equal(buildWebhookRoutePath("https://bot.example.com/webhook", "777", 2), "/webhook/777");
  assert.deepEqual(fake.setWebhookCalls, [
    {
      url: buildWebhookPublicUrl("https://bot.example.com/webhook", "777", 1),
      options: { secret_token: "secret-token" }
    }
  ]);
  assert.equal(logger.infoCalls[0]?.message, "Telegram bot started with webhook");
  assert.equal(logger.infoCalls[1]?.message, "Telegram webhook server listening");
});

test("handleHubActionCallbackData dispatches reboot requests through Hub IPC", async () => {
  const { handleHubActionCallbackData } = await interfaceModulePromise;
  const dispatched: Array<Record<string, unknown>> = [];
  const answerCalls: Array<{ text?: string }> = [];

  const handled = await handleHubActionCallbackData(
    "hub:reboot:codex_01",
    {
      chat: { id: 12345 },
      me: { id: 777 },
      from: { id: 99 },
      callbackQuery: {
        message: {
          message_id: 42
        }
      },
      answerCallbackQuery: async (payload?: { text?: string }) => {
        answerCalls.push(payload ?? {});
      }
    } as never,
    {
      dispatchHubMessage: async (message) => {
        dispatched.push(message as unknown as Record<string, unknown>);
      }
    }
  );

  assert.equal(handled, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.intent, "reboot");
  assert.equal(dispatched[0]?.thread_id, "codex_01");
  assert.equal(dispatched[0]?.target, "codex_01");
  assert.deepEqual(answerCalls, [{ text: "Rebooting codex_01..." }]);
});
