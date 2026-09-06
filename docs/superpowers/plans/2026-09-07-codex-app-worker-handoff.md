# Codex App workers by default

User-approved design: systematize PRE-FLIGHT's native App execution while preserving Meridian scheduling and worker identity.

1. Durable private queue with atomic transitions, crash-released POSIX locks, stable request IDs and thread/turn binding.
2. New workers register through native App create_thread; existing sessions continue through native send_message_to_thread after the previous CLI process exits. No CLI seed, transcript copying or internal App writes.
3. Default writable local Codex runs use the executor queue; read-only validation retains its enforced CLI sandbox. Unsupported managed identities/environment bindings fail explicitly.
4. Native heartbeat controller services all queued work, places workers in the Meridian workers sidebar section, mirrors actual progress and returns exact App turn results to the existing stream/lifecycle parser.
5. Cooperative cancellation holds reservations until verified App termination; kill/restart/reboot cannot discard active work. Uncertain submissions cannot be resent.
6. Validate normal/native runs, retry identity, cancellation, crash locks, route selection and independent review. Drain live work, build/install, then activate and prove a real dispatcher handoff.

Operational protocol: [codex-app-worker-handoff.md](../../codex-app-worker-handoff.md).
