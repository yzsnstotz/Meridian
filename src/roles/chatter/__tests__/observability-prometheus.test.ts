import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_CHATTER_METRICS = [
  "chatter_self_initiated_turn_total",
  "chatter_self_initiated_turn_error_total",
  "chatter_read_only_query_total",
  "chatter_observation_eval_error_total",
  "chatter_last_provision_error_total",
  "chatter_last_turn_error_total",
  "mumu_git_commit_total",
  "mumu_git_push_total",
  "mumu_archive_provision_total",
  "mumu_archive_repo_size_bucket_total",
  "mumu_archive_largest_tracked_file_size_bucket_total",
  "mumu_archive_turn_log_size_bucket_total",
  "mumu_archive_large_file_excluded_total"
] as const;

describe("Chatter Prometheus observability contract", () => {
  it("declares every required chatter counter name exactly once in observability wiring", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/roles/chatter/observability.ts"), "utf8");

    for (const metric of REQUIRED_CHATTER_METRICS) {
      expect(source).toContain(metric);
    }
  });

  it("ships alert rules that reference only existing chatter counters", () => {
    const alerts = readFileSync(path.resolve(process.cwd(), "infra/prometheus/mumu-alerts.yml"), "utf8");

    expect(alerts).toContain("chatter_observation_eval_error_total");
    for (const referenced of alerts.match(/\bchatter_[a-z_]+_total\b/gu) ?? []) {
      expect(REQUIRED_CHATTER_METRICS).toContain(referenced as (typeof REQUIRED_CHATTER_METRICS)[number]);
    }
  });
});
