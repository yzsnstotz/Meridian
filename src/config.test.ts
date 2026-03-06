import assert from "node:assert/strict";
import { test } from "node:test";

const REQUIRED_ENV = {
  TELEGRAM_BOT_TOKEN: "123456789:test_token",
  ALLOWED_USER_IDS: "123456789"
} satisfies Record<string, string>;

const CONFIG_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "ALLOWED_USER_IDS",
  "COORDINATOR_SOCKET_PATH",
  "COORDINATOR_INTENTS",
  "WEBHOOK_URL",
  "WEBHOOK_PORT",
  "WEBHOOK_SECRET_TOKEN",
  "WEB_GUI_ENABLED",
  "WEB_GUI_PORT",
  "WEB_GUI_HOST",
  "WEB_GUI_TOKEN",
  "WEB_GUI_HTTPS",
  "TLS_CERT_PATH",
  "TLS_KEY_PATH"
] as const;

async function withProcessEnv(overrides: Record<string, string>, fn: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();

  for (const key of CONFIG_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  Object.assign(process.env, REQUIRED_ENV, overrides);

  try {
    await fn();
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("parseConfig applies v2 defaults for webhook and web GUI fields", async () => {
  await withProcessEnv({}, async () => {
    const { parseConfig } = await import("./config");
    const config = parseConfig(REQUIRED_ENV);

    assert.equal(config.COORDINATOR_SOCKET_PATH, "");
    assert.deepEqual(config.COORDINATOR_INTENTS, []);
    assert.equal(config.WEBHOOK_URL, "");
    assert.equal(config.WEBHOOK_PORT, 443);
    assert.equal(config.WEBHOOK_SECRET_TOKEN, "");
    assert.equal(config.WEB_GUI_ENABLED, false);
    assert.equal(config.WEB_GUI_PORT, 3000);
    assert.equal(config.WEB_GUI_HOST, "");
    assert.equal(config.WEB_GUI_TOKEN, "");
    assert.equal(config.WEB_GUI_HTTPS, false);
    assert.equal(config.TLS_CERT_PATH, "");
    assert.equal(config.TLS_KEY_PATH, "");
  });
});

test("parseConfig parses v2 webhook and web GUI overrides", async () => {
  await withProcessEnv({}, async () => {
    const { parseConfig } = await import("./config");
    const config = parseConfig({
      ...REQUIRED_ENV,
      COORDINATOR_SOCKET_PATH: "/tmp/coordinator.sock",
      COORDINATOR_INTENTS: "delegate, plan , review",
      WEBHOOK_URL: "https://bot.example.com/webhook",
      WEBHOOK_PORT: "8443",
      WEBHOOK_SECRET_TOKEN: "secret-token",
      WEB_GUI_ENABLED: "true",
      WEB_GUI_PORT: "3456",
      WEB_GUI_HOST: "gui.example.com",
      WEB_GUI_TOKEN: "gui-token",
      WEB_GUI_HTTPS: "true",
      TLS_CERT_PATH: "/etc/ssl/certs/gui.pem",
      TLS_KEY_PATH: "/etc/ssl/private/gui.key"
    });

    assert.equal(config.COORDINATOR_SOCKET_PATH, "/tmp/coordinator.sock");
    assert.deepEqual(config.COORDINATOR_INTENTS, ["delegate", "plan", "review"]);
    assert.equal(config.WEBHOOK_URL, "https://bot.example.com/webhook");
    assert.equal(config.WEBHOOK_PORT, 8443);
    assert.equal(config.WEBHOOK_SECRET_TOKEN, "secret-token");
    assert.equal(config.WEB_GUI_ENABLED, true);
    assert.equal(config.WEB_GUI_PORT, 3456);
    assert.equal(config.WEB_GUI_HOST, "gui.example.com");
    assert.equal(config.WEB_GUI_TOKEN, "gui-token");
    assert.equal(config.WEB_GUI_HTTPS, true);
    assert.equal(config.TLS_CERT_PATH, "/etc/ssl/certs/gui.pem");
    assert.equal(config.TLS_KEY_PATH, "/etc/ssl/private/gui.key");
  });
});

test("parseConfig requires host and token when web GUI is enabled", async () => {
  await withProcessEnv({}, async () => {
    const { parseConfig } = await import("./config");

    assert.throws(
      () =>
        parseConfig({
          ...REQUIRED_ENV,
          WEB_GUI_ENABLED: "true"
        }),
      /WEB_GUI_HOST is required when WEB_GUI_ENABLED=true.*WEB_GUI_TOKEN is required when WEB_GUI_ENABLED=true/
    );
  });
});

test("parseConfig requires TLS files when web GUI HTTPS is enabled", async () => {
  await withProcessEnv({}, async () => {
    const { parseConfig } = await import("./config");

    assert.throws(
      () =>
        parseConfig({
          ...REQUIRED_ENV,
          WEB_GUI_ENABLED: "true",
          WEB_GUI_HOST: "gui.example.com",
          WEB_GUI_TOKEN: "gui-token",
          WEB_GUI_HTTPS: "true"
        }),
      /TLS_CERT_PATH is required when WEB_GUI_HTTPS=true.*TLS_KEY_PATH is required when WEB_GUI_HTTPS=true/
    );
  });
});
