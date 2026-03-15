# Meridian v2.0 — Integration Tests (T-17)

End-to-end integration tests that cover P1 acceptance scenarios from the v2.0 taskspec. They start a real Hub (and optionally a stub agentapi), send IPC messages, and assert on results and side effects.

## Running

```bash
npm run test:integration
```

Requires Node.js 22+ and `tsx`. No Telegram or real agentapi binary is needed; tests use a stub agentapi and a no-op result sender.

## Test cases (taskspec §4.2)

| ID     | File                          | Scenario                                      |
|--------|-------------------------------|-----------------------------------------------|
| INT-01 | int-01-unix-socket.test.ts    | Unix Socket: spawn → socket exists → run → kill → socket removed |
| INT-03 | int-03-detach-attach.test.ts  | detach → run fails → attach → run succeeds   |
| INT-04 | int-04-reboot.test.ts        | reboot preserves thread_id, changes pid       |
| INT-08 | int-08-idempotency.test.ts   | Same idempotency_key returns cached result    |

Additional scenarios (INT-02 Webhook, INT-05/06 Web GUI, INT-07 actor_id, INT-09 priority queue, INT-10 ServiceRegistry) are covered by unit tests in `src/` or require external services; see taskspec §4.2 for manual verification.

## Layout

- `helpers/env.ts` — Sets `TELEGRAM_BOT_TOKEN` / `ALLOWED_USER_IDS` so config loads in tests.
- `helpers/hub-ipc.ts` — Builds `HubMessage`, sends IPC to Hub socket, returns `HubResult`.
- `helpers/hub-server.ts` — Starts `HubServer` on a temp socket with stub agentapi and no-op result sender.
- `../fixtures/stub-agentapi.mjs` — Minimal HTTP-over-Unix stub: GET /status, GET /messages, POST /message.

## CI

Ensure `npm run test:integration` is run in CI (e.g. in the same job as `npm run test` or in a separate integration step). Coverage target per taskspec: ≥ 80% for the codebase; integration tests complement unit tests in `src/**/*.test.ts`.
