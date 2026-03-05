import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("debug"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
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
  LOG_DIR: z.string().default("/var/log/hub"),
  AGENT_WORKDIR: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  CURSOR_API_KEY: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issueSummary = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${issueSummary}`);
}

export const config = parsed.data;
export type AppConfig = typeof config;
