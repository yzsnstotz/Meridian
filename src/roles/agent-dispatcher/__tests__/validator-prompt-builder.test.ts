import { describe, expect, it } from "vitest";

import { buildDefaultValidatorPrompt } from "../validator-prompt-builder";

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
});
