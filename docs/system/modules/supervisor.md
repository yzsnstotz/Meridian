# Native supervisor

`@meridian/supervisor` is the one native lifecycle controller for the Meridian
product. It manages exactly two children:

- Runtime: Hub plus authenticated Web API;
- Orchestrator: roles, dispatch, scheduling, and routine jobs.

Gateway is an independent product and is never started, stopped, or restarted
as a Meridian prerequisite.

For each child lifetime the supervisor:

1. creates a fresh `instanceId` while retaining the stable provider ID;
2. starts the package entrypoint;
3. waits for a real HTTP readiness response;
4. publishes a native descriptor only after readiness;
5. renews its lease while ready;
6. removes it before shutdown or restart;
7. applies a bounded restart limit.

Runtime and Orchestrator durable state files live outside supervisor state and
are not rewritten during restart. The supervisor projection is stored at
`<stateDir>/supervisor.json`; Runtime exposes that projection read-only at
`GET /api/system`.

Control commands:

```bash
meridian start
meridian status
meridian doctor
meridian stop
```

The first start creates one shared internal bootstrap key and a separate Web
bearer token in the resolved Meridian config directory when they do not
already exist. The config file is private (`0600`), and explicit environment
values take precedence over config files. Logs are written beneath the
resolved log directory.
