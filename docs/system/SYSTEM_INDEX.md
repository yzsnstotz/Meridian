# Meridian System Index

**Status**: Updated for the Meridian monorepo and portable filesystem contract on 2026-07-25.
**Purpose**: Route maintainers to the package that owns a behavior before they open module-level documentation.
**Format Contract**: See [FORMAT_SPEC.md](./FORMAT_SPEC.md).

## Product boundary

Meridian is one user-facing orchestration product implemented as separable
processes. Runtime owns provider processes and the Hub. Orchestrator owns roles,
TaskSpec dispatch, scheduling, and routine jobs. Gateway remains an independent
package and is not a required child of Meridian. The CLI and supervisor form the
shared control surface.

```text
                         meridian CLI
                              |
                         supervisor
                        /          \
                 Runtime            Orchestrator
              Hub/providers       roles/dispatch
                        \          /
                         contracts

Gateway ---------------- independent lifecycle and deployment
```

## Package routing

| Package | Path | Ownership |
|---------|------|-----------|
| Contracts | `packages/contracts/` | Dependency-light schemas, public types, portable paths, and service contracts shared across process boundaries. |
| Runtime | `packages/runtime/` | Hub IPC, provider lifecycle, interface adapters, monitor, authenticated web API, and browser UI. |
| Orchestrator | `packages/orchestrator/` | Role framework, agent dispatcher, scheduler, routine-job hub, tool gateway, and orchestration GUI. |
| Gateway | `packages/gateway/` | Independent gateway service; it must not import or require Orchestrator. |
| CLI | `packages/cli/` | JSON-first user control surface and compatibility aliases. |
| Supervisor | `packages/supervisor/` | Runtime and Orchestrator process lifecycle, readiness, and bounded restart. It does not own Gateway. |

## Dependency rules

- Contracts cannot depend on another Meridian package.
- Runtime and Orchestrator communicate through contracts or service interfaces,
  never package-private imports.
- Gateway remains independent of Orchestrator and supervisor lifecycle.
- CLI and supervisor may consume Contracts but do not import Runtime or
  Orchestrator internals.
- `npm run test:boundaries` enforces these package edges.

## Portable filesystem ownership

`packages/contracts/src/paths.ts` is the only owner of native filesystem
defaults. Resolution order is:

1. explicit API overrides;
2. Meridian environment variables;
3. user configuration;
4. platform defaults.

The resolver covers config, data, durable state, runtime descriptors, sockets,
logs, work roots, TaskSpec roots, and the Hub state/socket paths. Production
code must not infer those locations from the repository checkout or a
developer-specific home directory.

Platform defaults:

- macOS: durable files under
  `~/Library/Application Support/Meridian`; per-user runtime files under the
  operating-system temporary directory.
- Linux: XDG config/data/state/runtime roots, with a per-user temporary runtime
  fallback when `XDG_RUNTIME_DIR` is unavailable.
- Windows: roaming configuration, local data/state, and a per-user temporary
  runtime directory.

Managed container or system deployments may provide explicit absolute paths,
such as `/var/lib/meridian` and `/run/meridian`, through the same environment
contract.

## Runtime module docs

The existing module files under `docs/system/modules/` describe Runtime internals.
Their source roots are now under `packages/runtime/src/`:

- [hub](./modules/hub.md)
- [interface](./modules/interface.md)
- [shared](./modules/shared.md)
- [agents](./modules/agents.md)
- [monitor](./modules/monitor.md)
- [web](./modules/web.md)
- [bin](./modules/bin.md)
- [root](./modules/root.md)

Orchestrator package documentation currently lives with the package in
`packages/orchestrator/README.md` and its source-local READMEs. The migration
guide and package-level module docs supersede the former standalone
Meridian-Roles repository layout.

## Start here

1. Choose the package from the table above.
2. Read that package's `README.md` and `package.json`.
3. For Runtime internals, open only the relevant module document listed above.
4. Follow imports toward Contracts, not across package-private boundaries.
5. Run the root build and boundary tests before committing package changes.
