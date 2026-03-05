# T-10 E2E Checklist (Manual Telegram Acceptance)

Spec mapping sources:
- `v1.0.0/meridian_requirements_v1.0.0.docx` Chapter 13
- `v1.0.0/meridian_task_spec_v1_0_0.docx` T-10 section

## 0) Test Preparation

1. Run `./user_scripts/restart.sh`.
2. If chat ID is still unknown, run `./user_scripts/get_chat_id.sh` and send one message to `@ao003bot`.
3. Keep one terminal for logs:
   - `tail -f /var/log/hub/hub.log /var/log/hub/interface.log /var/log/hub/monitor.log`
   - If running npm-mode restart fallback, use: `tail -f ./logs/hub.log ./logs/interface.log ./logs/monitor.log`

## 1) Section 13 One-to-One Acceptance Mapping

| ID | Chapter 13 Criterion | Slash command / action | Expected Telegram response | Result |
|---|---|---|---|---|
| 13-1 | Interface Layer: Telegram Bot Long Polling/Webhook channel works, message is converted to HubMessage | Send `/help`, then send plain text `T10_INTERFACE_OK` | `/help` returns command usage text immediately; plain text is accepted as runnable message input (not rejected as invalid command). | [ ] Pass [ ] Fail |
| 13-2 | Hub Core: normalize + route + dispatch + return | `/spawn type=codex mode=bridge`, then send `Reply exactly: T10_HUB_CORE_OK` | Telegram returns result message with headline format `[success] thread=<thread_id> trace=<uuid>` and includes `T10_HUB_CORE_OK`. | [ ] Pass [ ] Fail |
| 13-3 | agentapi integration: Claude/Codex/Gemini/Cursor can each be addressed and return result | For each type run `/spawn type=<claude|codex|gemini|cursor> mode=bridge`, then send a short prompt and wait for output | Each type returns a success result in Telegram (no routing/auth parse failure). | [ ] Pass [ ] Fail |
| 13-4 | Bridge mode acceptance | `/spawn type=codex mode=bridge`, then send one prompt | Agent runs in background and result arrives in Telegram without needing tmux attachment. | [ ] Pass [ ] Fail |
| 13-5 | Pane Bridge mode acceptance | `/spawn type=claude mode=pane_bridge`, then send one prompt; on host run `tmux ls` and `tmux attach -t agent_<thread_id>` to check output | Telegram receives final result, and tmux pane shows live terminal output for the same run. | [ ] Pass [ ] Fail |
| 13-6 | IPC communication via Unix sockets (not TCP) | After spawning an instance, run `/status thread=<thread_id>` and on host check `ls /tmp/agentapi-*.sock /tmp/hub*.sock` | Status succeeds in Telegram, and socket files exist under `/tmp/*.sock` (no TCP endpoint dependency). | [ ] Pass [ ] Fail |
| 13-7 | Slash commands: `/spawn /kill /status /attach /list /help` all available, `/spawn` supports `type` + `mode` | Execute all six commands at least once using valid args | Every command returns expected success/usage response; `/spawn` accepts both `type` and `mode`. | [ ] Pass [ ] Fail |
| 13-8 | Instance management: multiple agent instances can be started and managed separately | Spawn at least two instances of different types; run `/list`; `/attach thread=<id_A>` then send prompt; `/attach thread=<id_B>` then send prompt; finally `/kill thread=<id_A>` | `/list` shows multiple instances, attach switches active thread correctly, and kill only removes target instance. | [ ] Pass [ ] Fail |
| 13-9 | Monitor minimal acceptance: SSE + heartbeat fallback, crash/timeout alert to Telegram | Spawn one instance, then manually kill agentapi process on host (`pkill -f "agentapi.*<thread_id>"`) | Telegram receives monitor/health error alert for that thread (error notification visible to operator). | [ ] Pass [ ] Fail |
| 13-10 | Observability: trace_id can reconstruct full chain | Copy one real `trace=<uuid>` from Telegram result headline, run `./user_scripts/verify_logs.sh <trace_id>` | Script prints chronologically merged records across `hub.log`, `interface.log`, `monitor.log` for the same trace. | [ ] Pass [ ] Fail |

## 2) T-10 Mandatory Extra Checks from Task Spec

| ID | Task-spec Requirement | Action | Expected Telegram response | Result |
|---|---|---|---|---|
| T10-X1 | End-to-end slash flow chain | Run complete chain once: `/spawn (bridge + pane_bridge)` -> send prompt -> `/status` -> `/list` -> `/kill` | Each step returns expected result in Telegram with no broken transition. | [ ] Pass [ ] Fail |
| T10-X2 | Long text fallback (>4096 chars) | Send a prompt that forces a very long response (>4096 chars) | Telegram sends file/document fallback (not truncated plain message), with result context preserved. | [ ] Pass [ ] Fail |
| T10-X3 | trace_id cross-file evidence | Pick one real trace_id and archive output of `./user_scripts/verify_logs.sh <trace_id>` as acceptance evidence | One command output clearly demonstrates cross-file chain query for that trace. | [ ] Pass [ ] Fail |

## 3) Acceptance Summary

- Date:
- Tester:
- Bot username:
- Telegram user id:
- Chat id:
- Overall verdict: [ ] PASS  [ ] FAIL
- Known issues and recommended fix:
