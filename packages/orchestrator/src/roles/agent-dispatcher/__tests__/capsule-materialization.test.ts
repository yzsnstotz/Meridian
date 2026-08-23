import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createCapsuleMaterializationGate,
  describeCapsuleMaterializationHold,
  evaluateCapsuleMaterializationForLaunch,
  inspectCapsuleMaterialization,
  loadCapsuleMaterializationRows,
  loadSpecManifest,
  materializeReadyCapsules,
  parseCapsuleMaterializationPlaceholders,
  resolveCapsuleMaterializationParkedWorkers
} from "../capsule-materialization";
import { resolveEligibleServiceContinueWorkers } from "../service-continuation";
import type { DispatchThreadStateV2, DispatchWorkerState } from "../../../types";

// The live shape. Reproduced verbatim from
// Docs/Projects/clawso/branch/unification-layer-decoupling-2026-08-06/taskspec/context/
// so the parser is tested against what the generator actually emits, including
// the full-width colon, the bold markers, and the CJK sentence terminator.
const UPSTREAM_INPUTS_PLACEHOLDER =
  "⏳ **待物化** —— 依赖行：I-01。其实际 SHA 由 `BATCH-98-GATE`（本波 Integrator）在派发本波前填入。";
const REQUIRED_DECISIONS_PLACEHOLDER =
  "⏳ **待物化** —— 由本波 Integrator 从 `reports/W0-06-decision-registry.md` 提取**本行适用**的条目注入，"
  + "每条含 `decision_id` / `text` / `source` / `source_sha` / `status`。";

const PLAN_PATH = "/rounds/uld/taskspec/dispatch_plan.md";
const CONTEXT_DIR = "/rounds/uld/taskspec/context";

const I_01_SHA = "7712e542d71d0f48e1cf81f0922547d72b46ef00";

function capsulePath(workerId: string): string {
  return path.join(CONTEXT_DIR, `${workerId}-context.md`);
}

function buildCapsule(options: {
  upstream?: string;
  decisions?: string;
} = {}): string {
  return [
    "# I-02 Context Capsule",
    "",
    "## Objective",
    "",
    "Upstream Source Resolver + clean staging",
    "",
    "## Upstream Inputs",
    "",
    options.upstream ?? UPSTREAM_INPUTS_PLACEHOLDER,
    "",
    "## Required Decisions",
    "",
    options.decisions ?? "None required.",
    "",
    "## Files Owned",
    "",
    "- tools/clawso-import/upstream",
    ""
  ].join("\n");
}

function buildWorker(overrides: Partial<DispatchWorkerState> = {}): DispatchWorkerState {
  return {
    thread_id: "",
    trace_id: null,
    started_at: "2026-08-11T10:00:00.000Z",
    last_seen_at: "2026-08-11T10:00:00.000Z",
    status: "pending",
    expected_outputs: [],
    hub_result: null,
    command_preamble: null,
    retry_count: 0,
    ...overrides
  } as DispatchWorkerState;
}

function buildState(workers: Record<string, DispatchWorkerState>): DispatchThreadStateV2 {
  return {
    version: 2,
    dispatcher: { thread_id: "dispatcher-1", started_at: "2026-08-11T09:00:00.000Z", status: "running" },
    workers,
    pm_resolvers: [],
    last_reconciled_at: null
  } as DispatchThreadStateV2;
}

/**
 * In-memory filesystem seam. Missing paths throw a real ENOENT.
 *
 * `errorCodes` injects a NON-ENOENT failure for a path that "exists" but cannot
 * be read (EACCES, EISDIR, EIO). That distinction is load-bearing for the spec
 * precondition: ENOENT on plan.json means the round has no task graph and every
 * row launches, while EACCES on plan.json means the round HAS one we cannot
 * read and every row fails closed.
 */
function buildFsSeam(files: Record<string, string>, errorCodes: Record<string, string> = {}) {
  const written: Record<string, string> = {};
  const reads: string[] = [];
  const readFile = (filePath: string) => {
    reads.push(filePath);
    const injected = errorCodes[filePath];
    if (injected) {
      const error = new Error(`${injected}: injected failure, open '${filePath}'`) as NodeJS.ErrnoException;
      error.code = injected;
      throw error;
    }
    const contents = written[filePath] ?? files[filePath];
    if (contents === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return contents;
  };
  const writeFile = vi.fn((filePath: string, contents: string) => {
    written[filePath] = contents;
  });
  return { readFile, writeFile, written, reads };
}

const SPEC_MANIFEST_PATH = "/rounds/uld/taskspec/plan.json";

function cardPath(workerId: string): string {
  return path.join("/rounds/uld/taskspec", `${workerId}.md`);
}

/**
 * A `plan.json` in the live generator's shape: a `tasks` array whose entries key
 * on `task_id` and carry taskspec-relative `card` / `capsule` paths.
 */
function buildSpecManifest(
  tasks: Array<{ task_id: string; card?: string | null; capsule?: string | null }>
): string {
  return JSON.stringify({
    taskspec_id: "uld-mvp-2026-08-06",
    version: "1.20.0",
    tasks: tasks.map((task) => ({
      task_id: task.task_id,
      role: "implementer",
      wave: 10,
      depends_on: [],
      ...(task.card === undefined ? {} : { card: task.card }),
      ...(task.capsule === undefined ? {} : { capsule: task.capsule }),
      branch: `uld-mvp-2026-08-06/${task.task_id}`
    }))
  });
}

/** The declared-and-fully-present shape: card written, capsule written and filled. */
function buildWrittenRow(workerId: string): Record<string, string> {
  return {
    [cardPath(workerId)]: `# ${workerId}\n\nDo the thing.\n`,
    [capsulePath(workerId)]: buildCapsule({ upstream: `I-01@${I_01_SHA}` })
  };
}

const PLAN_ROWS = [
  { worker: "I-01", branch: "task/I-01" },
  { worker: "I-02", branch: "task/I-02" },
  { worker: "I-07", branch: "task/I-07" }
];

describe("capsule placeholder parsing", () => {
  it("finds the marker under its section and reads the 依赖行 clause", () => {
    const placeholders = parseCapsuleMaterializationPlaceholders(buildCapsule());

    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({
      section: "Upstream Inputs",
      declaredDependencies: ["I-01"]
    });
  });

  it("treats a placeholder with no 依赖行 clause as declaring nothing substitutable", () => {
    const placeholders = parseCapsuleMaterializationPlaceholders(
      buildCapsule({ decisions: REQUIRED_DECISIONS_PLACEHOLDER })
    );

    const decisions = placeholders.find((placeholder) => placeholder.section === "Required Decisions");
    expect(decisions).toBeDefined();
    expect(decisions!.declaredDependencies).toEqual([]);
  });

  it("reads a multi-dependency clause", () => {
    const placeholders = parseCapsuleMaterializationPlaceholders(
      buildCapsule({ upstream: "⏳ **待物化** —— 依赖行：V-01, V-02。其实际 SHA 由 `BATCH-98-GATE` 填入。" })
    );

    expect(placeholders[0]!.declaredDependencies).toEqual(["V-01", "V-02"]);
  });
});

describe("refusal (the safety half)", () => {
  it("refuses to launch a row whose capsule still carries ⏳ 待物化", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });

    const hold = inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "running" }) }),
      readFile: seam.readFile
    });

    expect(hold).toMatchObject({
      workerId: "I-02",
      reason: "awaiting_dependencies",
      pendingDependencies: ["I-01"]
    });
    expect(describeCapsuleMaterializationHold(hold!)).toContain("I-01");
    expect(describeCapsuleMaterializationHold(hold!)).toContain("Upstream Inputs");
  });

  it("permits launch once the capsule carries no placeholder", () => {
    const seam = buildFsSeam({
      [capsulePath("I-02")]: buildCapsule({ upstream: `I-01@${I_01_SHA}` })
    });

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("permits launch when the round has no capsule at all (pre-capsule rounds)", () => {
    const seam = buildFsSeam({});

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({}),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("permits launch on an empty capsule rather than parking a row on a generator artefact", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: "   \n\n" });

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({}),
      readFile: seam.readFile
    })).toBeNull();
  });
});

describe("trigger (the automation half)", () => {
  it("does NOT read or write a SHA while the dependency is still running — §1.48/§4.11 falls out of the trigger condition", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });
    const revParse = vi.fn(() => I_01_SHA);

    const result = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: PLAN_ROWS,
      lifecycleState: buildState({ "I-01": buildWorker({ status: "running" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse
    });

    expect(revParse).not.toHaveBeenCalled();
    expect(seam.writeFile).not.toHaveBeenCalled();
    expect(result.materializedWorkers).toEqual([]);
    expect(result.stillHeld.map((hold) => hold.reason)).toEqual(["awaiting_dependencies"]);
  });

  it("fires on the tick the last dependency reaches completed, and reads the SHA from the real ref", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });
    const revParse = vi.fn(() => `${I_01_SHA}\n`);

    const result = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: PLAN_ROWS,
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse,
      repoRoot: "/repo"
    });

    expect(revParse).toHaveBeenCalledWith("task/I-01", "/repo");
    expect(result.materializedWorkers).toEqual(["I-02"]);
    expect(result.substitutions).toEqual([
      { workerId: "I-02", dependencyId: "I-01", ref: "task/I-01", sha: I_01_SHA }
    ]);
    expect(seam.written[capsulePath("I-02")]).toContain(`I-01@${I_01_SHA}`);
    expect(seam.written[capsulePath("I-02")]).not.toContain("待物化");
    expect(result.stillHeld).toEqual([]);
  });

  it("waits for ALL declared dependencies, not the first one", () => {
    const seam = buildFsSeam({
      [capsulePath("H-01")]: buildCapsule({
        upstream: "⏳ **待物化** —— 依赖行：V-01, V-02。其实际 SHA 由 `BATCH-98-GATE` 填入。"
      })
    });
    const revParse = vi.fn(() => I_01_SHA);
    const rows = [
      { worker: "V-01", branch: "task/V-01" },
      { worker: "V-02", branch: "task/V-02" },
      { worker: "H-01", branch: "task/H-01" }
    ];

    const partial = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows,
      lifecycleState: buildState({
        "V-01": buildWorker({ status: "completed" }),
        "V-02": buildWorker({ status: "running" })
      }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse
    });

    expect(revParse).not.toHaveBeenCalled();
    expect(partial.materializedWorkers).toEqual([]);

    const complete = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows,
      lifecycleState: buildState({
        "V-01": buildWorker({ status: "completed" }),
        "V-02": buildWorker({ status: "completed" })
      }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse
    });

    expect(complete.materializedWorkers).toEqual(["H-01"]);
    expect(seam.written[capsulePath("H-01")]).toContain(`V-01@${I_01_SHA}`);
    expect(seam.written[capsulePath("H-01")]).toContain(`V-02@${I_01_SHA}`);
  });

  it("treats a SKIPPED dependency as not completed — a row that never ran has no SHA to point at", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });
    const revParse = vi.fn(() => I_01_SHA);

    materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: PLAN_ROWS,
      lifecycleState: buildState({ "I-01": buildWorker({ status: "skipped" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse
    });

    expect(revParse).not.toHaveBeenCalled();
    expect(seam.writeFile).not.toHaveBeenCalled();
  });

  it("launches the row on the SAME tick its last dependency completed", () => {
    const seam = buildFsSeam({
      [PLAN_PATH]: [
        "| Status | Batch | Worker | Task | Model | Depends On | Branch | Notes |",
        "|--------|-------|--------|------|-------|------------|--------|-------|",
        "| ✅ | 9 | I-01 | Contract | CODEX | — | task/I-01 | done |",
        "| ⬜ | 9 | I-02 | Resolver | CODEX | I-01 | task/I-02 | ready |"
      ].join("\n"),
      [capsulePath("I-02")]: buildCapsule()
    });

    const hold = evaluateCapsuleMaterializationForLaunch({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => I_01_SHA
    });

    expect(hold).toBeNull();
    expect(seam.written[capsulePath("I-02")]).toContain(`I-01@${I_01_SHA}`);
  });

  it("still refuses the launch when the dependency has not completed", () => {
    const seam = buildFsSeam({
      [PLAN_PATH]: [
        "| Status | Batch | Worker | Task | Model | Depends On | Branch | Notes |",
        "|--------|-------|--------|------|-------|------------|--------|-------|",
        "| 🔄 | 9 | I-01 | Contract | CODEX | — | task/I-01 | running |",
        "| ⬜ | 9 | I-02 | Resolver | CODEX | I-01 | task/I-02 | ready |"
      ].join("\n"),
      [capsulePath("I-02")]: buildCapsule()
    });

    const hold = evaluateCapsuleMaterializationForLaunch({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "running" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => I_01_SHA
    });

    expect(hold).toMatchObject({ reason: "awaiting_dependencies", pendingDependencies: ["I-01"] });
    expect(seam.writeFile).not.toHaveBeenCalled();
  });
});

describe("never invents", () => {
  it("routes an undeclared-dependency placeholder to PM instead of filling it", () => {
    const seam = buildFsSeam({
      [capsulePath("I-02")]: buildCapsule({
        upstream: `I-01@${I_01_SHA}`,
        decisions: REQUIRED_DECISIONS_PLACEHOLDER
      })
    });
    const revParse = vi.fn(() => I_01_SHA);

    const result = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: PLAN_ROWS,
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse
    });

    expect(revParse).not.toHaveBeenCalled();
    expect(seam.writeFile).not.toHaveBeenCalled();
    expect(result.stillHeld).toHaveLength(1);
    expect(result.stillHeld[0]).toMatchObject({ reason: "awaiting_pm" });
    expect(result.stillHeld[0]!.underivableReasons[0]).toContain("Required Decisions");
    expect(describeCapsuleMaterializationHold(result.stillHeld[0]!)).toContain("PM must write");
  });

  it("refuses to invent a SHA for a dependency with no branch", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });
    const revParse = vi.fn(() => I_01_SHA);

    const result = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      // I-01 present but NO-GIT: no ref exists to read a SHA from.
      rows: [{ worker: "I-01", branch: null }, { worker: "I-02", branch: "task/I-02" }],
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse
    });

    expect(revParse).not.toHaveBeenCalled();
    expect(seam.writeFile).not.toHaveBeenCalled();
    expect(result.stillHeld[0]).toMatchObject({ reason: "awaiting_pm" });
  });

  it("refuses to write anything when the ref does not resolve", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });

    const result = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: PLAN_ROWS,
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => {
        throw new Error("fatal: Needed a single revision");
      }
    });

    expect(seam.writeFile).not.toHaveBeenCalled();
    expect(result.stillHeld[0]).toMatchObject({ reason: "awaiting_pm" });
  });

  it("refuses a rev-parse result that is not a full SHA", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });

    materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: PLAN_ROWS,
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => "task/I-01"
    });

    expect(seam.writeFile).not.toHaveBeenCalled();
  });

  it("fails closed when the dispatch plan cannot be read: no branches, so nothing is derivable", () => {
    const rows = loadCapsuleMaterializationRows("/does/not/exist/dispatch_plan.md");
    expect(rows).toEqual([]);
  });
});

describe("read-only gate never fabricates a PM signal", () => {
  it("reports awaiting_fill — not awaiting_pm — for a derivable placeholder it has not attempted", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });
    const lifecycleState = buildState({ "I-01": buildWorker({ status: "completed" }) });

    const gate = createCapsuleMaterializationGate(PLAN_PATH, lifecycleState, { readFile: seam.readFile });

    expect(gate("I-02")).toMatchObject({ reason: "awaiting_fill", underivableReasons: [] });
    expect(describeCapsuleMaterializationHold(gate("I-02")!)).toContain("no operator action");
  });

  it("adopts the sweep's awaiting_pm verdict when seeded with it", () => {
    const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });
    const lifecycleState = buildState({ "I-01": buildWorker({ status: "completed" }) });

    const swept = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: [{ worker: "I-01", branch: null }, { worker: "I-02", branch: "task/I-02" }],
      lifecycleState,
      readFile: seam.readFile,
      writeFile: seam.writeFile
    });

    const gate = createCapsuleMaterializationGate(PLAN_PATH, lifecycleState, {
      readFile: seam.readFile,
      seed: swept.stillHeld
    });

    expect(gate("I-02")).toMatchObject({ reason: "awaiting_pm" });
    expect(describeCapsuleMaterializationHold(gate("I-02")!)).toContain("PM must write");
    expect(describeCapsuleMaterializationHold(gate("I-02")!)).toContain("no branch in the dispatch plan");
  });
});

describe("a parked row does not block its siblings", () => {
  it("keeps the held row out of the candidate set while every unrelated row still launches", () => {
    const seam = buildFsSeam({
      [capsulePath("I-02")]: buildCapsule(),
      [capsulePath("I-07")]: buildCapsule({ upstream: `I-01@${I_01_SHA}` })
    });
    const lifecycleState = buildState({ "I-01": buildWorker({ status: "running" }) });
    const gate = createCapsuleMaterializationGate(PLAN_PATH, lifecycleState, { readFile: seam.readFile });

    const rows = [
      { status: "🔄", batch: "9", worker: "I-01", model: "CODEX", depends_on: "—", notes: null },
      { status: "⬜", batch: "9", worker: "I-02", model: "CODEX", depends_on: "—", notes: null },
      { status: "⬜", batch: "9", worker: "I-07", model: "CODEX", depends_on: "—", notes: null }
    ];

    const candidates = resolveEligibleServiceContinueWorkers(rows, lifecycleState, {
      includeImplicitRunningWorker: false,
      capsuleGate: gate
    });

    expect(candidates).toEqual(["I-07"]);
  });

  it("parks every held row without swallowing the rest of the plan", () => {
    const files: Record<string, string> = {};
    for (const workerId of ["I-02", "I-03", "I-04", "I-05", "I-06"]) {
      files[capsulePath(workerId)] = buildCapsule();
    }
    files[capsulePath("I-07")] = buildCapsule({ upstream: `I-01@${I_01_SHA}` });
    const seam = buildFsSeam(files);
    const lifecycleState = buildState({ "I-01": buildWorker({ status: "running" }) });
    const gate = createCapsuleMaterializationGate(PLAN_PATH, lifecycleState, { readFile: seam.readFile });

    const parked = resolveCapsuleMaterializationParkedWorkers(
      ["I-01", "I-02", "I-03", "I-04", "I-05", "I-06", "I-07"].map((worker) => ({ worker })),
      gate
    );

    expect(parked.map((hold) => hold.workerId)).toEqual(["I-02", "I-03", "I-04", "I-05", "I-06"]);
  });
});

describe("real git ref", () => {
  it("resolves the SHA from an actual repository rather than any recorded value", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-capsule-git-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
      git("init", "--quiet", "--initial-branch", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      fs.writeFileSync(path.join(repoRoot, "README.md"), "seed\n", "utf8");
      git("add", ".");
      git("commit", "--quiet", "-m", "[I-01] seed");
      git("branch", "task/I-01");
      const expectedSha = execFileSync("git", ["rev-parse", "task/I-01"], { cwd: repoRoot, encoding: "utf8" }).trim();

      const seam = buildFsSeam({ [capsulePath("I-02")]: buildCapsule() });
      const result = materializeReadyCapsules({
        dispatchPlanPath: PLAN_PATH,
        rows: PLAN_ROWS,
        lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
        repoRoot,
        readFile: seam.readFile,
        writeFile: seam.writeFile
      });

      expect(result.substitutions[0]!.sha).toBe(expectedSha);
      expect(seam.written[capsulePath("I-02")]).toContain(`I-01@${expectedSha}`);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ─── The spec-file half of the precondition ─────────────────────────────────
//
// Reproduces the 2026-08-11 production defect: I-08 and I-09 were registered in
// plan.json / dispatch_plan.md while their cards and capsules were still being
// authored, and the watchdog launched codex_1543 against files that did not
// exist. The governing distinction throughout is DECLARED vs PRESENT — never
// "there is no file", which is the conflation being repaired.

describe("spec files: declared vs written", () => {
  const lifecycleState = () => buildState({ "I-01": buildWorker({ status: "completed" }) });

  it("launches when plan.json declares the card and capsule and both are written", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-09", card: "I-09.md", capsule: "context/I-09-context.md" }
      ]),
      ...buildWrittenRow("I-09")
    });

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: lifecycleState(),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("parks with spec_not_written when plan.json declares paths and neither file exists", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-09", card: "I-09.md", capsule: "context/I-09-context.md" }
      ])
    });

    const hold = inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: lifecycleState(),
      readFile: seam.readFile
    });

    expect(hold).toMatchObject({ workerId: "I-09", reason: "spec_not_written" });
    expect(hold!.missingSpecFiles).toEqual([
      { kind: "card", declaredPath: "I-09.md", resolvedPath: cardPath("I-09"), state: "absent" },
      {
        kind: "capsule",
        declaredPath: "context/I-09-context.md",
        resolvedPath: capsulePath("I-09"),
        state: "absent"
      }
    ]);

    // The message must name the paths — an operator's next action is to write
    // exactly those files, and the old capsule prefix would have sent them to
    // read a `⏳` section in a file that is not there.
    const described = describeCapsuleMaterializationHold(hold!);
    expect(described).toContain("spec not written");
    expect(described).toContain("I-09.md");
    expect(described).toContain("context/I-09-context.md");
    expect(described).not.toContain("待物化");
  });

  it("parks when only the card is missing, even though the capsule is written and complete", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-08", card: "I-08.md", capsule: "context/I-08-context.md" }
      ]),
      [capsulePath("I-08")]: buildCapsule({ upstream: `I-01@${I_01_SHA}` })
    });

    const hold = inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-08",
      lifecycleState: lifecycleState(),
      readFile: seam.readFile
    });

    expect(hold).toMatchObject({ reason: "spec_not_written" });
    expect(hold!.missingSpecFiles.map((file) => file.kind)).toEqual(["card"]);
  });

  it("treats a whitespace-only file as not written", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-09", card: "I-09.md", capsule: "context/I-09-context.md" }
      ]),
      [cardPath("I-09")]: "   \n\n\t\n",
      [capsulePath("I-09")]: buildCapsule({ upstream: `I-01@${I_01_SHA}` })
    });

    const hold = inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: lifecycleState(),
      readFile: seam.readFile
    });

    expect(hold).toMatchObject({ reason: "spec_not_written" });
    expect(hold!.missingSpecFiles).toEqual([
      { kind: "card", declaredPath: "I-09.md", resolvedPath: cardPath("I-09"), state: "empty" }
    ]);
  });

  it("does not judge CONTENT: a one-line card is a written card", () => {
    // The boundary, asserted rather than assumed. This gate answers "does the
    // spec exist", not "is the spec good" — anything more becomes a content
    // validator that a legitimately terse card fails.
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-09", card: "I-09.md", capsule: "context/I-09-context.md" }
      ]),
      [cardPath("I-09")]: "x",
      [capsulePath("I-09")]: buildCapsule({ upstream: `I-01@${I_01_SHA}` })
    });

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: lifecycleState(),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("reads the capsule plan.json DECLARES, not the one the convention predicts", () => {
    const declaredCapsule = "/rounds/uld/taskspec/briefs/I-02.md";
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-02", card: "I-02.md", capsule: "briefs/I-02.md" }
      ]),
      [cardPath("I-02")]: "# I-02\n",
      // The convention path holds a FILLED capsule; the declared path holds an
      // unmaterialized one. Reading the convention would launch the row.
      [capsulePath("I-02")]: buildCapsule({ upstream: `I-01@${I_01_SHA}` }),
      [declaredCapsule]: buildCapsule()
    });

    const hold = inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "running" }) }),
      readFile: seam.readFile
    });

    expect(hold).toMatchObject({ reason: "awaiting_dependencies", capsulePath: declaredCapsule });
  });
});

describe("spec files: a capsule-less round is a POSITIVE determination", () => {
  it("launches when plan.json omits the card and capsule keys entirely", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([{ task_id: "I-09" }])
    });

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: buildState({}),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("launches when the keys are present but empty", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([{ task_id: "I-09", card: "", capsule: "   " }])
    });

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: buildState({}),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("launches a row the task graph does not mention at all", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-01", card: "I-01.md", capsule: "context/I-01-context.md" }
      ]),
      ...buildWrittenRow("I-01")
    });

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "OPERATOR-ADDED",
      lifecycleState: buildState({}),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("launches when the round publishes no plan.json at all (136 of 137 rounds on disk)", () => {
    const seam = buildFsSeam({});

    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: buildState({}),
      readFile: seam.readFile
    })).toBeNull();
  });

  it("still permits an UNDECLARED empty capsule — the asymmetry the fix turns on", () => {
    // Same empty capsule, two manifests. Without a declaration it is a
    // generator artefact and the row launches; with one it is an unwritten spec
    // and the row parks. Nothing about the file on disk distinguishes them.
    const files = { [capsulePath("I-02")]: "   \n\n" };

    const undeclared = buildFsSeam({
      ...files,
      [SPEC_MANIFEST_PATH]: buildSpecManifest([{ task_id: "I-02" }])
    });
    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({}),
      readFile: undeclared.readFile
    })).toBeNull();

    const declared = buildFsSeam({
      ...files,
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-02", capsule: "context/I-02-context.md" }
      ])
    });
    expect(inspectCapsuleMaterialization({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({}),
      readFile: declared.readFile
    })).toMatchObject({
      reason: "spec_not_written",
      missingSpecFiles: [{ kind: "capsule", state: "empty" }]
    });
  });
});

describe("spec files: an unreadable plan.json fails closed", () => {
  const cases: Array<{ name: string; files: Record<string, string>; errorCodes?: Record<string, string> }> = [
    { name: "invalid JSON", files: { [SPEC_MANIFEST_PATH]: "{\"tasks\": [" } },
    { name: "a zero-byte file", files: { [SPEC_MANIFEST_PATH]: "" } },
    { name: "valid JSON that is not a task graph", files: { [SPEC_MANIFEST_PATH]: "{\"rows\": []}" } },
    { name: "a tasks key that is not an array", files: { [SPEC_MANIFEST_PATH]: "{\"tasks\": {}}" } },
    { name: "a permissions failure", files: {}, errorCodes: { [SPEC_MANIFEST_PATH]: "EACCES" } }
  ];

  for (const testCase of cases) {
    it(`parks with spec_manifest_unreadable on ${testCase.name}`, () => {
      const seam = buildFsSeam(testCase.files, testCase.errorCodes);

      const hold = inspectCapsuleMaterialization({
        dispatchPlanPath: PLAN_PATH,
        workerId: "I-09",
        lifecycleState: buildState({}),
        readFile: seam.readFile
      });

      expect(hold).toMatchObject({
        workerId: "I-09",
        reason: "spec_manifest_unreadable",
        specManifestPath: SPEC_MANIFEST_PATH
      });
      expect(hold!.specManifestError).toBeTruthy();
      expect(describeCapsuleMaterializationHold(hold!)).toContain("spec manifest unreadable");
    });
  }

  it("distinguishes an unreadable manifest from an absent one", () => {
    // The whole point of the three-way split: EACCES and ENOENT on the same
    // path get opposite answers, because only one of them tells us the round
    // has a task graph.
    expect(loadSpecManifest(PLAN_PATH, { readFile: buildFsSeam({}).readFile }).status).toBe("absent");
    expect(loadSpecManifest(PLAN_PATH, {
      readFile: buildFsSeam({}, { [SPEC_MANIFEST_PATH]: "EACCES" }).readFile
    }).status).toBe("unreadable");
  });
});

describe("spec files: the launch funnel", () => {
  it("refuses the launch and attempts NO fill for a row whose spec was never written", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-09", card: "I-09.md", capsule: "context/I-09-context.md" }
      ])
    });

    const hold = evaluateCapsuleMaterializationForLaunch({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-09",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      rows: [{ worker: "I-09", branch: "task/I-09" }],
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => I_01_SHA
    });

    expect(hold).toMatchObject({ reason: "spec_not_written" });
    // No retry, no grace period, no "write something and launch anyway".
    expect(seam.writeFile).not.toHaveBeenCalled();
  });

  it("refuses the launch when plan.json is unreadable, and writes nothing", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: "not json at all",
      [capsulePath("I-02")]: buildCapsule()
    });

    const hold = evaluateCapsuleMaterializationForLaunch({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      rows: PLAN_ROWS,
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => I_01_SHA
    });

    expect(hold).toMatchObject({ reason: "spec_manifest_unreadable" });
    expect(seam.writeFile).not.toHaveBeenCalled();
  });

  it("permits the launch, and still fills, when the specs are written", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-02", card: "I-02.md", capsule: "context/I-02-context.md" }
      ]),
      [cardPath("I-02")]: "# I-02\n",
      [capsulePath("I-02")]: buildCapsule()
    });

    const hold = evaluateCapsuleMaterializationForLaunch({
      dispatchPlanPath: PLAN_PATH,
      workerId: "I-02",
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      rows: PLAN_ROWS,
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => I_01_SHA
    });

    expect(hold).toBeNull();
    expect(seam.written[capsulePath("I-02")]).toContain(`I-01@${I_01_SHA}`);
  });

  it("does not materialize into a capsule path it could not verify", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-02", card: "I-02.md", capsule: "context/I-02-context.md" }
      ]),
      // Card missing, capsule present and fillable. The sweep must still not run.
      [capsulePath("I-02")]: buildCapsule()
    });

    const result = materializeReadyCapsules({
      dispatchPlanPath: PLAN_PATH,
      rows: PLAN_ROWS,
      lifecycleState: buildState({ "I-01": buildWorker({ status: "completed" }) }),
      readFile: seam.readFile,
      writeFile: seam.writeFile,
      revParse: () => I_01_SHA
    });

    expect(seam.writeFile).not.toHaveBeenCalled();
    expect(result.materializedWorkers).toEqual([]);
    expect(result.stillHeld.map((hold) => [hold.workerId, hold.reason])).toEqual([
      ["I-02", "spec_not_written"]
    ]);
  });
});

describe("spec files: a parked row does not block its siblings", () => {
  it("keeps only the unwritten row out of the parallel launcher's candidate set", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-01", card: "I-01.md", capsule: "context/I-01-context.md" },
        // The incident shape: registered in the plan, spec still being authored.
        { task_id: "I-09", card: "I-09.md", capsule: "context/I-09-context.md" },
        { task_id: "I-07", card: "I-07.md", capsule: "context/I-07-context.md" }
      ]),
      ...buildWrittenRow("I-01"),
      ...buildWrittenRow("I-07")
    });
    const lifecycleState = buildState({ "I-01": buildWorker({ status: "completed" }) });
    const gate = createCapsuleMaterializationGate(PLAN_PATH, lifecycleState, { readFile: seam.readFile });

    const rows = [
      { status: "⬜", batch: "10", worker: "I-09", model: "CODEX", depends_on: "—", notes: null },
      { status: "⬜", batch: "10", worker: "I-07", model: "CODEX", depends_on: "—", notes: null }
    ];

    const candidates = resolveEligibleServiceContinueWorkers(rows, lifecycleState, {
      includeImplicitRunningWorker: false,
      capsuleGate: gate
    });

    expect(candidates).toEqual(["I-07"]);
    expect(gate("I-09")).toMatchObject({ reason: "spec_not_written" });
  });

  it("surfaces the parked row through the shared park resolver", () => {
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-08", card: "I-08.md", capsule: "context/I-08-context.md" },
        { task_id: "I-09", card: "I-09.md", capsule: "context/I-09-context.md" },
        { task_id: "I-07", card: "I-07.md", capsule: "context/I-07-context.md" }
      ]),
      ...buildWrittenRow("I-07")
    });
    const lifecycleState = buildState({ "I-01": buildWorker({ status: "completed" }) });
    const gate = createCapsuleMaterializationGate(PLAN_PATH, lifecycleState, { readFile: seam.readFile });

    const parked = resolveCapsuleMaterializationParkedWorkers(
      ["I-07", "I-08", "I-09"].map((worker) => ({ worker })),
      gate
    );

    expect(parked.map((hold) => [hold.workerId, hold.reason])).toEqual([
      ["I-08", "spec_not_written"],
      ["I-09", "spec_not_written"]
    ]);
  });

  it("reads plan.json once per gate, not once per row", () => {
    // The manifest is the file an operator edits to unpark a row, so the cache
    // must be scoped to one tick — one read here, and a fresh gate re-reads.
    const seam = buildFsSeam({
      [SPEC_MANIFEST_PATH]: buildSpecManifest([
        { task_id: "I-07", card: "I-07.md", capsule: "context/I-07-context.md" }
      ]),
      ...buildWrittenRow("I-07")
    });
    const gate = createCapsuleMaterializationGate(PLAN_PATH, buildState({}), { readFile: seam.readFile });

    for (const workerId of ["I-07", "I-08", "I-09", "I-10"]) {
      gate(workerId);
    }

    expect(seam.reads.filter((filePath) => filePath === SPEC_MANIFEST_PATH)).toHaveLength(1);

    createCapsuleMaterializationGate(PLAN_PATH, buildState({}), { readFile: seam.readFile })("I-07");
    expect(seam.reads.filter((filePath) => filePath === SPEC_MANIFEST_PATH)).toHaveLength(2);
  });
});
