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
});
