import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildPmResolverPrompt, startPmResolver } from "../pm-resolver";
import { MERIDIAN_TOOL_DISPLAY_COMMAND } from "../tool-entrypoint";
import { AgentDispatcherConfigSchema } from "../../../types";
import type { MeridianApiClient } from "../meridian-api-client";

describe("buildPmResolverPrompt", () => {
  const config = AgentDispatcherConfigSchema.parse({
    dispatch_plan_path: "/tmp/taskspec/dispatch_plan.md",
    command_file_path: "/tmp/taskspec/dispatch_command.md",
    user_reply_channels: [{ channel: "telegram", chat_id: "telegram:dispatcher" }],
    agent_type: "codex",
    mode: "bridge",
    kill_policy: "always",
    auto_approve: true,
    pm_resolver: {
      enabled: true,
      agent_type: "codex",
      mode: "bridge",
      auto_approve: true,
      user_reply_channels: [{ channel: "telegram", chat_id: "telegram:pm" }]
    }
  });

  it("gives PM resolvers a close-the-loop dispatcher control contract", () => {
    const prompt = buildPmResolverPrompt({
      dispatcherId: "agent-dispatcher-pm",
      config,
      issue: {
        status: "manual_intervention_required",
        workerId: "BATCH-1-GATE",
        source: "watchdog",
        message: "BATCH-1-GATE reported a blocking failure"
      }
    });

    expect(prompt).toContain(MERIDIAN_TOOL_DISPLAY_COMMAND);
    expect(prompt).toContain("update-status --plan /tmp/taskspec/dispatch_plan.md --worker BATCH-1-GATE --status completed");
    expect(prompt).toContain("resume-worker --plan /tmp/taskspec/dispatch_plan.md --worker BATCH-1-GATE --action retry --force true");
    expect(prompt).toContain("continue-dispatcher --dispatcher agent-dispatcher-pm [--worker <worker_id>]");
    expect(prompt).toContain("notify --message \"<text>\" --urgency <low|normal|high>");
    expect(prompt).toContain("Do not stop with only advice");
    expect(prompt).toContain("Close the loop");
  });

  it("records PM resolver start and completion in the dispatch lifecycle sidecar", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-pm-resolver-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const sidecarPath = path.join(tempDir, "dispatch_threads.json");

    await fs.writeFile(dispatchPlanPath, [
      "| Status | Batch | Worker | Task | Model | Depends On |",
      "|--------|-------|--------|------|-------|------------|",
      "| ⛔ BLOCKED | 1 | BATCH-1-GATE | Verify gates | CODEX | — |"
    ].join("\n"), "utf8");

    const meridianApi: MeridianApiClient = {
      spawn: async () => ({ threadId: "pm-thread-123" }),
      run: async () => ({
        threadId: "pm-thread-123",
        status: "success",
        runState: "completed",
        content: "PM closed the loop and continued the dispatcher.",
        raw: {
          trace_id: "44444444-4444-4444-8444-444444444444",
          summary_text: "PM closed the loop.",
          details_text: [
            "Your message:",
            "Resolve BATCH-1-GATE",
            "",
            "Agent reply:",
            "PM closed the loop and continued the dispatcher."
          ].join("\n"),
          timestamp: "2026-05-03T00:00:00.000Z"
        }
      }),
      kill: async () => ({ threadId: "pm-thread-123", status: "killed", raw: {} })
    };

    try {
      await startPmResolver({
        dispatcherId: "agent-dispatcher-pm",
        config: {
          ...config,
          dispatch_plan_path: dispatchPlanPath
        },
        issue: {
          status: "manual_intervention_required",
          workerId: "BATCH-1-GATE",
          source: "watchdog",
          message: "Blocked gate needs PM"
        }
      }, { meridianApi });

      await waitForExpect(async () => {
        const state = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
          pm_resolvers?: Array<{
            thread_id: string;
            status: string;
            issue: { worker_id?: string };
            result?: { content?: string };
          }>;
        };
        expect(state.pm_resolvers).toEqual([
          expect.objectContaining({
            thread_id: "pm-thread-123",
            status: "completed",
            issue: expect.objectContaining({
              worker_id: "BATCH-1-GATE"
            }),
            result: expect.objectContaining({
              content: "PM closed the loop and continued the dispatcher."
            })
          })
        ]);
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForExpect(assertion: () => void | Promise<void>, timeoutMs = 250): Promise<void> {
  const started = Date.now();
  let lastError: unknown = null;

  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (lastError) {
    throw lastError;
  }
}
