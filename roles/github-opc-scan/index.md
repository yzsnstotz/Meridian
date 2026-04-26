# github-opc-scan Runtime Role

## Round Context

- **Routine job id**: `github-opc-scan`
- **TaskSpec id**: `github-opc-scan-v1`
- **Phase**: 0 only
- **Dispatch repo root**: `/Users/yzliu/work/Meridian/Meridian-roles`
- **Docs root**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan`
- **Tool repo root**: `/Users/yzliu/work/tools/github-ai-automation-scan`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **External storage root**: `/Volumes/Elements/github-ai-automation-solutions/`
- **Runtime work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Runtime output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Query partition config**: `/Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/query_partitions.yaml`

Runtime workers are thin orchestrators. They call one deterministic `github-ai-automation-scan` CLI subcommand, validate its JSON summary, report artifacts, and stop. They do not implement GitHub API traversal, rate limiting, persistence, scoring, dashboard writes, or Codex classification logic in prompts.

## Runtime Identity

The runtime dispatch command for this role must not reuse the build-time TaskSpec worker identity declaration. Phase 0 runtime workers always run as:

- **Worker model code**: `CODEX-HIGH`
- **Role**: local CLI orchestrator
- **Branching**: none for daily runtime rows
- **PR delivery**: none for daily runtime rows

## Phase 0 Dispatch Table

| Order | Runtime worker | CLI subcommand | Depends on | Primary handoff |
| --- | --- | --- | --- | --- |
| 1 | `PRE-FLIGHT` | `preflight` | none | JSON preflight summary |
| 2 | `W-DISCOVERY` | `discover` | `PRE-FLIGHT` | `discovery_hits.json` |
| 3 | `W-REPO-FETCH` | `repo-fetch` | `W-DISCOVERY` | repository/cache rows in SQLite |
| 4 | `W-PREFILTER` | `prefilter` | `W-REPO-FETCH` | `prefiltered_candidates.json` |
| 5 | `W-CLASSIFY` | `classify` | `W-PREFILTER` | `classification_summary.json` |
| 6 | `W-PERSIST` | `persist` | `W-CLASSIFY` | scan run summary and snapshots |
| 7 | `W-ANALYTICS` | `analytics` | `W-PERSIST` | `metrics.json` and leaderboards |

`W-DASHBOARD` is intentionally not a daily runtime worker. The dashboard is a long-running local service started manually or by the Phase 0 scheduler service configuration authored by `M-SCHEDULER-WIRE`.

## Cross-Worker Integration Points

| Artifact or state | Producer | Consumer | Contract |
| --- | --- | --- | --- |
| JSON stdout summary | every subcommand | runtime worker prompt | Must include top-level `status`, `subcommand`, `scan_run_id`, and `result`; non-zero exit marks the row blocked. |
| `query_partition_cursor.json` | `discover` | `discover` reruns | Stored under the runtime work dir; enables resumable backfill and delta continuation. |
| `discovery_hits.json` | `discover` | `repo-fetch`, `prefilter` | Versioned manifest of discovered source leads for the current scan run. |
| SQLite repository/cache rows | `repo-fetch` | `prefilter`, `classify`, `persist`, `analytics` | Idempotent current-state writes keyed by normalized source identity and candidate id. |
| `prefiltered_candidates.json` | `prefilter` | `classify` | Bounded list of accepted candidates plus rejection metadata for explainability. |
| `classification_summary.json` | `classify` | `persist`, operator review | Records classification counts, model-call audit metadata, and candidate summaries. |
| scan summary and snapshots | `persist` | `analytics`, dashboard | Finalizes current run status and writes snapshot tables. |
| `metrics.json` and leaderboards | `analytics` | dashboard, operator | Contains Phase 0 quality metrics, false-positive rate, disqualifier counts, and ranked views. |

## Discovery Partitions

`query_partitions.yaml` declares a deterministic 28-partition Phase 0 discovery matrix: 7 OPC topic clusters by 4 stars/activity buckets. Each partition has a target of 50 unique repos per cycle, for a total planned ceiling of 1400, below the Phase 0 daily ceiling of 1500.

The tool reads the file through `--query-partitions-config` or the built-in default path `/Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/query_partitions.yaml`.

## Scheduler Validator Placeholder

Phase 0 scheduler config intentionally omits the `validator` field entirely. `M-SCHEDULER-WIRE` registers the Phase 0 routine without a validator block so the omission is explicit rather than accidental.

Phase 0.5 worker `T-SCHEDULER-VALIDATOR` will add a validator configuration such as `validator: { agent_type: "validator", ... }` and route validation through `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/validator-orchestrator.ts` using artifact-mediated inputs and outputs.

## Layout Note

This repo did not have an existing `roles/clawhub-skill-scan/` directory at authoring time. The runtime worker file structure mirrors the referenced ClawHub TaskSpec worker files (`W-CATALOG.md`, `W-DETAIL.md`, `W-PERSIST.md`, `W-ANALYTICS.md`) instead.
