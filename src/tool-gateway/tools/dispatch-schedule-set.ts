import * as fs from "node:fs/promises";
import path from "node:path";

import {
  buildServiceErrorData,
  patchRolesServiceJson,
  postRolesServiceJson,
  requestRolesServiceJson
} from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const DEFAULT_FALLBACK_REPLY_CHANNEL = {
  channel: "web",
  chat_id: "web:ops"
} as const;

const dispatchScheduleSetTool: ToolDefinition = {
  name: "dispatch-schedule-set",
  description: "Create or update a scheduler role for routine dispatch plan execution",
  params: {
    plan: {
      type: "string",
      required: true,
      description: "Path to the dispatch_plan.md file"
    },
    mode: {
      type: "string",
      required: true,
      description: "Scheduler mode: none, cron, interval, or loop"
    },
    cron: {
      type: "string",
      required: false,
      description: "5-field cron expression (required for cron mode), e.g. '0 9 * * 1-5'"
    },
    timezone: {
      type: "string",
      required: false,
      description: "IANA timezone or 'system' (default: system)"
    },
    interval_seconds: {
      type: "string",
      required: false,
      description: "Cooldown interval in seconds (required for interval mode)"
    },
    max_cycles: {
      type: "string",
      required: false,
      description: "Maximum number of cycles before auto-stop"
    },
    delay_between_cycles_seconds: {
      type: "string",
      required: false,
      description: "Delay between loop cycles in seconds (default: 0)"
    },
    report_dir: {
      type: "string",
      required: true,
      description: "Base directory for run archives and reports"
    },
    repo_root: {
      type: "string",
      required: false,
      description: "Dispatcher sandbox root. Auto-detected from dispatch artifacts when omitted"
    },
    docs_root: {
      type: "string",
      required: false,
      description: "Detached docs root. Auto-detected from dispatch artifacts when omitted"
    },
    start_immediately: {
      type: "string",
      required: false,
      description: "Whether to start first cycle immediately (true/false)"
    },
    catch_up_policy: {
      type: "string",
      required: false,
      description: "Missed cron policy: skip_missed or run_one (default: skip_missed)"
    },
    scheduler_id: {
      type: "string",
      required: false,
      description: "Existing scheduler ID to update (creates new if omitted)"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const planPath = requireParam(params.plan);
    if (!planPath) return { ok: false, error: "Missing required parameter: plan" };

    const mode = requireParam(params.mode);
    if (!mode) return { ok: false, error: "Missing required parameter: mode" };

    const reportDir = requireParam(params.report_dir);
    if (!reportDir) return { ok: false, error: "Missing required parameter: report_dir" };

    try {
      // Resolve command file
      const commandFilePath = path.join(path.dirname(planPath), "agent_dispatch_command.md");
      await fs.access(commandFilePath);

      // Resolve reply channels
      const channels = await resolveReplyChannels();

      const config: Record<string, unknown> = {
        dispatch_plan_path: planPath,
        command_file_path: commandFilePath,
        user_reply_channels: channels,
        scheduler_mode: mode,
        report_base_dir: reportDir
      };

      if (params.repo_root) config.dispatch_repo_root = params.repo_root;
      if (params.docs_root) config.docs_root = params.docs_root;
      if (params.cron) config.cron_expression = params.cron;
      if (params.timezone) config.timezone = params.timezone;
      if (params.interval_seconds) config.interval_seconds = parseInt(params.interval_seconds, 10);
      if (params.max_cycles) config.max_cycles = parseInt(params.max_cycles, 10);
      if (params.delay_between_cycles_seconds) {
        config.delay_between_cycles_seconds = parseInt(params.delay_between_cycles_seconds, 10);
      }
      if (params.start_immediately) config.start_immediately = params.start_immediately === "true";
      if (params.catch_up_policy) config.catch_up_policy = params.catch_up_policy;

      // If updating existing scheduler
      if (params.scheduler_id) {
        const response = await patchRolesServiceJson<unknown>(
          `/api/scheduler/${encodeURIComponent(params.scheduler_id)}/config`,
          config
        );

        if (!response.ok) {
          return { ok: false, error: response.error, data: buildServiceErrorData(response) };
        }

        return { ok: true, data: { scheduler_id: params.scheduler_id, action: "updated", config } };
      }

      // Create new scheduler
      const response = await postRolesServiceJson<unknown>("/api/scheduler", {
        config
      });

      if (!response.ok) {
        return { ok: false, error: response.error, data: buildServiceErrorData(response) };
      }

      return {
        ok: true,
        data: response.body as Record<string, unknown>
      };
    } catch (error) {
      return { ok: false, error: asError(error).message };
    }
  }
};

export default dispatchScheduleSetTool;

async function resolveReplyChannels(): Promise<unknown[]> {
  try {
    const response = await requestRolesServiceJson<{
      channels?: unknown[];
    }>("/api/channels");
    if (response.ok && Array.isArray((response.body as { channels?: unknown[] }).channels)) {
      const channels = (response.body as { channels: unknown[] }).channels;
      if (channels.length > 0) return channels;
    }
  } catch {
    // fall through
  }
  return [DEFAULT_FALLBACK_REPLY_CHANNEL];
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
