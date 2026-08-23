import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeValidationStateIdentity,
  isValidationStateIdentityUnchanged,
  stripOrchestratorReportSections,
  summarizeValidationStateIdentity,
  type ComputeValidationStateIdentityInput,
  type ValidationStateIdentityIo
} from "../validation-state-identity";

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

describe("computeValidationStateIdentity", () => {
  it("digests branch head, task card, capsule and expected outputs", async () => {
    const round = await createRound({
      card: "# W1-01\n\nDo the thing.\n",
      capsule: "## Files Owned\n- src/a.ts\n",
      report: "cycle 1 report\n"
    });

    const identity = computeValidationStateIdentity(
      buildInput(round, { branch: "round/W1-01", expectedOutputs: [round.reportPath] }),
      { execFile: () => "0123456789abcdef0123456789abcdef01234567\n" }
    );

    expect(summarizeValidationStateIdentity(identity)).toEqual({
      branch: "present",
      card: "present",
      capsule: "present",
      outputs: "present"
    });
    expect(identity.observed).toBe(true);
    expect(identity.determinate).toBe(true);
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same fingerprint when nothing on disk moved", async () => {
    const round = await createRound({ card: "card\n", capsule: "capsule\n", report: "report\n" });
    const io: ValidationStateIdentityIo = { execFile: () => `${"a".repeat(40)}\n` };
    const input = buildInput(round, { branch: "round/W1-01", expectedOutputs: [round.reportPath] });

    const first = computeValidationStateIdentity({ ...input, cycle: 1 }, io);
    const second = computeValidationStateIdentity({ ...input, cycle: 2 }, io);

    expect(second.fingerprint).toBe(first.fingerprint);
    // The cycle number is metadata, not part of the identity.
    expect(second.cycle).toBe(2);
    expect(isValidationStateIdentityUnchanged(first, second)).toBe(true);
  });

  it("changes the fingerprint when the branch head advances", async () => {
    const round = await createRound({ card: "card\n", capsule: "capsule\n", report: "report\n" });
    const input = buildInput(round, { branch: "round/W1-01", expectedOutputs: [round.reportPath] });

    const first = computeValidationStateIdentity(input, { execFile: () => `${"a".repeat(40)}\n` });
    const second = computeValidationStateIdentity(input, { execFile: () => `${"b".repeat(40)}\n` });

    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(isValidationStateIdentityUnchanged(first, second)).toBe(false);
  });

  it("changes the fingerprint when the report content changes", async () => {
    const round = await createRound({ card: "card\n", capsule: "capsule\n", report: "cycle 1\n" });
    const io: ValidationStateIdentityIo = { execFile: () => `${"a".repeat(40)}\n` };
    const input = buildInput(round, { branch: "round/W1-01", expectedOutputs: [round.reportPath] });

    const first = computeValidationStateIdentity(input, io);
    await fs.writeFile(round.reportPath, "cycle 2 — reworked\n", "utf8");
    const second = computeValidationStateIdentity(input, io);

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("changes the fingerprint when the task card is amended", async () => {
    const round = await createRound({ card: "card v1\n", capsule: "capsule\n", report: "report\n" });
    const io: ValidationStateIdentityIo = { execFile: () => `${"a".repeat(40)}\n` };
    const input = buildInput(round, { branch: "round/W1-01", expectedOutputs: [round.reportPath] });

    const first = computeValidationStateIdentity(input, io);
    await fs.writeFile(round.cardPath, "card v2 — scope widened\n", "utf8");
    const second = computeValidationStateIdentity(input, io);

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("records a NO-GIT row's missing branch as absent, not as identical", async () => {
    const round = await createRound({
      workerId: "BATCH-8-GATE",
      card: "# BATCH-8-GATE\n",
      capsule: "## Acceptance Commands\n",
      report: "gate report\n"
    });
    const execFile = vi.fn();

    const identity = computeValidationStateIdentity(
      buildInput(round, { branch: null, expectedOutputs: [round.reportPath] }),
      { execFile }
    );

    expect(summarizeValidationStateIdentity(identity).branch).toBe("absent");
    // No branch means no git question to ask — the guard must never shell out
    // and read an empty `git log` as "no new commits".
    expect(execFile).not.toHaveBeenCalled();
    // Card + capsule + report are still real evidence, so the row IS comparable.
    expect(identity.determinate).toBe(true);
  });

  it("marks a declared-but-unresolvable branch as unresolved and refuses comparison", async () => {
    const round = await createRound({ card: "card\n", capsule: "capsule\n", report: "report\n" });
    const input = buildInput(round, { branch: "round/W1-01", expectedOutputs: [round.reportPath] });
    const io: ValidationStateIdentityIo = {
      execFile: () => {
        throw new Error("fatal: Needed a single revision");
      }
    };

    const first = computeValidationStateIdentity(input, io);
    const second = computeValidationStateIdentity(input, io);

    expect(summarizeValidationStateIdentity(first).branch).toBe("unresolved");
    expect(first.observed).toBe(true);
    expect(first.determinate).toBe(false);
    // Byte-equal fingerprints, but they encode ignorance about the branch —
    // comparing them would route a row that may well have advanced to PM.
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(isValidationStateIdentityUnchanged(first, second)).toBe(false);
  });

  it("refuses comparison when nothing at all was observable", async () => {
    const round = await createRound({});
    const input = buildInput(round, { branch: null, expectedOutputs: [] });

    const first = computeValidationStateIdentity(input, {});
    const second = computeValidationStateIdentity(input, {});

    expect(summarizeValidationStateIdentity(first)).toEqual({
      branch: "absent",
      card: "absent",
      capsule: "absent",
      outputs: "absent"
    });
    expect(first.observed).toBe(false);
    expect(first.determinate).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(isValidationStateIdentityUnchanged(first, second)).toBe(false);
  });

  it("treats a not-yet-written report as absent but an unreadable one as unresolved", async () => {
    const round = await createRound({ card: "card\n" });
    const missingReport = path.join(round.directory, "reports", "W1-01.md");

    const absent = computeValidationStateIdentity(
      buildInput(round, { branch: null, expectedOutputs: [missingReport] }),
      {}
    );
    expect(summarizeValidationStateIdentity(absent).outputs).toBe("absent");
    expect(absent.determinate).toBe(true);

    const unreadable = computeValidationStateIdentity(
      buildInput(round, { branch: null, expectedOutputs: [missingReport] }),
      {
        readFile: (filePath: string) => {
          if (filePath === missingReport) {
            const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
      }
    );
    expect(summarizeValidationStateIdentity(unreadable).outputs).toBe("unresolved");
    expect(unreadable.determinate).toBe(false);
  });

  it("resolves a real branch head through git", async () => {
    const round = await createRound({ card: "card\n" });
    const repo = await createGitRepo();

    const identity = computeValidationStateIdentity(
      buildInput(round, { branch: repo.branch, expectedOutputs: [], repoDir: repo.directory })
    );

    expect(summarizeValidationStateIdentity(identity).branch).toBe("present");
    const branchComponent = identity.components.find((component) => component.key === "branch");
    expect(branchComponent?.value).toBe(`${repo.branch}@${repo.headSha}`);
  });

  it("refuses a branch name that would be parsed as a git flag", async () => {
    const round = await createRound({ card: "card\n" });
    const execFile = vi.fn();

    const identity = computeValidationStateIdentity(
      buildInput(round, { branch: "--upload-pack=evil", expectedOutputs: [] }),
      { execFile }
    );

    expect(summarizeValidationStateIdentity(identity).branch).toBe("unresolved");
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("stripOrchestratorReportSections", () => {
  const workerAuthored = [
    "# W1-01 Report",
    "",
    "## Summary",
    "",
    "Implemented the thing.",
    "",
    "## Evidence",
    "",
    "- `npm test` green"
  ].join("\n");

  it("removes the validator-report sections the orchestrator appends itself", () => {
    // Byte-shaped exactly like `appendWorkerReportHistory` writes it. Without
    // this normalisation the report would differ after every cycle purely
    // because WE wrote to it, and the guard could never fire.
    const withAppends = [
      workerAuthored,
      "",
      "",
      "---",
      "",
      "## Validator Report - W1-01 - Cycle 1",
      "",
      "- Validator Thread: codex_19",
      "- Score: 0.5",
      "",
      "Feedback:",
      "",
      "Acceptance criterion 3 is unmet.",
      "",
      "",
      "---",
      "",
      "## Validator Report - W1-01 - Cycle 2",
      "",
      "- Validator Thread: codex_23",
      "- Score: 0.5",
      ""
    ].join("\n");

    expect(stripOrchestratorReportSections(withAppends)).toBe(
      stripOrchestratorReportSections(workerAuthored)
    );
  });

  it("removes PM resolver and PM clarification sections too", () => {
    const withPmSections = [
      workerAuthored,
      "",
      "",
      "---",
      "",
      "## PM Resolver Report - W1-01",
      "",
      "Escalated to human.",
      "",
      "",
      "---",
      "",
      "## PM Clarification — Auto-delegated to W1-04 (validator cycle 2)",
      "",
      "Criterion delegated.",
      ""
    ].join("\n");

    expect(stripOrchestratorReportSections(withPmSections)).toBe(
      stripOrchestratorReportSections(workerAuthored)
    );
  });

  it("keeps worker content that follows an appended section", () => {
    const reworked = [
      workerAuthored,
      "",
      "---",
      "",
      "## Validator Report - W1-01 - Cycle 1",
      "",
      "- Score: 0.5",
      "",
      "## Rework Notes",
      "",
      "Addressed criterion 3 by widening the guard."
    ].join("\n");

    const stripped = stripOrchestratorReportSections(reworked);
    expect(stripped).toContain("## Rework Notes");
    expect(stripped).toContain("Addressed criterion 3");
    expect(stripped).not.toContain("Validator Report");
    expect(stripped).not.toBe(stripOrchestratorReportSections(workerAuthored));
  });
});

describe("isValidationStateIdentityUnchanged", () => {
  const determinate = {
    fingerprint: "f".repeat(64),
    cycle: 1,
    observed: true,
    determinate: true,
    components: []
  };

  it("is false when there is no previous fingerprint (cycle 1)", () => {
    expect(isValidationStateIdentityUnchanged(null, determinate)).toBe(false);
    expect(isValidationStateIdentityUnchanged(undefined, determinate)).toBe(false);
  });

  it("is false when either side is indeterminate, even on an exact match", () => {
    const indeterminate = { ...determinate, determinate: false };
    expect(isValidationStateIdentityUnchanged(indeterminate, determinate)).toBe(false);
    expect(isValidationStateIdentityUnchanged(determinate, indeterminate)).toBe(false);
  });

  it("is true only for a determinate byte-equal match", () => {
    expect(isValidationStateIdentityUnchanged(determinate, { ...determinate, cycle: 2 })).toBe(true);
    expect(
      isValidationStateIdentityUnchanged(determinate, { ...determinate, fingerprint: "a".repeat(64) })
    ).toBe(false);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Round {
  directory: string;
  dispatchPlanPath: string;
  workerId: string;
  cardPath: string;
  capsulePath: string;
  reportPath: string;
}

async function createRound(options: {
  workerId?: string;
  card?: string;
  capsule?: string;
  report?: string;
}): Promise<Round> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-identity-"));
  tempDirectories.add(directory);
  const workerId = options.workerId ?? "W1-01";
  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");

  const cardPath = path.join(directory, `${workerId}.md`);
  const capsulePath = path.join(directory, "context", `${workerId}-context.md`);
  const reportPath = path.join(directory, "reports", `${workerId}.md`);

  if (options.card !== undefined) {
    await fs.writeFile(cardPath, options.card, "utf8");
  }
  if (options.capsule !== undefined) {
    await fs.mkdir(path.dirname(capsulePath), { recursive: true });
    await fs.writeFile(capsulePath, options.capsule, "utf8");
  }
  if (options.report !== undefined) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, options.report, "utf8");
  }

  return { directory, dispatchPlanPath, workerId, cardPath, capsulePath, reportPath };
}

function buildInput(
  round: Round,
  options: { branch: string | null; expectedOutputs: readonly string[]; repoDir?: string }
): ComputeValidationStateIdentityInput {
  return {
    workerId: round.workerId,
    dispatchPlanPath: round.dispatchPlanPath,
    branch: options.branch,
    repoDir: options.repoDir ?? round.directory,
    expectedOutputs: options.expectedOutputs,
    cycle: 1
  };
}

async function createGitRepo(): Promise<{ directory: string; branch: string; headSha: string }> {
  const { execFileSync } = await import("node:child_process");
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-identity-git-"));
  tempDirectories.add(directory);
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "identity@test.invalid");
  git("config", "user.name", "Identity Test");
  await fs.writeFile(path.join(directory, "file.txt"), "hello\n", "utf8");
  git("add", "file.txt");
  git("commit", "--quiet", "-m", "initial");
  git("branch", "round/W1-01");

  return {
    directory,
    branch: "round/W1-01",
    headSha: git("rev-parse", "round/W1-01").trim().toLowerCase()
  };
}
