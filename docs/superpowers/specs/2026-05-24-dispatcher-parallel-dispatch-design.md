# Dispatcher Parallel Dispatch Design

Date: 2026-05-24

## Goal

Add an opt-in parallel dispatch mode to agent dispatchers. The default remains the current serial dispatcher behavior. When parallel dispatch is enabled, the dispatcher may start multiple dependency-eligible workers up to a configured concurrency limit.

The design also defines the required TaskSpec generator changes so future Meridian plans can be authored for safe internal parallelism instead of assuming one active worker per TaskSpec.

## Approved Approach

Use a staged dual-path implementation:

- `parallel_dispatch.enabled=false` keeps the existing serial continuation path unchanged.
- `parallel_dispatch.enabled=true` uses a new parallel continuation path.
- Shared parsing, lifecycle, dependency, PM, validator, and spawn helpers should be reused where practical, but the first implementation should not rewrite the serial engine into a unified scheduler.
- After the parallel path matures, the serial path can be folded into a unified scheduler where serial execution is represented as `max_concurrency=1`.

This is intentionally safer than replacing the current dispatcher loop immediately. Existing TaskSpecs and existing start forms keep their current behavior unless the operator explicitly enables parallel dispatch.

## Config Model

Add a nested dispatcher config object:

```json
{
  "parallel_dispatch": {
    "enabled": false,
    "max_concurrency": 1
  }
}
```

Rules:

- The object defaults to disabled.
- `max_concurrency` defaults to `1`.
- When enabled through the GUI, the user must choose a value of at least `2`.
- Schema and API validation should still accept `enabled=true, max_concurrency=1` as a conservative degenerate mode, but the GUI should guide users away from that combination.
- The same shape should be available in create and patch flows.

The start UI should expose this as a checkbox plus a numeric value that is required only when the checkbox is selected.

## Parallel Scheduling Behavior

The parallel path runs the same safety gates before selecting workers:

- Dispatcher pause or circuit-breaker state.
- Dispatch plan and lifecycle reconciliation.
- Manual intervention requirements.
- Validator queue and validator barriers.
- PM resolver duplicate guards.

After the gates pass, the dispatcher computes:

- Current active workers from lifecycle state.
- Eligible worker candidates from the dispatch plan dependency graph.
- Available slots as `max_concurrency - active_worker_count`.

The dispatcher starts up to `available_slots` eligible workers in dispatch-plan order. Starts are performed sequentially inside one continuation tick, with lifecycle state reloaded between starts. The workers then execute concurrently in their own provider runs or terminal processes.

The continuation response should expose enough information for the GUI and logs:

```json
{
  "status": "continued_parallel",
  "started_workers": ["R-02", "R-03"],
  "running_workers": ["R-01", "R-02", "R-03"],
  "available_slots": 0,
  "max_concurrency": 3
}
```

If no worker can be started, the path should return the existing meaningful state where possible, such as blocked, waiting for dependencies, waiting for validation, or complete.

## Dependency Rules

Parallel dispatch is dependency-driven, not batch-driven.

- A worker is eligible only when all non-human dependencies are terminal-success states or explicitly skipped according to existing lifecycle semantics.
- Plan order remains the tie-breaker among simultaneously eligible workers.
- Same-batch workers may run together only if their dependency graph allows it.
- If a worker depends on another worker in the same visible batch, it must not be started until the dependency is complete.

The existing dependency parser and eligibility helpers should be reused or extracted instead of introducing a separate parser.

## Runtime Switching

Operators should be able to update `parallel_dispatch` on an active dispatcher.

Rules:

- Turning parallel dispatch on affects the next continuation tick. Already running workers are not restarted.
- Turning parallel dispatch off does not kill active workers. It only prevents new parallel starts; the dispatcher returns to serial behavior once the active count naturally drops.
- Lowering `max_concurrency` below the current active worker count does not kill workers. It makes available slots zero until enough workers finish.
- Raising `max_concurrency` allows the next continuation tick to fill newly available slots.
- Other high-risk config changes remain subject to existing active-role update guards.

This preserves operational control without introducing process killing as a scheduling primitive.

## PM And Validator Gates

PM and validator behavior should remain conservative.

PM resolver:

- The PM duplicate gate is per blocked worker and current run identity, not global per dispatcher.
- Different blocked workers may each have their own PM resolver if they independently hit abnormal states.
- The same worker must not spawn duplicate PM resolvers from manual `/pm-resolve`, watchdogs, or continuation retries.

Validator:

- Validators are not counted against `parallel_dispatch.max_concurrency` in the first implementation.
- Existing validator barriers still apply.
- If validation must serialize a phase, the validator queue and dispatch-plan dependencies should express that instead of relying on worker slot accounting.

## Provider Session Boundary

Provider session identity, such as `codexSessionId`, belongs to Meridian Hub and provider adapters, not to the dispatcher concurrency feature.

This dispatcher design should not implement the Hub session model. The architecture direction is:

- A logical context maps to provider session metadata.
- The first call creates a provider session when none exists.
- Later calls for the same logical context resume the session.
- Explicit fresh or stateless calls create a temporary context and discard the mapping after use.
- Provider processes remain per-run and exit or are killed after the run.
- Retain and kill policy should eventually describe session metadata retention, not long-lived process ownership.

After Meridian Hub supports this model, Meridian Roles can revisit and simplify retain/kill/session-related historical logic. That simplification is intentionally out of scope for the parallel dispatcher implementation.

## TaskSpec Parallel Mode

The TaskSpec skill should gain a Meridian parallel mode rather than creating a separate forked skill:

```bash
taskspec --meridian --parallel
taskspec --meridian --parallel --max-concurrency 3
```

The mode should generate artifacts that are safe for internal dispatcher parallelism:

- Emit `parallel_dispatch.enabled=true` and the selected `max_concurrency` in dispatch commands.
- Treat dependencies as a DAG, not as loose batch labels.
- Mark or describe parallel-safe waves.
- Detect write-scope conflicts among workers that could run together.
- Add dependency edges or merge gates when workers touch shared files or shared contracts.
- Preserve existing TaskSpec artifact conventions, append behavior, Codex assignment behavior, and Meridian dispatch-plan structure.

The current per-TaskSpec shared worktree model is safe for serial TaskSpecs but unsafe for implementation workers running concurrently in one TaskSpec. Parallel mode should therefore use a stronger worktree policy. The first version should prefer one worktree per implementation worker when `--parallel` is active. Report-only, review-only, or explicitly read-only workers may share when the generated plan makes that safe.

If a separate `$taskspec-para` skill is added later, it should be a thin routing shim that invokes the base TaskSpec skill with Meridian parallel mode and applies the parallel planning overlay. It should not fork the full TaskSpec workflow.

## API And UI Surface

Backend changes:

- Extend agent-dispatcher config schemas with `parallel_dispatch`.
- Persist the object in role config.
- Add create and patch validation.
- Add a parallel continuation service entry point.
- Keep the serial continuation service path reachable for disabled configs.

Frontend changes:

- Add a disabled-by-default checkbox to the dispatcher start form.
- Show a numeric `max_concurrency` input when enabled.
- Include the same fields in dispatcher config edit flows if those flows expose dispatcher runtime config.
- Surface parallel continuation responses in the dispatcher detail page without requiring a new page layout.

## Error Handling

The parallel path should fail closed:

- Invalid config returns a validation error before dispatch starts.
- Lifecycle reconciliation errors block new starts.
- A spawn failure for one worker must be recorded for that worker and must not silently consume all remaining slots.
- If lifecycle state changes between candidate selection and spawn, the dispatcher reloads and rechecks before starting the next worker.
- If multiple workers become blocked, PM resolver gates handle each worker independently while preventing duplicate PM launches for the same worker.

## Testing

Add focused tests before implementation where practical:

- Config schema defaults and validation.
- Dispatcher create and patch payload persistence.
- GUI start payload with disabled and enabled parallel dispatch.
- Serial dispatcher behavior remains unchanged when disabled.
- Parallel selection starts multiple independent eligible workers up to `max_concurrency`.
- Dependency-blocked workers are not started even when slots are available.
- Active workers reduce available slots.
- Runtime toggling on, off, lowering, and raising `max_concurrency`.
- Duplicate PM resolver prevention for the same worker and allowed PM resolver creation for distinct blocked workers.
- Validator barriers continue to block worker starts as intended.
- TaskSpec parallel mode emits conservative dependency, worktree, and max-concurrency instructions.

## Out Of Scope

- Implementing provider session metadata or `codexSessionId` resume behavior in Meridian Roles.
- Rewriting retain/kill semantics before Meridian Hub exposes the provider-session model.
- Replacing the serial dispatcher path in the first implementation.
- Making validators count against worker concurrency slots.
- Creating a forked full `$taskspec-para` workflow.
