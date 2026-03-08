import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true, quiet: true });

const optionalEnvString = () => z.string().default("");
const envStringList = () =>
  z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    );

const envBoolean = (defaultValue: boolean) =>
  z
    .preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      z.enum(["true", "false"]).default(defaultValue ? "true" : "false")
    )
    .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("debug"),
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    TELEGRAM_BOT_TOKENS: z.string().optional(),
    ALLOWED_USER_IDS: z
      .string()
      .min(1, "ALLOWED_USER_IDS is required")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => Number(entry))
      )
      .refine((values) => values.length > 0 && values.every((id) => Number.isInteger(id) && id > 0), {
        message: "ALLOWED_USER_IDS must be a comma-separated list of positive integers"
      }),
    HUB_SOCKET_PATH: z.string().default("/tmp/hub-core.sock"),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
    HEARTBEAT_MISSED_THRESHOLD: z.coerce.number().int().positive().default(3),
    MONITOR_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    MONITOR_PROGRESS_TICK_MS: z.coerce.number().int().positive().default(1000),
    MONITOR_UPDATE_DEFAULT_INTERVAL_SEC: z.coerce.number().int().positive().default(30),
    MONITOR_UPDATE_MIN_INTERVAL_SEC: z.coerce.number().int().positive().default(5),
    MONITOR_UPDATE_MAX_INTERVAL_SEC: z.coerce.number().int().positive().default(600),
    PANE_CAPTURE_INTERVAL_MS: z.coerce.number().int().positive().default(7000),
    PANE_BROADCAST_THROTTLE_MS: z.coerce.number().int().positive().default(1000),
    LOG_DIR: z.string().default("/var/log/hub"),
    MERIDIAN_STATE_PATH: z.string().default("/tmp/meridian-state.json"),
    AGENT_WORKDIR: z.string().optional(),
    COORDINATOR_SOCKET_PATH: optionalEnvString(),
    COORDINATOR_INTENTS: envStringList(),
    WEBHOOK_URL: optionalEnvString(),
    WEBHOOK_PORT: z.coerce.number().int().positive().default(443),
    WEBHOOK_SECRET_TOKEN: optionalEnvString(),
    TELEGRAM_SUMMARY_ONLY: envBoolean(true),
    TELEGRAM_PUSH_WHITELIST_ONLY: envBoolean(true),
    WEB_GUI_ENABLED: envBoolean(false),
    WEB_GUI_PORT: z.coerce.number().int().positive().default(3000),
    WEB_GUI_HOST: optionalEnvString(),
    WEB_GUI_TOKEN: optionalEnvString(),
    WEB_GUI_HTTPS: envBoolean(false),
    TLS_CERT_PATH: optionalEnvString(),
    TLS_KEY_PATH: optionalEnvString(),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    CURSOR_API_KEY: z.string().optional()
  })
  .superRefine((env, ctx) => {
    if (env.WEB_GUI_ENABLED && !env.WEB_GUI_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WEB_GUI_HOST"],
        message: "WEB_GUI_HOST is required when WEB_GUI_ENABLED=true"
      });
    }

    if (env.WEB_GUI_ENABLED && !env.WEB_GUI_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WEB_GUI_TOKEN"],
        message: "WEB_GUI_TOKEN is required when WEB_GUI_ENABLED=true"
      });
    }

    if (env.WEB_GUI_HTTPS && !env.TLS_CERT_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TLS_CERT_PATH"],
        message: "TLS_CERT_PATH is required when WEB_GUI_HTTPS=true"
      });
    }

    if (env.WEB_GUI_HTTPS && !env.TLS_KEY_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TLS_KEY_PATH"],
        message: "TLS_KEY_PATH is required when WEB_GUI_HTTPS=true"
      });
    }
  });

export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issueSummary}`);
  }

  return parsed.data;
}

export const config = parseConfig();
export type AppConfig = ReturnType<typeof parseConfig>;
