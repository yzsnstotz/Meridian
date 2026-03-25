# PR-REVIEW Report

- Worker: `PR-REVIEW`
- Model: `CODEX`
- Date: `2026-03-25`
- Status: `✅ COMPLETE`
- Review Scope: `git diff main..HEAD` against the investigation report, solution PRD, TaskSpec acceptance criteria, `delta_check_report.md`, and corrective worker `R-06`

## Source Review

| File | Worker | Verdict | Notes |
|------|--------|---------|-------|
| [src/hub/router.ts](/Users/yzliu/work/Meridian/src/hub/router.ts#L480) | `R-02` | `❌ Missing` | The canonical-history and structured `/api/progress` work largely aligns, but [`handleRun()`](/Users/yzliu/work/Meridian/src/hub/router.ts#L480) now always persists whatever fallback content it has via [`recordAgentConversationEntry()`](/Users/yzliu/work/Meridian/src/hub/router.ts#L504). Direct repro with an immediate approval frame stored `event_kind=final_reply` instead of `approval`, so refresh cannot restore the unresolved approval state required by F-02 / R-01. |
| [src/shared/agent-output.ts](/Users/yzliu/work/Meridian/src/shared/agent-output.ts#L14) | `R-03/R-06` | `❌ Missing` | The transient classifier no longer recognizes Codex `• Working (… esc to interrupt)` chrome, and [`resolveFallbackRunContent()`](/Users/yzliu/work/Meridian/src/hub/router.ts#L2230) plus the 3-poll early exit in [`waitForAgentReply()`](/Users/yzliu/work/Meridian/src/hub/router.ts#L2130) still promote unresolved progress to completion. Direct repros stored either the working frame or `Agent is processing...` as `final_reply`, which breaks F-03 durable liveness and single-final resolution. |
| [src/hub/router.test.ts](/Users/yzliu/work/Meridian/src/hub/router.test.ts#L116) | `R-04` | `⚠️ Scope Drift` | The suite still passes because the direct `run` fallback path now only asserts returned content for the ACK/error case; the earlier approval/progress history assertions that would catch the blocker above are no longer present. |
| [src/shared/agent-output.test.ts](/Users/yzliu/work/Meridian/src/shared/agent-output.test.ts#L1) | `R-04` | `⚠️ Scope Drift` | Coverage still exercises Gemini spinner chrome, but there is no regression for the Codex `• Working (… esc to interrupt)` frame that the branch now misclassifies as final content. |
| [src/hub/state-store.ts](/Users/yzliu/work/Meridian/src/hub/state-store.ts#L14) | `R-01` | `✅ Aligned` | Canonical event persistence, legacy migration, and final-reply supersession behavior still align with the TaskSpec except for the direct-run fallback regression introduced higher in the stack. |
| [src/hub/state-store.test.ts](/Users/yzliu/work/Meridian/src/hub/state-store.test.ts) | `R-01` | `✅ Aligned` | Migration and canonical-history coverage remain aligned with the intended event model. |
| [src/web/server.ts](/Users/yzliu/work/Meridian/src/web/server.ts#L48) | `R-02` | `✅ Aligned` | `/api/progress/:threadId` now returns the structured progress snapshot contract the PRD asked for, including a compatibility coercion path for legacy partial payloads. |
| [src/web/server.test.ts](/Users/yzliu/work/Meridian/src/web/server.test.ts) | `R-04/R-05` | `✅ Aligned` | HTTP contract and served-DOM assertions match the structured progress and accessibility requirements. |
| [src/web/public/terminal.html](/Users/yzliu/work/Meridian/src/web/public/terminal.html#L2751) | `R-03/R-05` | `✅ Aligned` | Restore, reconnect replay suppression, keyed progress rendering, and a11y markup all line up with F-01 through F-06 from a source-inspection standpoint. |
| [src/web/public-layout.test.ts](/Users/yzliu/work/Meridian/src/web/public-layout.test.ts) | `R-04/R-05` | `✅ Aligned` | Behavioral restore/reconnect/liveness checks and runtime-oriented a11y smoke coverage are present and passing. |
| [src/hub/server.ts](/Users/yzliu/work/Meridian/src/hub/server.ts#L74) | `R-06` | `✅ Aligned` | `monitor_manual_update` is back in `IMMEDIATE_INTENTS`, which closes the delta-identified queue starvation path. |
| [src/hub/server.priority-queue.test.ts](/Users/yzliu/work/Meridian/src/hub/server.priority-queue.test.ts#L325) | `R-06` | `✅ Aligned` | The queue bypass regression for active-run manual progress updates is reinstated and green. |
| [src/types.ts](/Users/yzliu/work/Meridian/src/types.ts#L25) | `R-02` | `✅ Aligned` | The structured `ThreadProgressSnapshot` schema matches the new web/hub contract. |
| [src/types.test.ts](/Users/yzliu/work/Meridian/src/types.test.ts) | `R-02` | `✅ Aligned` | Schema coverage matches the new structured progress contract. |

## Round Artifacts

| File | Worker | Verdict | Notes |
|------|--------|---------|-------|
| [.env.example](/Users/yzliu/work/Meridian/.env.example) | `PRE-FLIGHT` | `✅ Aligned` | Environment-name additions match the round contract documented in the TaskSpec and dispatch command. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/PRE-FLIGHT_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/PRE-FLIGHT_report.md) | `PRE-FLIGHT` | `✅ Aligned` | Recorded baseline validation and targeted verification accurately. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/R-01_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-01_report.md) | `R-01` | `✅ Aligned` | Canonical-history and migration scope are documented consistently with the code. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/R-02_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-02_report.md) | `R-02` | `✅ Aligned` | Structured history/progress contract work is documented, but the current PR still falls short on the direct-run fallback edge cases noted above. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/R-03_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-03_report.md) | `R-03` | `✅ Aligned` | Restore/reconnect intent matches the shipped terminal implementation. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/R-04_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-04_report.md) | `R-04` | `⚠️ Scope Drift` | The report claims behavioral closure, but the current test suite still misses the direct `run` fallback/history regressions reproduced during PR review. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/R-05_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-05_report.md) | `R-05` | `✅ Aligned` | Runtime accessibility evidence is present and still supports F-04, F-05, and F-06. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/delta/R-06_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta/R-06_report.md) | `R-06` | `✅ Aligned` | The corrective worker accurately records the queue fix and its verification. |
| [docs/branch/feat:experience-fix/v1.0/dev_history/delta_check_report.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta_check_report.md) | `DELTA-CHECK` | `✅ Aligned` | The delta report correctly identified and dispatched the queue-level liveness drift that `R-06` closed. |
| [docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_agent_dispatch_command.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_agent_dispatch_command.md) | `Round Artifact` | `✅ Aligned` | The terminal PR-review workflow was followed for this review. |
| [docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md) | `PR-REVIEW` | `✅ Aligned` | Dispatch state now reflects terminal review completion; merge remains blocked by the reproduced regressions above. |

## Commands Run

```text
git diff --stat main..HEAD
git diff --name-only main..HEAD
git diff --unified=80 main..HEAD -- src/hub/state-store.ts src/hub/router.ts src/web/server.ts src/web/public/terminal.html src/hub/server.ts src/hub/server.priority-queue.test.ts src/types.ts src/shared/agent-output.ts
git diff --unified=80 main..HEAD -- src/hub/router.test.ts src/web/server.test.ts src/web/public-layout.test.ts src/hub/state-store.test.ts src/types.test.ts src/shared/agent-output.test.ts
npx tsc --noEmit
node --test --import tsx /Users/yzliu/work/Meridian/src/web/public-layout.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/web/server.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.monitor.test.ts
node --import tsx --input-type=module -e 'const routerMod = await import("./src/hub/router.ts"); const regMod = await import("./src/hub/registry.ts"); const HubRouter = routerMod.default.HubRouter; const InstanceRegistry = regMod.default.InstanceRegistry; const registry = new InstanceRegistry(); registry.register({ thread_id:"gemini_01", agent_type:"gemini", mode:"bridge", socket_path:"/tmp/agentapi-gemini_01.sock", pid:202, tmux_pane:null, status:"idle", created_at:new Date().toISOString() }); const approvalFrame=["╭──────────────────────────────────────────────────────────────────────────────╮","│ Action Required                                                              │","│                                                                              │","│ ?  Shell git status                                                          │","│                                                                              │","│ git status                                                                   │","│ Allow execution of: 'git'?                                                   │","│                                                                              │","│ ● 1. Allow once                                                              │","│   2. Allow for this session                                                  │","│   3. No, suggest changes (esc)                                               │","│                                                                              │","╰──────────────────────────────────────────────────────────────────────────────╯"].join("\n"); const router = new HubRouter(registry,{ statePath:"/tmp/meridian-router-pr-review-approval-state.json", clientFactory:()=>({ connect: async()=>undefined, disconnect:()=>undefined, sendMessage: async()=>({ content: approvalFrame }), getStatus: async()=>({ status:"waiting" }) })}); const traceId="7d7a1efe-7919-4e8a-b287-75bcfb9018e5"; const result = await router.route({ trace_id: traceId, thread_id:"gemini_01", actor_id:"owner", intent:"run", target:"gemini_01", payload:{ content:"check git status", attachments:[] }, mode:"bridge", reply_channel:{ channel:"telegram", chat_id:"100" } }); console.log(JSON.stringify({status:result.status, content:result.content, history:router.getConversationHistoryForThread("gemini_01").map(({event_kind,content,replace_key})=>({event_kind,content,replace_key}))}, null, 2));'
node --import tsx --input-type=module -e 'const routerMod = await import("./src/hub/router.ts"); const regMod = await import("./src/hub/registry.ts"); const HubRouter = routerMod.default.HubRouter; const InstanceRegistry = regMod.default.InstanceRegistry; const registry = new InstanceRegistry(); registry.register({ thread_id:"codex_03", agent_type:"codex", mode:"pane_bridge", socket_path:"/tmp/agentapi-codex_03.sock", pid:204, tmux_pane:"agent_codex_03", status:"idle", created_at:new Date().toISOString() }); const traceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; let callCount=0; const placeholder=["• Working (0s • esc to interrupt)",""," > Explain this codebase".replace(/^ /,""),"","  gpt-5.4 xhigh · 100% left · ~/work/Meridian"].join("\n"); const router = new HubRouter(registry,{ statePath:"/tmp/meridian-router-pr-review-working-state.json", clientFactory:()=>({ connect: async()=>undefined, disconnect:()=>undefined, sendMessage: async()=>({ ok:true }), getStatus: async()=>({ status:"running" }), getMessages: async()=>{ callCount += 1; if (callCount===1) return [{id:1, role:"agent", content:"old output"}]; return [{id:1, role:"agent", content:"old output"},{id:2, role:"agent", content:placeholder}]; } })}); const result = await router.route({ trace_id: traceId, thread_id:"codex_03", actor_id:"owner", intent:"run", target:"codex_03", payload:{ content:"Explain this codebase", attachments:[] }, mode:"bridge", reply_channel:{ channel:"telegram", chat_id:"100" } }); console.log(JSON.stringify({status:result.status, content:result.content, calls:callCount, history:router.getConversationHistoryForThread("codex_03").map(({event_kind,content,replace_key})=>({event_kind,content,replace_key}))}, null, 2));'
node --import tsx --input-type=module -e 'const routerMod = await import("./src/hub/router.ts"); const regMod = await import("./src/hub/registry.ts"); const HubRouter = routerMod.default.HubRouter; const InstanceRegistry = regMod.default.InstanceRegistry; const registry = new InstanceRegistry(); registry.register({ thread_id:"gemini_slow2", agent_type:"gemini", mode:"pane_bridge", socket_path:"/tmp/agentapi-gemini_slow2.sock", pid:206, tmux_pane:"agent_gemini_slow2", status:"idle", created_at:new Date().toISOString() }); let callCount=0; const router = new HubRouter(registry,{ statePath:"/tmp/meridian-router-pr-review-slow2-state.json", clientFactory:()=>({ connect: async()=>undefined, disconnect:()=>undefined, sendMessage: async()=>({ ok:true }), getStatus: async()=>({ status:"running" }), getMessages: async()=>{ callCount += 1; if (callCount <= 5) return [{id:1, role:"agent", content:"old output"}]; return [{id:1, role:"agent", content:"old output"},{id:2, role:"agent", content:"real final answer"}]; } })}); const result = await router.route({ trace_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc", thread_id:"gemini_slow2", actor_id:"owner", intent:"run", target:"gemini_slow2", payload:{ content:"do slower thing", attachments:[] }, mode:"bridge", reply_channel:{ channel:"telegram", chat_id:"100" } }); console.log(JSON.stringify({status:result.status, content:result.content, calls:callCount, history:router.getConversationHistoryForThread("gemini_slow2").map(({event_kind,content,replace_key})=>({event_kind,content,replace_key}))}, null, 2));'
```

## Command Results

- `git diff` review: `COMPLETE`
- `npx tsc --noEmit`: `PASS`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/web/public-layout.test.ts`: `PASS`
  - Summary: `23 passed, 0 failed, 0 cancelled`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/web/server.test.ts`: `PASS`
  - Summary: `16 passed, 0 failed, 0 cancelled`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`: `PASS`
  - Summary: `45 passed, 0 failed, 0 cancelled`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.monitor.test.ts`: `PASS`
  - Summary: `10 passed, 0 failed, 0 cancelled`
- Immediate approval fallback repro: `FAIL`
  - Evidence: the run result was successful, but history persisted the approval prompt as `event_kind=final_reply` with no replace key, not as an `approval` event
- Codex working-frame repro: `FAIL`
  - Evidence: the run result and canonical history both stored the `• Working (0s • esc to interrupt)` frame as a `final_reply`
- Slow/no-new-snapshot repro: `FAIL`
  - Evidence: after five unchanged polls, the run resolved to `Agent is processing...` and persisted that placeholder as `final_reply` even though a real reply would appear on the next poll

## Scope-Drift Summary

Core implementation work aligns on canonical history, structured progress, reconnect replay suppression, runtime accessibility evidence, and the `R-06` queue fix. Merge is still blocked because the direct `run` fallback path can promote unresolved approval/progress state into canonical final replies, and the current regression suite does not cover that path.

MERGE BLOCKED — direct `run` fallback still records approval/progress placeholders as canonical final replies
