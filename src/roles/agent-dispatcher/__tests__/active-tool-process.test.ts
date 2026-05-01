import { describe, expect, it } from "vitest";

import type { DispatchPlanWorkerRow } from "../../../tool-gateway/tools/dispatch-status";
import { isWorkerToolProcessRunning } from "../active-tool-process";

describe("isWorkerToolProcessRunning", () => {
  it("matches scheduler runtime tool processes using the scheduler-provided scan run id", () => {
    const row = buildRow({
      task: "`github-ai-automation-scan classify` runs structured classification"
    });
    const activeProcessCommands = [
      "/Users/yzliu/work/tools/github-ai-automation-scan/.venv/bin/python "
        + "/Users/yzliu/work/tools/github-ai-automation-scan/.venv/bin/github-ai-automation-scan "
        + "classify --scan-run-id daily-2026-05-02 --format json"
    ];

    expect(isWorkerToolProcessRunning(row, "daily-2026-05-02", activeProcessCommands)).toBe(true);
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
