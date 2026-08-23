# Scheduler Worker Actions Design

Date: 2026-04-27

## Goal

Make the scheduler detail GUI consistent with the dispatcher detail GUI for dispatch-plan operations. Scheduler users must be able to inspect each worker's related agent replies and directly control the scheduler's active dispatch plan with the same worker actions exposed by dispatcher detail.

## Approved Approach

Use the dispatcher detail pattern in the scheduler page:

- Render scheduler dispatch progress as dispatcher-style worker rows with an inline action stack.
- Expand each worker row into the same detail card shape used by dispatcher detail.
- Use scheduler-scoped API endpoints that operate on the scheduler's configured `dispatch_plan_path` and neighboring `dispatch_threads.json`.
- Reuse the existing action semantics for `Continue`, `Redo`, `Skip`, `Force Complete`, and manual status update.

The right-drawer and cards-only alternatives were rejected because they would make the scheduler page diverge from dispatcher detail and weaken large-plan scanning.

## UI Design

The scheduler detail page keeps the existing high-level sections: status summary, controls, dispatch plan progress, config, and run history. The `Dispatch Plan Progress` section changes from a read-only progress table into a dispatcher-compatible table.

Each worker row shows:

- Plan status and lifecycle status.
- Batch, worker id, task, model, dependencies, thread id, tool progress, and issue summary.
- An action area matching dispatcher detail:
  - `Continue` for launchable blocked or abandoned work.
  - `Redo`, `Skip`, and `Force Complete` for running or terminal workers where applicable.
  - Status select plus `Apply` for manual status correction.

Rows with worker lifecycle or reply data render an inline expandable card directly below the row. The card contains `Dispatch Command`, `Agent Reply`, and `Validator Reply` sections using the existing dispatcher detail card layout and styling.

## Data Flow

`GET /api/scheduler/:threadId` continues to return scheduler status, config, run history, and dispatch progress. It also returns dispatcher-detail-compatible data for the scheduler's dispatch plan:

- `dispatch_plan.rows`: enriched plan rows, matching the shape used by `/api/role/:threadId` for agent dispatchers.
- `dispatch_details`: worker details built from `dispatch_threads.json`, plan rows, model legend, and persisted Hub result content.
- `continue_worker` and `current_worker`: scheduler-resolved worker ids for UI context.

This keeps scheduler and dispatcher rendering aligned without requiring a scheduler to masquerade as an `agent-dispatcher` role.

## Actions

Add scheduler-scoped worker endpoints:

- `POST /api/scheduler/:threadId/worker/:workerId/continue`
- `POST /api/scheduler/:threadId/worker/:workerId/resume`
- `PATCH /api/scheduler/:threadId/worker/:workerId/status`

These endpoints use the scheduler role's current effective config. They operate on the configured dispatch plan and lifecycle sidecar, then return the same result shapes as the dispatcher worker endpoints where practical.

Action behavior:

- `Continue` launches or resumes the selected scheduler worker using the scheduler config.
- `Redo` uses the existing retry semantics from `executeResumeWorkerAction`.
- `Skip` marks the worker skipped.
- `Force Complete` requires `force: true`, matching dispatcher detail.
- Status update uses `executeUpdateWorkerStatusAction`.

If a scheduler is not found, the endpoints return 404. If a worker action payload is invalid, they return 400. If a launch cannot proceed because the scheduler engine is unavailable or the worker is not launchable, they return an error message suitable for the GUI feedback area.

## Implementation Boundaries

Prefer sharing existing dispatcher helpers instead of copying logic:

- Move or reuse detail builders for dispatch worker cards where needed.
- Keep server-side plan/lifecycle parsing centralized.
- Keep styling shared through the existing `.dispatch-detail-*`, `.status-table`, `.table-action-*`, and `.status-badge` classes.

The scheduler page may keep its inline script for now, but its worker row renderers should match the dispatcher renderer names and behavior closely enough that a later extraction into shared public JS is straightforward.

## Testing

Add focused tests before implementation:

- Scheduler detail script renders worker action controls and inline reply cards from `dispatch_plan.rows` and `dispatch_details`.
- Scheduler worker action buttons call the scheduler-scoped endpoints with the expected method and payload.
- Scheduler handlers expose `dispatch_plan.rows`, `dispatch_details`, `continue_worker`, and `current_worker`.
- Scheduler worker endpoints call the existing resume, continue, and update-status code paths against the scheduler config.

Existing dispatcher detail behavior must keep passing unchanged.

## Out of Scope

- Replacing the scheduler inline script with a full frontend module system.
- Redesigning run history or scheduler config.
- Adding a separate drawer, separate worker page, or cards-only progress layout.
- Changing worker lifecycle semantics beyond exposing the existing controls on scheduler detail.
