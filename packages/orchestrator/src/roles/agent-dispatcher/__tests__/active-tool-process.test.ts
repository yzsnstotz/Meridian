import { describe, expect, it } from "vitest";

import type { DispatchPlanWorkerRow } from "../../../tool-gateway/tools/dispatch-status";
import { isAgentapiProcessAliveForThread, isWorkerToolProcessRunning } from "../active-tool-process";

describe("isWorkerToolProcessRunning", () => {
  it("matches scheduler runtime tool processes using the scheduler-provided scan run id", () => {
    const row = buildRow({
      task: "`github-ai-automation-scan classify` runs structured classification"
    });
    const activeProcessCommands = [
      "/workspace/tools/github-ai-automation-scan/.venv/bin/python "
        + "/workspace/tools/github-ai-automation-scan/.venv/bin/github-ai-automation-scan "
        + "classify --scan-run-id daily-2026-05-02 --format json"
    ];

    expect(isWorkerToolProcessRunning(row, "daily-2026-05-02", activeProcessCommands)).toBe(true);
  });
});

describe("isAgentapiProcessAliveForThread", () => {
  it("returns true when an agentapi process command references the agent socket for the thread id", () => {
    const commands = [
      "  12345 /usr/local/bin/agentapi server --socket=/tmp/agentapi-codex_06.sock --model gpt-5.4",
      "  98765 zsh"
    ];
    expect(isAgentapiProcessAliveForThread("codex_06", commands)).toBe(true);
  });

  it("returns false when no process command mentions the agent socket for the thread id", () => {
    const commands = [
      "  12345 /usr/local/bin/agentapi server --socket=/tmp/agentapi-codex_07.sock --model gpt-5.4",
      "  98765 zsh"
    ];
    expect(isAgentapiProcessAliveForThread("codex_06", commands)).toBe(false);
  });

  it("treats a thread-id substring inside an unrelated path as a non-match (requires the .sock suffix)", () => {
    const commands = [
      "  12345 /Users/foo/codex_06/bin/agentapi server --socket=/tmp/agentapi-codex_99.sock"
    ];
    expect(isAgentapiProcessAliveForThread("codex_06", commands)).toBe(false);
  });

  it("returns false on empty thread id or empty process list", () => {
    expect(isAgentapiProcessAliveForThread("", ["agentapi --socket=/tmp/agentapi-codex_06.sock"])).toBe(false);
    expect(isAgentapiProcessAliveForThread("codex_06", [])).toBe(false);
  });
});

function buildRow(overrides: Partial<DispatchPlanWorkerRow> = {}): DispatchPlanWorkerRow {
  return {
    status: "⚠️ ABANDONED",
    batch: "4",
    worker_id: "W-CLASSIFY",
    task: null,
    model: "CODEX-HIGH",
    depends_on: ["W-PREFILTER"],
    prds_to_attach: null,
    notes: null,
    ...overrides
  };
}
