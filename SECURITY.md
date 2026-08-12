# Security policy

## Reporting a vulnerability

Please do not disclose an exploitable vulnerability in a public issue.

1. First try the repository's [private vulnerability reporting
   form](https://github.com/yzsnstotz/Meridian/security/advisories/new).
2. If GitHub reports that private reporting is unavailable, open a
   [security contact request](https://github.com/yzsnstotz/Meridian/issues/new?template=security_contact.yml)
   containing **no vulnerability details**. A maintainer can then arrange an
   appropriate private channel.

In the private report, include:

- the affected revision and package;
- a minimal reproduction or proof of concept;
- the expected impact and required local or network access;
- any known mitigation.

Remove unrelated credentials, personal paths, and private log content. The
maintainers will acknowledge the report, assess scope, and coordinate disclosure
and remediation privately. Repository administrators should enable GitHub
Private Vulnerability Reporting so the first route remains available.

## Supported code

Security fixes target the latest default-branch revision and any branch or
release explicitly identified by the maintainers as active. Older snapshots may
not receive backports.

## Deployment posture

Meridian is local-first. Runtime, Orchestrator, and Gateway should remain bound
to loopback unless they are placed behind TLS, network restrictions, and an
independent access-control layer. Treat generated Web, bootstrap, caller, and
Gateway keys as credentials.
