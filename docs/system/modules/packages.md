# Package ownership and dependency graph

## Ownership

| Package | Write authority |
|---------|-----------------|
| `@meridian/contracts` | Portable paths, service schemas, operation contracts, and dependency-light public types. |
| `@meridian/runtime` | Hub/provider/channel state and Runtime HTTP behavior. |
| `@meridian/orchestrator` | Native orchestration graph, roles, dispatch, scheduler, and routine-job state. |
| `@meridian/supervisor` | Process lifecycle and its own process projection only. |
| `@meridian/cli` | User-facing command parsing and JSON projection; no durable execution authority. |
| `@meridian/gateway` | Independent Gateway lifecycle and ingress behavior. |

The supervisor does not become a second writer for Runtime or Orchestrator
state. It only starts processes, observes readiness, publishes live service
descriptors, and records a process snapshot. Orchestrator remains authority for
its native execution graph.

## Allowed edges

```text
CLI ----------> Contracts <---------- Supervisor
 |                                      |
 +-------- public Runtime APIs          +-- process Runtime
 +-------- service discovery            +-- process Orchestrator

Runtime ------> Contracts <---------- Orchestrator

Gateway ------> Contracts (optional shared schema only)
```

Package-private imports across Runtime, Orchestrator, or Gateway boundaries are
forbidden. `npm run test:boundaries` enforces the graph. Generic infrastructure
must select behavior from typed capabilities and operation contracts, not from
hardcoded caller identity.
