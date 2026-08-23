import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn(() => ""));
const rmSyncMock = vi.hoisted(() => vi.fn());
const processKillSpy = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    rmSync: rmSyncMock
  };
});

// Replace process.kill so tests don't actually signal real PIDs.
const realProcessKill = process.kill;
beforeEach(() => {
  execFileSyncMock.mockReset();
  rmSyncMock.mockReset();
  processKillSpy.mockReset();
  (process as { kill: typeof process.kill }).kill = ((pid: number, sig: NodeJS.Signals | number) => {
    processKillSpy(pid, sig);
    return true;
  }) as typeof process.kill;
});

afterEach(() => {
  (process as { kill: typeof process.kill }).kill = realProcessKill;
});

import { killAttachedAgentapiThread } from "../thread-killer";

function psOutput(rows: Array<{ pid: number; ppid: number; command: string }>): string {
  return rows.map((r) => `${r.pid} ${r.ppid} ${r.command}`).join("\n") + "\n";
}

describe("killAttachedAgentapiThread", () => {
  it("returns empty result and cleans socket when no matching processes", async () => {
    execFileSyncMock.mockReturnValueOnce(psOutput([
      { pid: 100, ppid: 1, command: "/some/other/process" }
    ]));

    const result = await killAttachedAgentapiThread("codex_99", { sigtermWaitMs: 0 });

    expect(result.pidsKilled).toEqual([]);
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(rmSyncMock).toHaveBeenCalledWith("/tmp/agentapi-codex_99.sock", { force: true });
    expect(result.socketsRemoved).toEqual(["/tmp/agentapi-codex_99.sock"]);
  });

  it("SIGTERMs the matching agentapi parent and its codex children", async () => {
    // First ps call: discovery
    execFileSyncMock.mockReturnValueOnce(psOutput([
      { pid: 500, ppid: 1, command: "agentapi server --socket=/tmp/agentapi-codex_42.sock --type=codex" },
      { pid: 501, ppid: 500, command: "codex --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
      { pid: 999, ppid: 1, command: "unrelated process" }
    ]));
    // Second ps call: verify after SIGTERM — both gone
    execFileSyncMock.mockReturnValueOnce(psOutput([
      { pid: 999, ppid: 1, command: "unrelated process" }
    ]));

    const result = await killAttachedAgentapiThread("codex_42", { sigtermWaitMs: 0 });

    expect(processKillSpy).toHaveBeenCalledTimes(2);
    expect(processKillSpy).toHaveBeenCalledWith(500, "SIGTERM");
    expect(processKillSpy).toHaveBeenCalledWith(501, "SIGTERM");
    expect(result.pidsResistedTerm).toEqual([]);
    expect(result.pidsKilled.sort()).toEqual([500, 501]);
    expect(rmSyncMock).toHaveBeenCalledWith("/tmp/agentapi-codex_42.sock", { force: true });
  });

  it("escalates to SIGKILL for stragglers that survived SIGTERM", async () => {
    execFileSyncMock.mockReturnValueOnce(psOutput([
      { pid: 700, ppid: 1, command: "agentapi server --socket=/tmp/agentapi-codex_07.sock --type=codex" }
    ]));
    // Verify: parent still alive
    execFileSyncMock.mockReturnValueOnce(psOutput([
      { pid: 700, ppid: 1, command: "agentapi server --socket=/tmp/agentapi-codex_07.sock --type=codex" }
    ]));

    const result = await killAttachedAgentapiThread("codex_07", { sigtermWaitMs: 0 });

    expect(processKillSpy.mock.calls).toEqual([
      [700, "SIGTERM"],
      [700, "SIGKILL"]
    ]);
    expect(result.pidsResistedTerm).toEqual([700]);
  });

  it("ignores ESRCH on signal (process already gone)", async () => {
    execFileSyncMock.mockReturnValueOnce(psOutput([
      { pid: 800, ppid: 1, command: "agentapi server --socket=/tmp/agentapi-codex_08.sock" }
    ]));
    execFileSyncMock.mockReturnValueOnce("");

    (process as { kill: typeof process.kill }).kill = ((pid: number, sig: NodeJS.Signals | number) => {
      processKillSpy(pid, sig);
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as typeof process.kill;

    const result = await killAttachedAgentapiThread("codex_08", { sigtermWaitMs: 0 });

    expect(result.errors).toEqual([]);
  });

  it("surfaces non-ESRCH signal errors", async () => {
    execFileSyncMock.mockReturnValueOnce(psOutput([
      { pid: 900, ppid: 1, command: "agentapi server --socket=/tmp/agentapi-codex_09.sock" }
    ]));
    execFileSyncMock.mockReturnValueOnce("");

    (process as { kill: typeof process.kill }).kill = ((pid: number, sig: NodeJS.Signals | number) => {
      processKillSpy(pid, sig);
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill;

    const result = await killAttachedAgentapiThread("codex_09", { sigtermWaitMs: 0 });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("EPERM");
  });

  it("rejects empty threadId", async () => {
    const result = await killAttachedAgentapiThread("   ", { sigtermWaitMs: 0 });
    expect(result.errors).toContain("threadId is empty");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("still tries to remove socket when ps probe fails", async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("ps not found");
    });

    const result = await killAttachedAgentapiThread("codex_77", { sigtermWaitMs: 0 });

    expect(result.errors.some((e) => e.includes("ps probe failed"))).toBe(true);
    expect(rmSyncMock).toHaveBeenCalledWith("/tmp/agentapi-codex_77.sock", { force: true });
  });
});
