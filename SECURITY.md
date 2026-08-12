# Security policy

## Reporting a vulnerability

Please do not disclose an exploitable vulnerability in a public issue. Use the
repository's [private vulnerability reporting
form](https://github.com/yzsnstotz/Meridian/security/advisories/new) and include:

- the affected revision and package;
- a minimal reproduction or proof of concept;
- the expected impact and required local or network access;
- any known mitigation.

Remove unrelated credentials, personal paths, and private log content. The
maintainers will acknowledge the report, assess scope, and coordinate disclosure
and remediation through the advisory.

## Supported code

Security fixes target the latest default-branch revision and any branch or
release explicitly identified by the maintainers as active. Older snapshots may
not receive backports.

## Deployment posture

Meridian is local-first. Runtime, Orchestrator, and Gateway should remain bound
to loopback unless they are placed behind TLS, network restrictions, and an
independent access-control layer. Treat generated Web, bootstrap, caller, and
Gateway keys as credentials.
