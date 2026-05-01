import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  tryContinueDispatchWorker,
  type WatchdogContinueDispatcher
} from "../index";
import { StateStore } from "../state-store";
import type { AppState } from "../types";

describe("watchdog direct dispatcher recovery", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    tempDirs = [];
    vi.restoreAllMocks();
  });

  it("routes direct worker recovery through dispatcher continuation so validation can intercept first", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-watchdog-recovery-"));
    tempDirs.push(tempDir);

    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(tempDir, "state.json"));
    const state: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-validation-recovery",
          roleType: "agent-dispatcher",
          status: "active",
          config: {
            dispatch_plan_path: dispatchPlanPath,
            command_file_path: path.join(tempDir, "dispatch_command.md"),
            user_reply_channels: [
              {
                channel: "telegram",
                chat_id: "telegram:ops"
              }
            ],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always",
            validator: {
              enabled: true,
              agent_type: "codex",
              mode: "bridge",
              pass_threshold: 0.85,
              max_fix_cycles: 3,
              base_branch: "main"
            }
          }
        }
      ],
      promptStore: {}
    };
    await stateStore.save(state);

    const continueDispatcher = vi.fn<WatchdogContinueDispatcher>().mockResolvedValue({
      ok: true,
      status: "validation_in_progress",
      message: "validation started for N-04",
      worker: "N-04",
      validation_outcome: "started"
    });

    await expect(
      tryContinueDispatchWorker(
        stateStore,
        dispatchPlanPath,
        "N-05",
        continueDispatcher,
        silentLog()
      )
    ).resolves.toEqual({
      status: "validation_in_progress",
      workerId: "N-04",
      message: "validation started for N-04"
    });

    expect(continueDispatcher).toHaveBeenCalledWith("agent-dispatcher-validation-recovery", "N-05");
  });
});

function silentLog(): typeof console {
  return {
    ...console,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}
