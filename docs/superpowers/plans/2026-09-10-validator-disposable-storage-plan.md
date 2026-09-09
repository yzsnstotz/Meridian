# Explicit disposable validation storage

The owner requested the orchestration root cause be fixed and the original round resumed. Its mandatory independent checks require disposable temp files while the source checkout must remain read-only. This is a runtime capability repair, not a product change or acceptance override.

Implementation is opt-in `disposable_storage: true` on a read-only, stateless Codex validator request. Default remains absent/read-only with no scratch grant. Reject other providers, bridge sessions and integration profiles; read/stateless-only callers cannot opt into writes. Hub creates a unique private scratch per execution attempt, passes only that exact path to a uniquely named invocation-only Codex profile derived from `:read-only`, disables command network, overrides TMPDIR/TMP/TEMP, and cleans scratch only after a terminal child. It never edits user/project Codex config or selects a full-access fallback. Managed restrictions remain enforced.

Compatibility: official named permission profiles and the installed Codex CLI 0.153.4 support this capability. Reject unsupported CLI versions before executing an opted-in run. The global strict-config check cannot be used as a compatibility probe on this host because unrelated legacy project config contains unknown fields; that existing config is preserved.

Evidence before implementation: `codex sandbox` in `/tmp/meridian-validator-capability-XfB14h` returned scratch=writable, outside=EPERM and successful mkdtemp. An ephemeral real `codex exec` integration invocation, native thread 01a087a5-9711-7822-988f-408931b9e4d4, repeated the actual command once and returned exit0, scratch=writable/outside=EPERM. This is executor-capability evidence only, not Cyberent acceptance. No product files changed.

Required verification: default compatibility, typed request propagation, source/network confinement, incompatible caller/provider rejection, scratch isolation and cleanup on success/failure, version fail-closed, actual validator receipt at exact candidate SHA after install, then canonical downstream dispatch. No main merge or native App permission/profile repair claim.

Official contract: https://learn.chatgpt.com/docs/permissions and https://learn.chatgpt.com/docs/config-file/config-reference .

## Review and verification

Independent specification review found two child-lifecycle defects: late termination lacked a cleanup callback, and a child created before stdio failure was not handed to its caller. Both are covered by regressions: failed pre-spawn cleanup; unknown live child retained; close-triggered cleanup. Independent quality review additionally required checking effective configuration because legacy sandbox settings can override permission-profile selection. The implementation now performs a bounded read-only public `app-server` initialize/config-read handshake using the same executable, cwd, environment and configuration overrides before each opted-in model execution. It never starts a thread or writes configuration. It rejects legacy/unknown mode, wrong selection, extra filesystem grants, network enabled, malformed results, early exit and timeout. Diagnostic children use the same ownership and deferred-cleanup path. Interruption during preflight prevents subsequent model launch.

The real FREEZE checkout passed this public configuration preflight; injecting a legacy danger-full-access setting was rejected before model execution. These are capability checks, not a replacement for the original independent acceptance commands. A real model-executed disposable scratch probe was already recorded above. Config-read contract: https://learn.chatgpt.com/docs/app-server .

The associated resolve skill was pressure-tested: the old saved instruction chose to leave an unchanged hold untouched when the hourly audit was not due; the new rule chooses scoped repair, preserves a genuine future external wait, escalates an expired wait and refuses to interpret PM completion as resolution. Skill v2.14.0 and the existing heartbeat/guide were updated without creating another controller. Skill origin commit: 50ab2224e133d5ab1b68500f95fb495e13cf0ef7 (topic only; no main merge).

Production install and original validator acceptance remain pending until recorded in a separate exact-file install receipt. No health-check-only or inspection-only completion claim is permitted.
