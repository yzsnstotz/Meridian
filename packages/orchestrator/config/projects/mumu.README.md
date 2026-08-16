# mumu Project Deployment Paths

`config/projects/mumu.json` is the source of truth for the registered mumu project policy in this repository.

At install or upgrade time, deployment must copy the mumu project artifact directory from `config/projects/mumu/` in this repo to `/etc/meridian-roles/projects/mumu/` on the meridian-roles host. The policy file points at that deployed directory for `manifest.json` and `seeds/`.
