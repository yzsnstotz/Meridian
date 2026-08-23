/**
 * Set environment variables required by config so that Hub and Web can start in tests.
 * Must be called before any module that imports config.
 */
export function setIntegrationTestEnv(): void {
  process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
  process.env.ALLOWED_USER_IDS ??= "123456789";
  process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY ??= "meridian-integration-test-bootstrap-key";
  process.env.MERIDIAN_DISABLE_WEB_AUTOSTART = "1";
}
