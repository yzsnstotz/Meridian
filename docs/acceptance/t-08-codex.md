# T-08 Codex CLI Integration Validation

Date: 2026-03-05

## Scope
- Task: `T-08 · Codex CLI 集成验证`
- Spec source: `v1.0.0/meridian_task_spec_v1_0_0.docx`
- Goal: verify Codex CLI works via `agentapi` in both `bridge` and `pane_bridge` modes.

## Deliverables Mapping
- `src/agents/codex.ts`
  - Delivered: Codex agent config (`type='codex'`) and spawn-args builder.
- `.env`
  - Delivered: `OPENAI_API_KEY` field configured for local runtime.
- `scripts/test-codex.sh`
  - Delivered: E2E script covering both `bridge` and `pane_bridge`.
- Acceptance record
  - Delivered in this document, with execution steps and outcomes.

## Verification Steps
```bash
codex --version
./scripts/test-codex.sh bridge pane_bridge
```

## Acceptance Result
- Codex CLI version: `codex-cli 0.107.0`
- `bridge` mode: PASS
  - `thread_id`: `codex_t08_bridge_1772686972`
  - `marker`: `T08_Codex_OK_bridge_1772686976`
  - `/message` response: `{"ok":true}`
- `pane_bridge` mode: PASS
  - `thread_id`: `codex_t08_pane_bridge_1772686983`
  - `marker`: `T08_Codex_OK_pane_bridge_1772686986`
  - `/message` response: `{"ok":true}`
- Raw run log: `/tmp/meridian-t08-codex.nPtAdq/result.log`

## Notes
- Script fails fast when prerequisites are missing (Codex auth, `agentapi`, `tmux` for pane mode).
- Script accepts either `OPENAI_API_KEY` auth or existing `codex login` auth.
- `pane_bridge` validation includes tmux session existence check.
