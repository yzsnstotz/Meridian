# Migrate standalone Meridian-Roles into Meridian

## Safety contract

Migration is copy-only. It does not stop the old service, move or delete source
state, merge conflicting graphs, or overwrite a non-equivalent target. Keep the
standalone service stopped while taking the final copy so both processes cannot
write divergent state.

## 1. Discover

Build the workspace, then list known existing locations:

```bash
npm run build
meridian-migrate-roles-state --discover
```

Discovery checks explicit `STATE_FILE_PATH` /
`MERIDIAN_ROLES_STATE_PATH` values and user-relative legacy locations. It does
not associate state from a process name or port.

If the old service used a custom path, use that exact absolute path in the next
step even when discovery does not list it.

## 2. Preview

```bash
meridian-migrate-roles-state \
  --from /absolute/path/to/old/state.json \
  --dry-run
```

The default target is the current platform's resolved
`orchestrator-state.json`. Use `--to /absolute/path` only when the new
installation intentionally sets `STATE_FILE_PATH` to that same target.

## 3. Import and verify idempotency

```bash
meridian-migrate-roles-state --from /absolute/path/to/old/state.json
meridian-migrate-roles-state --from /absolute/path/to/old/state.json
```

The first result is `imported`; the second is `already_imported`. Both report
`sourcePreserved: true`. A different existing target is a hard conflict and is
never overwritten.

Then start and inspect Meridian:

```bash
meridian start
meridian doctor
meridian service list
```

The Orchestrator restart hold keeps persisted dispatchers paused unless the
operator explicitly opts into auto-resume.

## Compatibility and deprecation schedule

- Meridian `1.x`: the `meridian-roles` binary name, `STATE_FILE_PATH`, and
  legacy service/caller IDs remain compatibility aliases.
- Meridian `2.0`: aliases may emit deprecation warnings, but remain available
  for at least two minor releases after the first warning.
- Meridian `3.0` is the earliest removal point, and only after migration
  verification covers active installations and Clawso listings no longer
  depend on the aliases.

The standalone Meridian-Roles repository should become read-only only after its
final commit is contained in this monorepo and the operator has verified the
copied state. No archival step is performed by the migration command.
