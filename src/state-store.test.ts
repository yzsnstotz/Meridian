import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSystemPromptFromConfig, materializeDispatcherSystemPrompt } from "./roles/agent-dispatcher/prompt-builder";
import type { AppState } from "./types";
import { StateStore, isStartupRehydratableRoleStatus } from "./state-store";

const sampleState: AppState = {
  roles: [
    {
      threadId: "dispatcher-1",
      roleType: "dispatcher",
      config: {
        tasks: []
      },
      status: "active"
    }
  ],
  promptStore: {
    "dispatcher-1": {
      system_prompt: "System prompt",
      task_templates: {
        taskA: "Run task A"
      }
    }
  }
};

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    })
  );

  tempDirectories.clear();
});

describe("StateStore", () => {
  it("treats paused roles as startup rehydratable", () => {
    expect(isStartupRehydratableRoleStatus("active")).toBe(true);
    expect(isStartupRehydratableRoleStatus("paused")).toBe(true);
    expect(isStartupRehydratableRoleStatus("needs_reactivation")).toBe(true);
    expect(isStartupRehydratableRoleStatus("completed")).toBe(false);
  });

  it("returns null when the state file does not exist", async () => {
    const directory = await createTempDirectory();
    const store = new StateStore(path.join(directory, "missing", "state.json"));

    await expect(store.load()).resolves.toBeNull();
  });

  it("creates the target directory and round-trips app state", async () => {
    const directory = await createTempDirectory();
    const stateFilePath = path.join(directory, "nested", "state.json");
    const store = new StateStore(stateFilePath);

    await store.save(sampleState);

    await expect(store.load()).resolves.toEqual(sampleState);
    await expect(fs.readFile(stateFilePath, "utf8")).resolves.toContain("\"threadId\": \"dispatcher-1\"");
  });

  it("uses isolated temporary files for concurrent saves", async () => {
    const directory = await createTempDirectory();
    const stateFilePath = path.join(directory, "state.json");
    let writesStarted = 0;
    const writePaths = new Set<string>();
    let releaseWrites: (() => void) | null = null;
    const allWritesStarted = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });

    const store = new StateStore(stateFilePath, {
      mkdir: fs.mkdir.bind(fs),
      writeFile: async (targetPath, contents, encoding) => {
        writePaths.add(String(targetPath));
        writesStarted += 1;
        if (writesStarted === 2) {
          releaseWrites?.();
        }
        await allWritesStarted;
        await fs.writeFile(targetPath, contents, encoding);
      },
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
      readFile: fs.readFile.bind(fs)
    });

    const secondState: AppState = {
      ...sampleState,
      roles: [
        {
          ...sampleState.roles[0],
          threadId: "dispatcher-2"
        }
      ]
    };

    await expect(Promise.all([store.save(sampleState), store.save(secondState)])).resolves.toHaveLength(2);
    expect(writePaths.size).toBe(2);
    const loaded = await store.load();
    expect(["dispatcher-1", "dispatcher-2"]).toContain(loaded?.roles[0]?.threadId);
  });

  it("normalizes persisted agent-dispatcher roots and generated prompts on load", async () => {
    const directory = await createTempDirectory();
    const repoRoot = path.join(directory, "projects/clawso");
    const docsRoot = path.join(directory, "Docs");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(docsRoot, { recursive: true });

    const dispatchPlanPath = path.join(
      directory,
      "Docs/Projects/clawso/branch/feat-cli/taskspec/dispatch_plan.md"
    );
    const commandFilePath = path.join(
      directory,
      "Docs/Projects/clawso/branch/feat-cli/taskspec/agent_dispatch_command.md"
    );
    await fs.mkdir(path.dirname(dispatchPlanPath), { recursive: true });
    await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");
    await fs.writeFile(commandFilePath, "# command\n", "utf8");

    const threadId = "agent-dispatcher-rehydrated";
    const staleConfig = {
      tasks: [],
      dispatch_plan_path: dispatchPlanPath,
      command_file_path: commandFilePath,
      dispatch_repo_root: directory,
      docs_root: docsRoot,
      user_reply_channels: [
        {
          channel: "telegram" as const,
          chat_id: "telegram:ops"
        }
      ],
      agent_type: "codex" as const,
      mode: "pane_bridge" as const,
      kill_policy: "always" as const,
      auto_approve: false,
      use_agent_dispatcher: true
    };
    const staleState: AppState = {
      roles: [
        {
          threadId,
          roleType: "agent-dispatcher",
          config: {
            ...staleConfig,
            system_prompt: materializeDispatcherSystemPrompt(buildSystemPromptFromConfig(staleConfig), threadId)
          },
          status: "active"
        }
      ],
      promptStore: {}
    };
    const store = new StateStore(path.join(directory, "state.json"));

    await store.save(staleState);

    const loaded = await store.load();
    expect(loaded?.roles[0]?.config).toMatchObject({
      dispatch_repo_root: directory,
      docs_root: docsRoot
    });
    expect((loaded?.roles[0]?.config as { system_prompt?: string }).system_prompt).toContain(
      `dispatch_repo_root: ${directory}`
    );
  });

  it("preserves the last complete state if rename fails", async () => {
    const directory = await createTempDirectory();
    const stateFilePath = path.join(directory, "state.json");
    const renameError = Object.assign(new Error("rename failed"), { code: "EXDEV" });
    let tempFilePath = "";
    const store = new StateStore(stateFilePath, {
      mkdir: fs.mkdir.bind(fs),
      writeFile: async (targetPath, contents, encoding) => {
        tempFilePath = String(targetPath);
        await fs.writeFile(targetPath, contents, encoding);
      },
      rename: async () => {
        throw renameError;
      },
      unlink: fs.unlink.bind(fs),
      readFile: fs.readFile.bind(fs)
    });

    await new StateStore(stateFilePath).save(sampleState);
    const originalContents = await fs.readFile(stateFilePath, "utf8");

    const updatedState: AppState = {
      ...sampleState,
      roles: [
        {
          ...sampleState.roles[0],
          threadId: "dispatcher-2"
        }
      ]
    };

    await expect(store.save(updatedState)).rejects.toThrow(
      `Failed to replace state file at "${stateFilePath}" while saving state to "${stateFilePath}". rename failed.`
    );
    await expect(fs.readFile(stateFilePath, "utf8")).resolves.toBe(originalContents);
    expect(tempFilePath).not.toBe("");
    await expect(fs.access(tempFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps directory creation failures with an actionable STATE_FILE_PATH hint", async () => {
    const stateFilePath = "/var/lib/meridian-roles/state.json";
    const directoryError = Object.assign(
      new Error("EACCES: permission denied, mkdir '/var/lib/meridian-roles'"),
      { code: "EACCES" }
    );
    const store = new StateStore(stateFilePath, {
      mkdir: async () => {
        throw directoryError;
      },
      writeFile: fs.writeFile.bind(fs),
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
      readFile: fs.readFile.bind(fs)
    });

    await expect(store.save(sampleState)).rejects.toThrow(
      'Failed to create state directory at "/var/lib/meridian-roles" while saving state to "/var/lib/meridian-roles/state.json".'
    );
    await expect(store.save(sampleState)).rejects.toThrow('Set STATE_FILE_PATH to a writable absolute path');
  });

  it("cleans up temp files when writing the temporary state file fails", async () => {
    const directory = await createTempDirectory();
    const stateFilePath = path.join(directory, "state.json");
    let tempFilePath = "";
    const writeError = Object.assign(new Error("EACCES: permission denied, open temp file"), { code: "EACCES" });
    const store = new StateStore(stateFilePath, {
      mkdir: fs.mkdir.bind(fs),
      writeFile: async (targetPath, contents, encoding) => {
        tempFilePath = String(targetPath);
        await fs.writeFile(targetPath, contents, encoding);
        throw writeError;
      },
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
      readFile: fs.readFile.bind(fs)
    });

    await expect(store.save(sampleState)).rejects.toThrow("Failed to write temporary state file");
    expect(tempFilePath).not.toBe("");
    await expect(store.save(sampleState)).rejects.toThrow('Set STATE_FILE_PATH to a writable absolute path');
    await expect(fs.access(tempFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-state-store-"));
  tempDirectories.add(directory);
  return directory;
}
