import * as fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const plistPath = path.resolve(
  process.cwd(),
  "roles/github-opc-scan/launchd/com.yzsnstotz.github-opc-scan-dashboard.plist"
);

describe("github-opc-scan dashboard launchd service", () => {
  it("uses the current dashboard CLI flags and repo venv entrypoint", async () => {
    const plist = await fs.readFile(plistPath, "utf8");
    const args = Array.from(plist.matchAll(/<string>([^<]+)<\/string>/g), (match) => match[1]);

    expect(args).toContain("/Users/yzliu/work/tools/github-ai-automation-scan/.venv/bin/python");
    expect(args).toContain("-m");
    expect(args).toContain("github_ai_automation_scan");
    expect(args).toContain("--work-dir");
    expect(args).toContain("/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/dashboard-work");
    expect(args).toContain("--dashboard-host");
    expect(args).toContain("--dashboard-port");
    expect(args).toContain("18765");
    expect(args).not.toContain("github-ai-automation-scan");
    expect(args).not.toContain("--host");
    expect(args).not.toContain("--port");
  });
});
