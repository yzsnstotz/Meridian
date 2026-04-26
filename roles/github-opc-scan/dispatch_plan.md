# Runtime Dispatch Plan: github-opc-scan

**Version**: v1.0
**TaskSpec ID**: github-opc-scan-v1
**Routine job id**: github-opc-scan
**Phase**: 0 only
**Schedule**: Daily at 07:30 Asia/Tokyo (`30 7 * * *`)
**Status reset**: The scheduler resets runtime row status to `⬜` at the start of each daily cycle.

## Runtime Context

- **Tool**: `github-ai-automation-scan`
- **Tool repo root**: `/Users/yzliu/work/tools/github-ai-automation-scan`
- **Dispatch repo root**: `/Users/yzliu/work/Meridian/Meridian-roles`
- **Docs root**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Runtime work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Runtime output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Query partitions**: `/Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/query_partitions.yaml`

## Model Assignment Legend

| Code | Model | Runtime mapping |
| --- | --- | --- |
| CODEX-HIGH | Codex gpt-5.5 high | `agent_type=codex`, `model_id=gpt-5.5`, high reasoning effort |

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | depends_on | TaskSpec File |
| --- | --- | --- | --- | --- | --- | --- |
| ⬜ | 0 | PRE-FLIGHT | `github-ai-automation-scan preflight` validates runtime environment, token, DB, storage, Codex CLI, and output paths | CODEX-HIGH | — | PRE-FLIGHT.md |
| ⬜ | 1 | W-DISCOVERY | `github-ai-automation-scan discover --mode delta` scans the 28 Phase 0 query partitions and writes `discovery_hits.json` | CODEX-HIGH | PRE-FLIGHT | W-DISCOVERY.md |
| ⬜ | 2 | W-REPO-FETCH | `github-ai-automation-scan repo-fetch` fetches repository metadata, content summaries, and capped preview assets | CODEX-HIGH | W-DISCOVERY | W-REPO-FETCH.md |
| ⬜ | 3 | W-PREFILTER | `github-ai-automation-scan prefilter` applies deterministic rejection rules and writes `prefiltered_candidates.json` | CODEX-HIGH | W-REPO-FETCH | W-PREFILTER.md |
| ⬜ | 4 | W-CLASSIFY | `github-ai-automation-scan classify` runs structured 12-dimension classification and grey-zone reclassification | CODEX-HIGH | W-PREFILTER | W-CLASSIFY.md |
| ⬜ | 5 | W-PERSIST | `github-ai-automation-scan persist` finalizes snapshots, lifecycle state, and scan summaries | CODEX-HIGH | W-CLASSIFY | W-PERSIST.md |
| ⬜ | 6 | W-ANALYTICS | `github-ai-automation-scan analytics` writes metrics, leaderboards, and dashboard data | CODEX-HIGH | W-PERSIST | W-ANALYTICS.md |

## Worker Rules

Runtime workers are thin CLI orchestrators. They must compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` in the scheduler timezone, run only the CLI subcommand specified by their worker file, validate JSON summary output, report the result, and stop.

`W-DASHBOARD` is not part of this per-cycle plan. The dashboard is a long-running local service managed separately by `roles/github-opc-scan/launchd/com.yzsnstotz.github-opc-scan-dashboard.plist` or an equivalent manual invocation.

## Status Legend

| Symbol | Meaning |
| --- | --- |
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |
| ⛔ | Blocked |
