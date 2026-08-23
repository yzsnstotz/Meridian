import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VALIDATOR_CONTEXT_CAPSULE_MAX_CHARS,
  buildDefaultValidatorPrompt,
  loadValidatorContextCapsule,
  resolveValidatorContextCapsulePath,
  type ValidatorContextCapsule,
  type ValidatorPromptContext
} from "../validator-prompt-builder";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, (directory) => fsp.rm(directory, { recursive: true, force: true }))
  );
  tempDirectories.clear();
});

async function createTempDir(): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(tmpdir(), "validator-capsule-"));
  tempDirectories.add(directory);
  return directory;
}

const BASE_CONTEXT: ValidatorPromptContext = {
  workerId: "N-06",
  taskBranch: "task/n-06",
  baseBranch: "main",
  taskspecPath: "/tmp/taskspec.md",
  dispatchPlanPath: "/tmp/plan/dispatch_plan.md",
  cycle: 1,
  maxFixCycles: 3,
  previousFeedback: null
};

// Shape mirrors a real capsule from the live
// unification-layer-decoupling-2026-08-06 round.
const SAMPLE_CAPSULE_CONTENT = [
  "# N-06 Context Capsule",
  "",
  "## Objective",
  "",
  "Runtime redemption of sessionExecutionMode.",
  "",
  "## Files Owned",
  "",
  "- apps/client/src-tauri/src/session_exec",
  "",
  "## Explicitly Forbidden",
  "",
  "- Do not touch AcpTurnGate.",
  "",
  "## Acceptance Commands",
  "",
  "```bash",
  "cargo test session_exec",
  "```"
].join("\n");

function capsuleOf(overrides: Partial<ValidatorContextCapsule> = {}): ValidatorContextCapsule {
  const content = overrides.content ?? SAMPLE_CAPSULE_CONTENT;
  return {
    path: "/tmp/plan/context/N-06-context.md",
    content,
    truncated: false,
    originalChars: content.length,
    ...overrides
  };
}

describe("buildDefaultValidatorPrompt", () => {
  it("instructs validators not to fail documented NO-GIT lifecycle-managed work on branch or plan-symbol metadata alone", () => {
    const prompt = buildDefaultValidatorPrompt({
      workerId: "N-06",
      taskBranch: "task/n-06",
      baseBranch: "main",
      taskspecPath: "/tmp/taskspec.md",
      dispatchPlanPath: "/tmp/dispatch_plan.md",
      cycle: 2,
      maxFixCycles: 3,
      previousFeedback: "Previous feedback"
    });

    expect(prompt).toContain("NO-GIT");
    expect(prompt).toContain("do not penalize the worker for missing task branches");
    expect(prompt).toContain("lifecycle store manages plan status updates");
    expect(prompt).toContain("Do not fail an otherwise valid deliverable solely because");
    expect(prompt).toContain("dispatch plan row still shows");
  });

  it("uses binary verdict guidelines while still requiring the marker reply protocol", () => {
    const prompt = buildDefaultValidatorPrompt({
      workerId: "N-06",
      taskBranch: "task/n-06",
      baseBranch: "main",
      taskspecPath: "/tmp/taskspec.md",
      dispatchPlanPath: "/tmp/dispatch_plan.md",
      cycle: 1,
      maxFixCycles: 3,
      previousFeedback: null,
      thresholdType: "binary"
    });

    expect(prompt).toContain("binary pass/fail verdict");
    expect(prompt).toContain("Binary Verdict Guidelines");
    expect(prompt).toContain("<<<MERIDIAN-STATUS>>>");
    expect(prompt).toContain("outcome: pass | fix_requested | fail");
    expect(prompt).not.toContain('"positive": <true or false>');
    expect(prompt).not.toContain('"score": <number between 0.0 and 1.0>');
  });

  describe("context capsule injection", () => {
    // The validator used to get a PATH and "go find your row": every session
    // re-read the whole dispatch_plan.md (664 lines / 23,500 chars on the live
    // round) to locate one row, plus the full card — 32 validator sessions /
    // 2.87h. The worker already receives a curated capsule; the asymmetry had
    // no reason.
    it("inlines the capsule and downgrades the dispatch-plan read", () => {
      const prompt = buildDefaultValidatorPrompt({
        ...BASE_CONTEXT,
        contextCapsule: capsuleOf()
      });

      expect(prompt).toContain("# Context Capsule — authoritative scope for N-06");
      expect(prompt).toContain("the authoritative scope for THIS row");
      expect(prompt).toContain("`## Acceptance Commands` are the acceptance checks");
      // The capsule body is inlined verbatim — the validator must be able to
      // read Acceptance Commands / Explicitly Forbidden without any file read.
      expect(prompt).toContain(SAMPLE_CAPSULE_CONTENT);

      // The saving lives in the downgrade, not in the addition: inlining while
      // still saying "read the plan" makes the prompt strictly larger.
      expect(prompt).toContain("Do NOT re-read the dispatch plan to reconstruct this row's scope");
      expect(prompt).not.toContain(
        "Read the dispatch plan at `/tmp/plan/dispatch_plan.md` to understand task context"
      );
      // ...but the plan is still reachable, because Delegatable Acceptance
      // Detection requires confirming the named target is an emitted row.
      expect(prompt).toContain("/tmp/plan/dispatch_plan.md");
      expect(prompt).toContain("is an emitted row");
    });

    it("adds only a small fixed overhead beyond the capsule body itself", () => {
      // Keeps the framing prose honest. The prompt does grow in absolute terms
      // (+2,818 chars median across the 75 live capsules) — the win is that the
      // validator no longer reads a 23,500-char plan document to find its row.
      // What must stay small is the wrapper: measured at 379 chars (section
      // header + downgraded step minus the original step). Guard it before it
      // drifts.
      const withCapsule = buildDefaultValidatorPrompt({ ...BASE_CONTEXT, contextCapsule: capsuleOf() });
      const withoutCapsule = buildDefaultValidatorPrompt(BASE_CONTEXT);
      const fixedOverhead = withCapsule.length - withoutCapsule.length - SAMPLE_CAPSULE_CONTENT.length;

      expect(withCapsule.length).toBeGreaterThan(withoutCapsule.length);
      expect(fixedOverhead).toBeLessThan(450);
    });

    it("renders byte-identically to the pre-capsule prompt when there is no capsule", () => {
      // Rounds generated before capsules existed, and rows the generator
      // skipped, must not shift by a single character.
      const implicit = buildDefaultValidatorPrompt(BASE_CONTEXT);
      const explicitNull = buildDefaultValidatorPrompt({ ...BASE_CONTEXT, contextCapsule: null });
      const explicitUndefined = buildDefaultValidatorPrompt({
        ...BASE_CONTEXT,
        contextCapsule: undefined
      });

      expect(explicitNull).toBe(implicit);
      expect(explicitUndefined).toBe(implicit);
      expect(implicit).not.toContain("Context Capsule");
      expect(implicit).not.toContain("TRUNCATED");
      // The exact pre-capsule sentence, verbatim.
      expect(implicit).toContain(
        "4. Read the dispatch plan at `/tmp/plan/dispatch_plan.md` to understand task context and the worker's assigned task (look for worker ID: N-06)."
      );
    });

    it("keeps the pre-capsule step numbering when there is no taskspec path", () => {
      const withCapsule = buildDefaultValidatorPrompt({
        ...BASE_CONTEXT,
        taskspecPath: null,
        contextCapsule: capsuleOf()
      });
      const withoutCapsule = buildDefaultValidatorPrompt({ ...BASE_CONTEXT, taskspecPath: null });

      expect(withoutCapsule).toContain("3. Read the dispatch plan at");
      expect(withCapsule).toContain("3. Do NOT re-read the dispatch plan");
    });

    it("marks a truncated capsule and names the path to read the rest", () => {
      const truncatedCapsule = capsuleOf({
        content: "# N-06 Context Capsule\n\n## Objective\n\nFirst half only.",
        truncated: true,
        originalChars: 48_000
      });
      const prompt = buildDefaultValidatorPrompt({ ...BASE_CONTEXT, contextCapsule: truncatedCapsule });

      expect(prompt).toContain("[TRUNCATED — capsule is 48000 characters, inlined the first");
      expect(prompt).toContain("Read the full capsule at `/tmp/plan/context/N-06-context.md`");
      // Silently judging a partial scope is the failure mode worth preventing.
      expect(prompt).toContain("do NOT treat the fragment above as the complete scope");
    });

    it("leaves verdict semantics untouched when a capsule is present", () => {
      // The capsule changes what the validator reads, never how it votes.
      const prompt = buildDefaultValidatorPrompt({
        ...BASE_CONTEXT,
        thresholdType: "binary",
        previousFeedback: "Earlier feedback",
        contextCapsule: capsuleOf()
      });

      expect(prompt).toContain("**positive true**");
      expect(prompt).toContain("**positive false**");
      expect(prompt).toContain("Delegatable Acceptance Detection (v1.23.0)");
      expect(prompt).toContain("<<<MERIDIAN-STATUS>>>");
      expect(prompt).toContain("outcome: pass | fix_requested | fail");
      expect(prompt).toContain("do not penalize the worker for missing task branches");
      expect(prompt).toContain("Previous Feedback (Cycle 0)");
      expect(prompt).toContain("You are in READ-ONLY mode");
    });
  });
});

describe("resolveValidatorContextCapsulePath", () => {
  it("derives the capsule as a sibling of the dispatch plan", () => {
    expect(resolveValidatorContextCapsulePath("/a/b/taskspec/dispatch_plan.md", "C-02")).toBe(
      "/a/b/taskspec/context/C-02-context.md"
    );
  });

  it("preserves the worker id verbatim, including lowercase variant suffixes", () => {
    // Live filenames are C-04a-context.md / BATCH-7-GATE-context.md; the same
    // directory also holds the generator script, so an exact name is what
    // stops this matching a non-capsule file.
    expect(resolveValidatorContextCapsulePath("/a/b/dispatch_plan.md", "C-04a")).toBe(
      "/a/b/context/C-04a-context.md"
    );
    expect(resolveValidatorContextCapsulePath("/a/b/dispatch_plan.md", "BATCH-7-GATE")).toBe(
      "/a/b/context/BATCH-7-GATE-context.md"
    );
  });
});

describe("loadValidatorContextCapsule", () => {
  async function writeCapsule(workerId: string, content: string): Promise<string> {
    const directory = await createTempDir();
    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fsp.mkdir(path.join(directory, "context"), { recursive: true });
    await fsp.writeFile(path.join(directory, "context", `${workerId}-context.md`), content, "utf8");
    return dispatchPlanPath;
  }

  it("loads a capsule that exists", async () => {
    const dispatchPlanPath = await writeCapsule("C-02", SAMPLE_CAPSULE_CONTENT);

    const capsule = loadValidatorContextCapsule(dispatchPlanPath, "C-02");

    expect(capsule).not.toBeNull();
    expect(capsule?.content).toBe(SAMPLE_CAPSULE_CONTENT);
    expect(capsule?.truncated).toBe(false);
    expect(capsule?.originalChars).toBe(SAMPLE_CAPSULE_CONTENT.length);
    expect(capsule?.path.endsWith(path.join("context", "C-02-context.md"))).toBe(true);
  });

  it("returns null when the capsule does not exist", async () => {
    const directory = await createTempDir();
    const warn = vi.fn();

    const capsule = loadValidatorContextCapsule(
      path.join(directory, "dispatch_plan.md"),
      "C-99",
      { log: { warn } }
    );

    expect(capsule).toBeNull();
    // ENOENT is the ordinary case on pre-capsule rounds — must not log every cycle.
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null and warns when the capsule exists but cannot be read", async () => {
    const warn = vi.fn();
    const readFile = vi.fn((): string => {
      const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    const capsule = loadValidatorContextCapsule("/a/b/dispatch_plan.md", "C-02", {
      readFile,
      log: { warn }
    });

    expect(capsule).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns null for an empty or whitespace-only capsule", async () => {
    const dispatchPlanPath = await writeCapsule("C-03", "   \n\n  \n");

    expect(loadValidatorContextCapsule(dispatchPlanPath, "C-03")).toBeNull();
  });

  it("never throws — a missing brief must not block a validation", () => {
    const readFile = vi.fn((): string => {
      throw new Error("catastrophic I/O failure with no code");
    });

    expect(loadValidatorContextCapsule("/a/b/dispatch_plan.md", "C-02", { readFile })).toBeNull();
  });

  it("truncates an oversized capsule on a line boundary and reports the original size", async () => {
    const oversized = Array.from({ length: 400 }, (_, index) => `line ${index} of the capsule body`).join("\n");
    const dispatchPlanPath = await writeCapsule("C-04a", oversized);

    const capsule = loadValidatorContextCapsule(dispatchPlanPath, "C-04a", { maxChars: 500 });

    expect(capsule).not.toBeNull();
    expect(capsule?.truncated).toBe(true);
    expect(capsule?.originalChars).toBe(oversized.length);
    expect(capsule!.content.length).toBeLessThanOrEqual(500);
    // Cut on a newline so the fragment never ends mid-line, mid-fence, or
    // (for the CJK capsules this round uses) mid-character.
    expect(capsule!.content.endsWith("\n")).toBe(false);
    expect(oversized.startsWith(capsule!.content)).toBe(true);
    expect(oversized.charAt(capsule!.content.length)).toBe("\n");
  });

  it("does not truncate a capsule at the real observed maximum", async () => {
    // Measured across the 75 capsules of the live round: median 2,438 chars,
    // p90 3,564, max 7,200. The default cap must clear that comfortably or the
    // truncation notice fires on ordinary rows and buys nothing.
    const realisticMax = "x".repeat(7_200);
    const dispatchPlanPath = await writeCapsule("W1-01", realisticMax);

    const capsule = loadValidatorContextCapsule(dispatchPlanPath, "W1-01");

    expect(VALIDATOR_CONTEXT_CAPSULE_MAX_CHARS).toBeGreaterThan(7_200);
    expect(capsule?.truncated).toBe(false);
    expect(capsule?.content.length).toBe(7_200);
  });
});

describe("expected outputs (regression: validator hunted the report inside the worktree)", () => {
  const base = {
    workerId: "C-02",
    taskBranch: "uld-mvp-2026-08-06/C-02",
    baseBranch: "unification-layer-decoupling-2026-08-06",
    taskspecPath: null,
    dispatchPlanPath: "/plan/dispatch_plan.md",
    cycle: 1,
    maxFixCycles: 5,
    previousFeedback: null
  };

  it("names the absolute report path and disarms the worktree-relative false finding", () => {
    // C-02 carried "reports/C-02.md is still missing" as a blocking finding
    // through all five cycles — the validator resolved the capsule's relative
    // `reports/<id>.md` against the worker's worktree. The report existed the
    // whole time at its canonical absolute path.
    const prompt = buildDefaultValidatorPrompt({
      ...base,
      expectedOutputs: ["/Users/x/work/Docs/.../taskspec/reports/C-02.md"]
    });

    expect(prompt).toContain("/Users/x/work/Docs/.../taskspec/reports/C-02.md");
    expect(prompt).toContain("NOT inside the worker's git worktree");
  });

  it("omits the section entirely when the row has no expected outputs", () => {
    const prompt = buildDefaultValidatorPrompt(base);

    expect(prompt).not.toContain("Expected Outputs");
  });
});
