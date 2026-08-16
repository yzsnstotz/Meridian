# Orchestrator

`@meridian/orchestrator` contains the history and implementation formerly
shipped from the standalone Meridian-Roles repository. It owns:

- role definitions and role lifecycle;
- TaskSpec agent dispatcher and validation;
- scheduler and routine-job execution;
- orchestration state and native execution graph;
- Orchestrator HTTP/A2A surfaces.

The package remains a separate process so it can fail, restart, drain, and be
upgraded independently of Runtime. Monorepo placement does not merge its write
authority with Runtime or Clawso.

The default durable state path is
`<resolved stateDir>/orchestrator-state.json`. `STATE_FILE_PATH` remains an
explicit compatibility override. The old `/tmp/meridian-roles/state.json`
fallback is imported only when the durable target is absent; import copies the
validated state and preserves the original.

Use `meridian-migrate-roles-state --discover` and the explicit import workflow
in `docs/migration/roles-to-meridian.md` for other standalone state locations.
