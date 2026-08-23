# Service declarations and discovery

Meridian implements the Clawso service v1 declaration and runtime-instance
shapes as a compatibility contract without requiring Clawso at runtime.

Static declarations:

- `packages/runtime/service.json`
- `packages/orchestrator/service.json`

Native declarations and descriptors are written beneath the paths resolved by
`PathResolver`. A descriptor includes a stable provider ID, one-process-lifetime
instance ID, PID, renewable lease, declaration digest, version, transports, and
health. Writes are atomic and private.

Endpoint resolution order:

1. explicit URL;
2. service-specific environment;
3. explicit instance selection;
4. native runtime descriptor directory;
5. Clawso Foundation-admitted export directory;
6. read-only compatibility probe.

Static declarations never override live endpoints. Expired leases, dead PIDs,
bad health, declaration drift, corrupt siblings, and duplicate instance IDs are
quarantined instead of guessed into a binding. Similar service IDs, ports, or
process names are not association keys.

The optional `CLAWSO_SERVICE_DECLARATION_DIR` and
`CLAWSO_RUNTIME_DESCRIPTOR_DIR` values must point to Foundation-admitted
read-model exports, not an unvalidated installer bundle. For Clawso-managed
instances, Receipt and admission remain Clawso responsibilities.

Discovery answers compatibility and routing questions only. Invocation code
must still check the selected operation's current permissions, effect,
workspace mode, idempotency, and transport requirements.
