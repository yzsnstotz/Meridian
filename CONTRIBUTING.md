# Contributing to Meridian

Thank you for improving Meridian. The project favors focused changes, explicit
package ownership, and evidence that another operator can reproduce.

## Development setup

```bash
npm ci
npm run build
npm link --workspace @meridian/cli
```

Node.js 22.13 or newer is required. Keep provider credentials, generated state,
logs, and `.env` files outside the repository.

## Package boundaries

| Package        | Owns                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| `contracts`    | Shared schemas, service contracts, and portable paths                               |
| `runtime`      | Provider processes, threads, channels, credentials, Hub IPC, and Runtime Web API/UI |
| `orchestrator` | Roles, TaskSpec/DAG execution, scheduling, validation, and recovery                 |
| `supervisor`   | Native Runtime/Orchestrator process lifecycle                                       |
| `cli`          | Stable JSON-first operator commands                                                 |
| `gateway`      | Optional OpenAI/Anthropic-compatible ingress                                        |

Do not import package internals across these boundaries. Put shared wire types
and low-dependency primitives in `@meridian/contracts`.

## Before opening a pull request

Run the complete verification set:

```bash
npm run typecheck
npm run build
npm test
npm run test:orchestrator
```

Also run the closest package tests while iterating. Changes to public commands,
configuration, service contracts, or operator workflows should update the
corresponding documentation and examples.

## Pull requests

- Keep one coherent purpose per PR.
- Explain the operator-visible behavior and package boundary affected.
- Include tests for new behavior and regressions.
- Include screenshots for visible UI changes.
- Call out migrations, new environment variables, credential handling, or
  network exposure explicitly.
- Never include generated credentials, tokens, runtime state, or personal paths.

Use imperative commit subjects, for example:

```text
feat: add dependency-aware retry policy
fix: remove stale runtime descriptor on shutdown
docs: clarify gateway key rotation
```

## Reporting security issues

Do not open a public issue containing an exploitable credential, private log,
or reproduction against an exposed installation. Contact the maintainers
privately through the repository owner's published GitHub contact channel.
