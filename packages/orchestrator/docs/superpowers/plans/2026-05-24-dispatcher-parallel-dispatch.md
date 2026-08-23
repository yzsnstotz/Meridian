# Dispatcher Parallel Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in `parallel_dispatch` support to Meridian agent dispatchers while keeping serial behavior unchanged by default.

**Architecture:** Add a normalized config object, expose it in API/GUI/tool start paths, then route enabled dispatchers through a parallel continuation branch that reuses existing dependency, validator, PM, and worker launch helpers. The serial continuation path remains the default and is not rewritten in this pass.

**Tech Stack:** TypeScript, Zod, Node HTTP handlers, Vitest, static HTML/JS GUI.

---

## Scope Check

This plan covers only the `Meridian-roles` implementation. The TaskSpec skill change for `taskspec --meridian --parallel --max-concurrency N` belongs to the Docs skills layer and should be handled in a follow-up plan after this runtime path is working.

## File Structure

- Modify: `src/types.ts`
  - Add `ParallelDispatchConfigSchema` and include it in dispatcher persisted/editor schemas.
- Modify: `src/roles/dispatcher-config-editor.ts`
  - Include `parallel_dispatch` in editable dispatcher config output.
- Modify: `src/roles/agent-dispatcher/prompt-builder.ts`
  - Include parallel dispatch config in generated dispatcher runtime context.
- Modify: `src/roles/definitions/agent-dispatcher.ts`
  - Pass normalized parallel dispatch config into the prompt builder.
- Modify: `src/roles/agent-dispatcher/service-continuation.ts`
  - Add a multi-worker eligible resolver that preserves existing serial selection behavior.
- Modify: `src/server/role-handlers.ts`
  - Accept create/patch payloads, persist runtime switching, and add the parallel continuation branch.
- Modify: `src/tool-gateway/tools/dispatch-start.ts`
  - Add CLI/tool parameters for parallel dispatch and max concurrency.
- Modify: `src/web/public/index.html`
  - Add disabled-by-default parallel controls to the dispatcher start form.
- Modify: `src/web/public/config.html`
  - Add parallel controls to the dispatcher config editor.
- Modify: `src/web/public/app.js`
  - Serialize start/edit parallel config and enforce GUI max-concurrency guidance.
- Modify tests:
  - `src/types.test.ts`
  - `src/roles/agent-dispatcher/__tests__/service-continuation.test.ts`
  - `src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts`
  - `src/roles/definitions/__tests__/agent-dispatcher.test.ts`
  - `src/server/__tests__/role-config-handlers.test.ts`
  - `src/tool-gateway/tools/__tests__/dispatch-start.test.ts`
  - `src/web/public/__tests__/role-config-credentials.test.ts`
  - `src/web/public/__tests__/scheduler-detail-scripts.test.ts`

---

### Task 1: Config Contract And Persistence

**Files:**
- Modify: `src/types.ts`
- Modify: `src/roles/dispatcher-config-editor.ts`
- Modify: `src/server/role-handlers.ts`
- Test: `src/types.test.ts`
- Test: `src/server/__tests__/role-config-handlers.test.ts`

- [ ] **Step 1: Write schema default tests**

Add these tests inside `describe("role config mode defaults", () => { ... })` in `src/types.test.ts`:

```ts
  it("defaults dispatcher parallel dispatch off with one slot", () => {
    const agentDispatcher = AgentDispatcherConfigSchema.parse({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: replyChannels
    });

    expect(agentDispatcher.parallel_dispatch).toEqual({
      enabled: false,
      max_concurrency: 1
    });
  });

  it("preserves explicit dispatcher parallel dispatch config", () => {
    const agentDispatcher = AgentDispatcherConfigSchema.parse({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: replyChannels,
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 3
      }
    });

    expect(agentDispatcher.parallel_dispatch).toEqual({
      enabled: true,
      max_concurrency: 3
    });
  });

  it("rejects invalid dispatcher parallel dispatch max_concurrency", () => {
    const parsed = AgentDispatcherConfigSchema.safeParse({
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: replyChannels,
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 0
      }
    });

    expect(parsed.success).toBe(false);
  });
```

- [ ] **Step 2: Run schema tests to verify they fail**

Run:

```bash
npx vitest run src/types.test.ts -t "dispatcher parallel dispatch"
```

Expected: FAIL because `parallel_dispatch` is not defined yet.

- [ ] **Step 3: Add the config schema**

In `src/types.ts`, after `PmResolverConfigSchema`, add:

```ts
export const ParallelDispatchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  max_concurrency: z.number().int().min(1).default(1)
});
export type ParallelDispatchConfig = z.infer<typeof ParallelDispatchConfigSchema>;
```

In `AgentDispatcherConfigSchema`, add the field beside `pm_resolver`:

```ts
  pm_resolver: PmResolverConfigSchema.optional(),
  parallel_dispatch: ParallelDispatchConfigSchema.optional()
```

In the `AgentDispatcherConfigSchema.transform` block, compute and return the normalized value:

```ts
    const pmResolver = normalizePmResolverConfig(value.pm_resolver, userReplyChannels);
    const parallelDispatch = value.parallel_dispatch ?? {
      enabled: false,
      max_concurrency: 1
    };

    return {
      ...value,
      user_reply_channel: primaryReplyChannel ? cloneReplyChannel(primaryReplyChannel) : undefined,
      user_reply_channels: userReplyChannels,
      use_agent_dispatcher: value.use_agent_dispatcher ?? true,
      pm_resolver: pmResolver,
      parallel_dispatch: parallelDispatch
    };
```

In `AgentDispatcherEditorConfigSchema`, add:

```ts
  pm_resolver: PmResolverConfigSchema,
  parallel_dispatch: ParallelDispatchConfigSchema
```

- [ ] **Step 4: Include parallel config in editable config output**

In `src/roles/dispatcher-config-editor.ts`, inside `toEditableAgentDispatcherConfig`, add the field after `pm_resolver`:

```ts
    pm_resolver: {
      ...config.pm_resolver,
      user_reply_channels: config.pm_resolver.user_reply_channels?.map((replyChannel) => ({ ...replyChannel }))
    },
    parallel_dispatch: { ...config.parallel_dispatch }
```

- [ ] **Step 5: Write create and patch persistence tests**

In `src/server/__tests__/role-config-handlers.test.ts`, add these tests near the existing validator/PM config persistence tests:

```ts
  it("persists parallel dispatch config when starting an agent-dispatcher", async () => {
    const harness = createHarness();

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-parallel-start",
      role_type: "agent-dispatcher",
      dispatch_plan_path: "/tmp/dispatch_plan.md",
      command_file_path: "/tmp/agent_dispatch_command.md",
      user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always",
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 3
      }
    });

    await expect(harness.roleHandlers.getConfig("agent-dispatcher-parallel-start")).resolves.toMatchObject({
      config: {
        parallel_dispatch: {
          enabled: true,
          max_concurrency: 3
        }
      }
    });
  });

  it("persists runtime parallel dispatch config patches for an agent-dispatcher", async () => {
    const harness = createHarness({
      roles: [
        {
          threadId: "agent-dispatcher-parallel-patch",
          roleType: "agent-dispatcher",
          config: {
            tasks: [],
            dispatch_plan_path: "/tmp/dispatch_plan.md",
            command_file_path: "/tmp/agent_dispatch_command.md",
            user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always"
          },
          status: "active"
        }
      ],
      promptStore: {}
    });

    await expect(harness.roleHandlers.patchConfig("agent-dispatcher-parallel-patch", {
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 4
      }
    })).resolves.toMatchObject({
      config: {
        parallel_dispatch: {
          enabled: true,
          max_concurrency: 4
        }
      }
    });

    const persisted = (await harness.stateStore.load())
      ?.roles.find((role) => role.threadId === "agent-dispatcher-parallel-patch")?.config;
    expect(persisted).toMatchObject({
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 4
      }
    });
  });
```

- [ ] **Step 6: Run persistence tests to verify they fail**

Run:

```bash
npx vitest run src/server/__tests__/role-config-handlers.test.ts -t "parallel dispatch config"
```

Expected: FAIL because create and patch schemas do not accept `parallel_dispatch`.

- [ ] **Step 7: Accept and persist create/patch payloads**

In `src/server/role-handlers.ts`, add `ParallelDispatchConfigSchema` to the `../types` imports.

Add to `CreateRoleBodySchema`:

```ts
  pm_resolver: PmResolverConfigSchema.optional(),
  parallel_dispatch: ParallelDispatchConfigSchema.optional(),
  config: z.unknown().optional()
```

Add to `AgentDispatcherConfigPatchSchema`:

```ts
  validator: ValidatorConfigSchema.optional(),
  pm_resolver: PmResolverConfigSchema.optional(),
  parallel_dispatch: ParallelDispatchConfigSchema.optional()
}).strict();
```

In `buildRoleConfigFromBody`, add this field to `rawConfig`:

```ts
    parallel_dispatch:
      parsed.data.parallel_dispatch
      ?? (nestedConfig as { parallel_dispatch?: unknown }).parallel_dispatch,
```

In `patchConfig`, add:

```ts
      if (patch.parallel_dispatch !== undefined) {
        config.parallel_dispatch = patch.parallel_dispatch;
      }
```

- [ ] **Step 8: Run Task 1 tests**

Run:

```bash
npx vitest run src/types.test.ts src/server/__tests__/role-config-handlers.test.ts -t "parallel dispatch"
```

Expected: PASS for the new parallel config tests.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add src/types.ts src/roles/dispatcher-config-editor.ts src/server/role-handlers.ts src/types.test.ts src/server/__tests__/role-config-handlers.test.ts
git commit -m "feat(dispatcher): add parallel dispatch config"
```

---

### Task 2: Prompt Context And Eligible Worker Resolver

**Files:**
- Modify: `src/roles/agent-dispatcher/prompt-builder.ts`
- Modify: `src/roles/definitions/agent-dispatcher.ts`
- Modify: `src/roles/agent-dispatcher/service-continuation.ts`
- Test: `src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts`
- Test: `src/roles/definitions/__tests__/agent-dispatcher.test.ts`
- Test: `src/roles/agent-dispatcher/__tests__/service-continuation.test.ts`

- [ ] **Step 1: Write prompt context tests**

In `src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts`, update `createVars()` to include:

```ts
      parallel_dispatch_config_json: "{\"enabled\":true,\"max_concurrency\":3}",
```

In the first prompt content test, add:

```ts
    expect(prompt).toContain('parallel_dispatch_config_json: {"enabled":true,"max_concurrency":3}');
```

In `src/roles/definitions/__tests__/agent-dispatcher.test.ts`, update the existing `buildSystemPrompt` expectation that includes `pm_resolver_config_json` so it also expects:

```ts
      parallel_dispatch_config_json: "{\"enabled\":false,\"max_concurrency\":1}"
```

- [ ] **Step 2: Run prompt tests to verify they fail**

Run:

```bash
npx vitest run src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts src/roles/definitions/__tests__/agent-dispatcher.test.ts -t "system prompt"
```

Expected: FAIL because the prompt builder does not know the new variable.

- [ ] **Step 3: Add prompt builder support**

In `src/roles/agent-dispatcher/prompt-builder.ts`, add to `AgentDispatcherPromptVars`:

```ts
  parallel_dispatch_config_json?: string;
```

In `buildSystemPromptFromConfig`, pass:

```ts
    parallel_dispatch_config_json: JSON.stringify(config.parallel_dispatch ?? {
      enabled: false,
      max_concurrency: 1
    })
```

In `buildSystemPrompt`, compute:

```ts
  const parallelDispatchConfigJson = vars.parallel_dispatch_config_json?.trim().length
    ? vars.parallel_dispatch_config_json.trim()
    : "{\"enabled\":false,\"max_concurrency\":1}";
```

Add this runtime context line after `pm_resolver_config_json`:

```ts
    `parallel_dispatch_config_json: ${parallelDispatchConfigJson}`,
```

In the rules section, add this sentence near the `continue-dispatcher` instruction:

```ts
    "   When `parallel_dispatch_config_json.enabled` is true, the service may start multiple dependency-eligible workers in one continue tick. Do not spawn around the service scheduler.",
```

- [ ] **Step 4: Pass prompt vars from the role definition**

In `src/roles/definitions/agent-dispatcher.ts`, where `buildSystemPrompt` is called, add:

```ts
      parallel_dispatch_config_json: JSON.stringify(this.config.parallel_dispatch)
```

In `serializeConfigForState`, preserve the normalized field by including:

```ts
    parallel_dispatch: { ...config.parallel_dispatch },
```

- [ ] **Step 5: Preserve generated prompt normalization compatibility**

Do not add `parallel_dispatch_config_json:` to the required marker list in `src/roles/agent-dispatcher/config-normalization.ts`. Older persisted generated prompts do not contain that line, and they must continue to normalize. The new prompt builder output includes the marker for newly materialized prompts without making it a backward-compatibility requirement.

- [ ] **Step 6: Write eligible resolver tests**

In `src/roles/agent-dispatcher/__tests__/service-continuation.test.ts`, update the import:

```ts
import {
  resolveEligibleServiceContinueWorkers,
  resolveManualInterventionWorker,
  resolveServiceContinueWorker
} from "../service-continuation";
```

Add these tests in `describe("service continuation", () => { ... })`:

```ts
  it("returns multiple independent eligible workers for parallel continuation", () => {
    const rows = [
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX", depends_on: "—" },
      { status: "⬜", batch: "1", worker: "R-01", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "⬜", batch: "1", worker: "R-02", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "⬜", batch: "2", worker: "R-03", model: "CODEX", depends_on: "R-01" }
    ];

    expect(resolveEligibleServiceContinueWorkers(rows, createLifecycleState(), { limit: 3 }))
      .toEqual(["R-01", "R-02"]);
    expect(resolveServiceContinueWorker(rows, createLifecycleState())).toBe("R-01");
  });

  it("limits parallel eligible workers in plan order", () => {
    const rows = [
      { status: "✅", batch: "0", worker: "PRE-FLIGHT", model: "CODEX", depends_on: "—" },
      { status: "⬜", batch: "1", worker: "R-01", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "⬜", batch: "1", worker: "R-02", model: "CODEX", depends_on: "PRE-FLIGHT" },
      { status: "⬜", batch: "1", worker: "R-03", model: "CODEX", depends_on: "PRE-FLIGHT" }
    ];

    expect(resolveEligibleServiceContinueWorkers(rows, createLifecycleState(), { limit: 2 }))
      .toEqual(["R-01", "R-02"]);
  });

  it("keeps PRE-FLIGHT exclusive in parallel continuation", () => {
    const rows = [
      { status: "⬜", batch: "0", worker: "PRE-FLIGHT", model: "CODEX", depends_on: "—" },
      { status: "⬜", batch: "1", worker: "R-01", model: "CODEX", depends_on: "—" }
    ];

    expect(resolveEligibleServiceContinueWorkers(rows, createLifecycleState(), { limit: 2 }))
      .toEqual(["PRE-FLIGHT"]);
  });
```

- [ ] **Step 7: Run eligible resolver tests to verify they fail**

Run:

```bash
npx vitest run src/roles/agent-dispatcher/__tests__/service-continuation.test.ts -t "parallel"
```

Expected: FAIL because `resolveEligibleServiceContinueWorkers` does not exist.

- [ ] **Step 8: Implement the multi-worker resolver**

In `src/roles/agent-dispatcher/service-continuation.ts`, add this interface after `DispatchContinuationWorkerRow`:

```ts
export interface ResolveEligibleServiceContinueWorkersOptions {
  limit?: number;
}
```

Replace `resolveServiceContinueWorker` with:

```ts
export function resolveServiceContinueWorker(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string | null {
  return resolveEligibleServiceContinueWorkers(rows, lifecycleState, { limit: 1 })[0] ?? null;
}
```

Add this exported function below it:

```ts
export function resolveEligibleServiceContinueWorkers(
  rows: DispatchContinuationPlanRow[],
  lifecycleState: DispatchThreadStateV2,
  options: ResolveEligibleServiceContinueWorkersOptions = {}
): string[] {
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : Number.POSITIVE_INFINITY;
  const preflightGateWorker = resolvePreflightGateWorker(rows, lifecycleState);
  if (preflightGateWorker !== undefined) {
    return preflightGateWorker ? [preflightGateWorker].slice(0, limit) : [];
  }

  const implicitWorker = resolveImplicitContinueWorker(rows, lifecycleState);
  if (implicitWorker) {
    return [implicitWorker].slice(0, limit);
  }

  const rowsByWorker = indexRowsByWorker(rows);
  const eligibleWorkers: string[] = [];
  for (const row of rows) {
    if (!isEligibleServiceContinueRow(row, rows, rowsByWorker, lifecycleState)) {
      continue;
    }
    const workerId = row.worker.trim();
    if (workerId.length === 0) {
      continue;
    }
    eligibleWorkers.push(workerId);
    if (eligibleWorkers.length >= limit) {
      break;
    }
  }

  return eligibleWorkers;
}
```

Remove the private `resolveFirstEligibleContinueWorker` function and its call site, because the new exported resolver owns that logic.

- [ ] **Step 9: Run Task 2 tests**

Run:

```bash
npx vitest run src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts src/roles/definitions/__tests__/agent-dispatcher.test.ts src/roles/agent-dispatcher/__tests__/service-continuation.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

Run:

```bash
git add src/roles/agent-dispatcher/prompt-builder.ts src/roles/definitions/agent-dispatcher.ts src/roles/agent-dispatcher/service-continuation.ts src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts src/roles/definitions/__tests__/agent-dispatcher.test.ts src/roles/agent-dispatcher/__tests__/service-continuation.test.ts
git commit -m "feat(dispatcher): expose parallel continuation candidates"
```

---

### Task 3: Parallel Dispatcher Continuation

**Files:**
- Modify: `src/server/role-handlers.ts`
- Test: `src/server/__tests__/role-config-handlers.test.ts`

- [ ] **Step 1: Write the parallel continuation launch test**

In `src/server/__tests__/role-config-handlers.test.ts`, add this test near the existing continue-dispatcher tests:

```ts
  it("starts multiple eligible workers up to max_concurrency when parallel dispatch is enabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-parallel-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 0 | PRE-FLIGHT | Ready | CODEX | — | TaskSpec | done |",
      "| ⬜ | 1 | R-01 | First independent task | CODEX | PRE-FLIGHT | TaskSpec | ready |",
      "| ⬜ | 1 | R-02 | Second independent task | CODEX | PRE-FLIGHT | TaskSpec | ready |",
      "| ⬜ | 2 | R-03 | Downstream task | CODEX | R-01 | TaskSpec | waits |"
    ].join("\n"), "utf8");

    const launchDispatchWorker = vi.fn(async ({ workerId }) => ({
      ok: true,
      workerId,
      threadId: `thread-${workerId.toLowerCase()}`,
      traceId: `trace-${workerId.toLowerCase()}`
    }));
    const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-parallel-continue",
      role_type: "agent-dispatcher",
      dispatch_plan_path: dispatchPlanPath,
      command_file_path: path.join(tempDir, "agent_dispatch_command.md"),
      user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always",
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 2
      }
    });

    const result = await harness.roleHandlers.continueDispatcher("agent-dispatcher-parallel-continue");

    expect(result).toMatchObject({
      ok: true,
      status: "continued_parallel",
      started_workers: ["R-01", "R-02"],
      running_workers: ["R-01", "R-02"],
      available_slots: 0,
      max_concurrency: 2
    });
    expect(launchDispatchWorker).toHaveBeenCalledTimes(2);
    expect(launchDispatchWorker.mock.calls.map((call) => call[0].workerId)).toEqual(["R-01", "R-02"]);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Write slot and dependency tests**

Add these tests next to the launch test:

```ts
  it("does not start dependency-blocked workers even when parallel slots are available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-parallel-deps-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 0 | PRE-FLIGHT | Ready | CODEX | — | TaskSpec | done |",
      "| ⬜ | 1 | R-01 | First independent task | CODEX | PRE-FLIGHT | TaskSpec | ready |",
      "| ⬜ | 2 | R-02 | Downstream task | CODEX | R-01 | TaskSpec | waits |"
    ].join("\n"), "utf8");

    const launchDispatchWorker = vi.fn(async ({ workerId }) => ({
      ok: true,
      workerId,
      threadId: `thread-${workerId.toLowerCase()}`,
      traceId: `trace-${workerId.toLowerCase()}`
    }));
    const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-parallel-deps",
      role_type: "agent-dispatcher",
      dispatch_plan_path: dispatchPlanPath,
      command_file_path: path.join(tempDir, "agent_dispatch_command.md"),
      user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always",
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 3
      }
    });

    const result = await harness.roleHandlers.continueDispatcher("agent-dispatcher-parallel-deps");

    expect(result).toMatchObject({
      status: "continued_parallel",
      started_workers: ["R-01"]
    });
    expect(launchDispatchWorker).toHaveBeenCalledTimes(1);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses running workers to reduce available parallel slots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-continue-parallel-slots-"));
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const lifecyclePath = path.join(tempDir, "dispatch_threads.json");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 0 | PRE-FLIGHT | Ready | CODEX | — | TaskSpec | done |",
      "| 🔄 | 1 | R-01 | Already running | CODEX | PRE-FLIGHT | TaskSpec | running |",
      "| ⬜ | 1 | R-02 | Second task | CODEX | PRE-FLIGHT | TaskSpec | ready |",
      "| ⬜ | 1 | R-03 | Third task | CODEX | PRE-FLIGHT | TaskSpec | ready |"
    ].join("\n"), "utf8");
    await fs.writeFile(lifecyclePath, JSON.stringify({
      version: 2,
      dispatcher: { thread_id: null, started_at: null, status: "pending" },
      workers: {
        "R-01": {
          thread_id: "thread-r01",
          trace_id: null,
          started_at: "2026-05-24T00:00:00.000Z",
          last_seen_at: "2026-05-24T00:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2), "utf8");

    const launchDispatchWorker = vi.fn(async ({ workerId }) => ({
      ok: true,
      workerId,
      threadId: `thread-${workerId.toLowerCase()}`,
      traceId: `trace-${workerId.toLowerCase()}`
    }));
    const harness = createHarness(undefined, undefined, [], null, null, null, null, launchDispatchWorker);

    await createRole(harness.roleHandlers, {
      thread_id: "agent-dispatcher-parallel-slots",
      role_type: "agent-dispatcher",
      dispatch_plan_path: dispatchPlanPath,
      command_file_path: path.join(tempDir, "agent_dispatch_command.md"),
      user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always",
      parallel_dispatch: {
        enabled: true,
        max_concurrency: 2
      }
    });

    const result = await harness.roleHandlers.continueDispatcher("agent-dispatcher-parallel-slots");

    expect(result).toMatchObject({
      status: "continued_parallel",
      started_workers: ["R-02"],
      running_workers: ["R-01", "R-02"],
      available_slots: 0
    });
    expect(launchDispatchWorker).toHaveBeenCalledTimes(1);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
```

- [ ] **Step 3: Run continuation tests to verify they fail**

Run:

```bash
npx vitest run src/server/__tests__/role-config-handlers.test.ts -t "parallel"
```

Expected: FAIL because the server still blocks when any worker is running and returns only one selected worker.

- [ ] **Step 4: Extend the continuation response type**

In `src/server/role-handlers.ts`, update `ContinueDispatcherResponse`:

```ts
export interface ContinueDispatcherResponse {
  ok: true;
  status: "continued" | "continued_parallel" | "still_blocked" | "plan_complete" | "local_tool_bootstrap_failed" | "manual_intervention_required" | "validation_in_progress" | "validation_feedback_delivered";
  message: string;
  dispatcher_thread_id?: string;
  worker?: string;
  started_workers?: string[];
  running_workers?: string[];
  available_slots?: number;
  max_concurrency?: number;
  launch_failures?: Array<{
    worker: string;
    error: string;
    local_tool_bootstrap_failure?: boolean;
  }>;
  pm_resolver_thread_ids?: string[];
  resume_result?: Awaited<ReturnType<typeof executeResumeWorkerAction>>;
  error?: string;
  validation_outcome?: string;
}
```

- [ ] **Step 5: Import the multi-worker resolver**

In the `service-continuation` import in `src/server/role-handlers.ts`, add:

```ts
  resolveEligibleServiceContinueWorkers,
```

- [ ] **Step 6: Add running-worker helpers**

Near `findBlockingRunningNonHumanWorkers`, add:

```ts
function findActiveRunningNonHumanWorkers(
  rows: DispatchPlanRow[],
  lifecycleState: DispatchThreadStateV2
): string[] {
  const running = new Set<string>();
  for (const worker of findRunningNonHumanWorkers(rows)) {
    if (!isLifecycleTerminal(lifecycleState, worker)) {
      running.add(worker);
    }
  }

  for (const row of rows) {
    if (isHumanDispatchRow(row)) {
      continue;
    }
    const workerId = row.worker.trim();
    if (!workerId) {
      continue;
    }
    if (lifecycleState.workers[workerId]?.status === "running") {
      running.add(workerId);
    }
  }

  return Array.from(running);
}
```

- [ ] **Step 7: Extract dispatcher-thread resolution**

Above `continueDispatcherForRole`, add:

```ts
  async function resolveEffectiveDispatcherThreadIdForContinue(
    threadId: string,
    dispatchPlanPath: string,
    lifecycleState: DispatchThreadStateV2
  ): Promise<string | undefined> {
    let effectiveDispatcherThreadId = (() => {
      const activeRole = options.runner.getRole(threadId);
      if (activeRole?.roleType === "agent-dispatcher") {
        return extractDispatcherThreadId(activeRole) ?? lifecycleState.dispatcher.thread_id ?? undefined;
      }

      return lifecycleState.dispatcher.thread_id ?? undefined;
    })();

    effectiveDispatcherThreadId = await validateDispatcherThreadForContinue(
      dispatchPlanPath,
      threadId,
      effectiveDispatcherThreadId,
      attachToThread,
      log,
      async () => {
        await persistAgentDispatcherRoleStatus(stateStore, threadId, NEEDS_REACTIVATION_ROLE_STATUS);
      }
    );

    return effectiveDispatcherThreadId;
  }
```

Replace the duplicated inline block in `continueDispatcherForRole` with:

```ts
    const effectiveDispatcherThreadId = await resolveEffectiveDispatcherThreadIdForContinue(
      threadId,
      dispatchPlanPath,
      lifecycleState
    );
```

- [ ] **Step 8: Add the parallel continuation branch**

Add this helper above `continueDispatcherForRole`:

```ts
  async function continueParallelDispatcherForRole(args: {
    threadId: string;
    context: RoleConfigContext;
    dispatchPlanData: DispatchPlanData;
    lifecycleState: DispatchThreadStateV2;
    dispatchPlanPath: string;
    shouldActivateAfterContinue: boolean;
    dispatcherThreadId?: string;
  }): Promise<ContinueDispatcherResponse | null> {
    const parallelConfig = args.context.effectiveConfig.parallel_dispatch;
    if (!parallelConfig.enabled) {
      return null;
    }

    const maxConcurrency = parallelConfig.max_concurrency;
    const activeWorkers = findActiveRunningNonHumanWorkers(args.dispatchPlanData.rows, args.lifecycleState);
    const availableSlots = Math.max(0, maxConcurrency - activeWorkers.length);
    if (availableSlots <= 0) {
      return {
        ok: true,
        status: "still_blocked",
        message: `still blocked: parallel worker limit reached (${activeWorkers.length}/${maxConcurrency})`,
        ...(args.dispatcherThreadId ? { dispatcher_thread_id: args.dispatcherThreadId } : {}),
        running_workers: activeWorkers,
        available_slots: 0,
        max_concurrency: maxConcurrency
      };
    }

    const candidates = resolveEligibleServiceContinueWorkers(
      args.dispatchPlanData.rows,
      args.lifecycleState,
      { limit: availableSlots + activeWorkers.length }
    ).filter((workerId) => !activeWorkers.includes(workerId));

    const startedWorkers: string[] = [];
    const launchFailures: NonNullable<ContinueDispatcherResponse["launch_failures"]> = [];

    for (const workerId of candidates) {
      const latestLifecycleState = await loadDispatchLifecycleState(args.dispatchPlanPath, log);
      const latestActiveWorkers = findActiveRunningNonHumanWorkers(args.dispatchPlanData.rows, latestLifecycleState)
        .filter((runningWorkerId) => !startedWorkers.includes(runningWorkerId));
      if (latestActiveWorkers.length + startedWorkers.length >= maxConcurrency) {
        break;
      }

      const workerState = latestLifecycleState.workers[workerId];
      if (
        !args.context.effectiveConfig.validator?.enabled
        && (
          workerState?.status === "awaiting_validation"
          || workerState?.status === "fix_requested"
        )
      ) {
        return {
          ok: true,
          status: "manual_intervention_required",
          message: `manual intervention required: ${workerId} is in ${workerState.status} but validator config is disabled; enable the validator on this dispatcher or apply a different resume action (retry/skip/force-complete)`,
          worker: workerId
        };
      }

      const lifecycleStoreForPmGate = new LifecycleStore(resolveDispatchThreadPath(args.dispatchPlanPath));
      const { live: livePmResolvers } = await findLivePmResolversForWorker(
        latestLifecycleState,
        workerId,
        lifecycleStoreForPmGate,
        attachToThread,
        log,
        sendHubRequestImpl
      );
      if (livePmResolvers.length > 0) {
        continue;
      }

      const otherDispatchPlanPaths = await resolveOtherDispatcherPlanPaths(stateStore, args.threadId);
      const continued = await continueDispatchWorker(
        args.context.effectiveConfig,
        args.dispatchPlanData.rows,
        workerId,
        launchDispatchWorkerImpl,
        undefined,
        otherDispatchPlanPaths
      );
      if (!continued.ok) {
        launchFailures.push({
          worker: workerId,
          error: continued.error ?? "Failed to launch dispatch worker",
          ...(continued.localToolBootstrapFailure ? { local_tool_bootstrap_failure: true } : {})
        });
        continue;
      }

      startedWorkers.push(workerId);
      if (startedWorkers.length >= availableSlots) {
        break;
      }
    }

    if (startedWorkers.length === 0) {
      if (launchFailures.length > 0) {
        const firstFailure = launchFailures[0]!;
        return {
          ok: true,
          status: firstFailure.local_tool_bootstrap_failure ? "local_tool_bootstrap_failed" : "still_blocked",
          message: firstFailure.local_tool_bootstrap_failure
            ? `local tool bootstrap failed: ${firstFailure.error}`
            : `still blocked: failed to launch ${firstFailure.worker}: ${firstFailure.error}`,
          worker: firstFailure.worker,
          error: firstFailure.error,
          launch_failures: launchFailures,
          max_concurrency: maxConcurrency
        };
      }

      return null;
    }

    if (args.shouldActivateAfterContinue) {
      await setAgentDispatcherStatus(args.threadId, ACTIVE_ROLE_STATUS);
    }

    const finalLifecycleState = await loadDispatchLifecycleState(args.dispatchPlanPath, log);
    const runningWorkers = Array.from(new Set([
      ...findActiveRunningNonHumanWorkers(args.dispatchPlanData.rows, finalLifecycleState),
      ...startedWorkers
    ]));

    return {
      ok: true,
      status: "continued_parallel",
      message: `continued parallel: ${startedWorkers.join(", ")}`,
      ...(args.dispatcherThreadId ? { dispatcher_thread_id: args.dispatcherThreadId } : {}),
      started_workers: startedWorkers,
      running_workers: runningWorkers,
      available_slots: Math.max(0, maxConcurrency - runningWorkers.length),
      max_concurrency: maxConcurrency,
      ...(launchFailures.length > 0 ? { launch_failures: launchFailures } : {})
    };
  }
```

- [ ] **Step 9: Route enabled dispatchers into the parallel branch**

In `continueDispatcherForRole`, after validator processing, manual intervention check, and dispatcher-thread resolution, before the serial `runningWorkers` blocker, add:

```ts
    if (!workerId && context.effectiveConfig.parallel_dispatch.enabled) {
      const parallelResult = await continueParallelDispatcherForRole({
        threadId,
        context,
        dispatchPlanData,
        lifecycleState,
        dispatchPlanPath,
        shouldActivateAfterContinue,
        dispatcherThreadId: effectiveDispatcherThreadId
      });
      if (parallelResult) {
        return parallelResult;
      }
    }
```

Keep worker-specific continue endpoints serial by gating with `!workerId`.

- [ ] **Step 10: Run Task 3 tests**

Run:

```bash
npx vitest run src/server/__tests__/role-config-handlers.test.ts -t "parallel"
```

Expected: PASS for config and continuation tests.

- [ ] **Step 11: Commit Task 3**

Run:

```bash
git add src/server/role-handlers.ts src/server/__tests__/role-config-handlers.test.ts
git commit -m "feat(dispatcher): continue eligible workers in parallel"
```

---

### Task 4: GUI And Tool Start Controls

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/config.html`
- Modify: `src/web/public/app.js`
- Modify: `src/tool-gateway/tools/dispatch-start.ts`
- Test: `src/web/public/__tests__/role-config-credentials.test.ts`
- Test: `src/web/public/__tests__/scheduler-detail-scripts.test.ts`
- Test: `src/tool-gateway/tools/__tests__/dispatch-start.test.ts`

- [ ] **Step 1: Write static GUI tests**

In `src/web/public/__tests__/role-config-credentials.test.ts`, add to the `index.html` test:

```ts
    expect(indexHtml).toContain('id="agent-dispatcher-parallel-enabled"');
    expect(indexHtml).toContain('name="parallel_dispatch_enabled"');
    expect(indexHtml).toContain('id="agent-dispatcher-parallel-max-concurrency"');
    expect(indexHtml).toContain('name="parallel_dispatch_max_concurrency"');
```

Add to the `config.html` test:

```ts
    expect(configHtml).toContain('id="cfg-parallel-enabled"');
    expect(configHtml).toContain('id="cfg-parallel-max-concurrency"');
```

Add to the `app.js` test:

```ts
    expect(appScript).toMatch(/collectParallelDispatchConfig/);
    expect(appScript).toMatch(/parallel_dispatch/);
    expect(appScript).toMatch(/max_concurrency/);
```

- [ ] **Step 2: Write dispatch-start tool test**

In `src/tool-gateway/tools/__tests__/dispatch-start.test.ts`, inside the first test's `dispatchStartTool.execute` params, add:

```ts
      parallel: "true",
      max_concurrency: "3",
```

In the expected service request body, add under `config`:

```ts
          parallel_dispatch: {
            enabled: true,
            max_concurrency: 3
          },
```

In the expected tool result data, add:

```ts
        parallel_dispatch: {
          enabled: true,
          max_concurrency: 3
        },
```

- [ ] **Step 3: Run GUI/tool tests to verify they fail**

Run:

```bash
npx vitest run src/web/public/__tests__/role-config-credentials.test.ts src/tool-gateway/tools/__tests__/dispatch-start.test.ts -t "parallel|starts an agent dispatcher"
```

Expected: FAIL because the controls and tool params do not exist.

- [ ] **Step 4: Add dispatcher start form controls**

In `src/web/public/index.html`, insert this fieldset after the main agent config summary grid and before the validator fieldset:

```html
            <fieldset class="field-group" id="agent-dispatcher-parallel-group">
              <legend>Parallel Dispatch</legend>
              <div class="validator-toggle-row">
                <input
                  type="checkbox"
                  id="agent-dispatcher-parallel-enabled"
                  name="parallel_dispatch_enabled"
                />
                <label for="agent-dispatcher-parallel-enabled">Enable dependency-aware parallel worker dispatch</label>
              </div>
              <div id="agent-dispatcher-parallel-fields" class="validator-fields" hidden>
                <label class="field">
                  <span>max_concurrency</span>
                  <input
                    id="agent-dispatcher-parallel-max-concurrency"
                    name="parallel_dispatch_max_concurrency"
                    type="number"
                    min="2"
                    max="32"
                    step="1"
                    value="2"
                  />
                </label>
              </div>
            </fieldset>
```

- [ ] **Step 5: Add config editor controls**

In `src/web/public/config.html`, insert this fieldset after the `kill_policy` / `auto_approve` summary grid and before `user_reply_channels`:

```html
            <fieldset class="field-group">
              <legend>Parallel Dispatch</legend>
              <div class="summary-grid">
                <label class="field">
                  <span>enabled</span>
                  <select id="cfg-parallel-enabled">
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                </label>
                <label class="field">
                  <span>max_concurrency</span>
                  <input id="cfg-parallel-max-concurrency" type="number" min="1" max="32" step="1" value="1" />
                </label>
              </div>
            </fieldset>
```

- [ ] **Step 6: Add app.js collection helpers**

In `src/web/public/app.js`, add this helper after `collectPmResolverConfig`:

```js
function collectParallelDispatchConfig(prefix, options = {}) {
  const enabledElement = document.getElementById(`${prefix}-enabled`);
  const maxElement = document.getElementById(`${prefix}-max-concurrency`);
  const enabled = enabledElement?.type === "checkbox"
    ? enabledElement.checked === true
    : enabledElement?.value === "true";
  const rawMax = parseInt(maxElement?.value, 10);
  const maxConcurrency = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 1;
  const minEnabledConcurrency = options.minEnabledConcurrency ?? 2;

  if (enabled && maxConcurrency < minEnabledConcurrency) {
    throw new Error(`max_concurrency must be at least ${minEnabledConcurrency} when parallel dispatch is enabled.`);
  }

  return {
    enabled,
    max_concurrency: enabled ? maxConcurrency : 1
  };
}

function setupParallelDispatchToggle(prefix) {
  const enabled = document.getElementById(`${prefix}-enabled`);
  const fields = document.getElementById(`${prefix}-fields`);
  if (!enabled || !fields) {
    return;
  }
  const refresh = () => {
    fields.hidden = enabled.checked !== true;
  };
  enabled.addEventListener("change", refresh);
  refresh();
}
```

In the dispatcher page setup where validator setup runs, call:

```js
  setupParallelDispatchToggle("agent-dispatcher-parallel");
```

In `refreshAgentDispatcherPromptPreview`, add:

```js
    try {
      payload.parallel_dispatch = collectParallelDispatchConfig("agent-dispatcher-parallel");
    } catch {
      payload.parallel_dispatch = { enabled: false, max_concurrency: 1 };
    }
```

In the dispatcher start form submit handler, before object cleanup, add:

```js
    try {
      payload.parallel_dispatch = collectParallelDispatchConfig("agent-dispatcher-parallel");
    } catch (error) {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
      return;
    }
```

In config editor setup, add DOM references:

```js
  const cfgParallelEnabled = document.getElementById("cfg-parallel-enabled");
  const cfgParallelMaxConcurrency = document.getElementById("cfg-parallel-max-concurrency");
```

In `populateStructuredFields`, add:

```js
    const parallel = config.parallel_dispatch || {};
    if (cfgParallelEnabled) cfgParallelEnabled.value = String(parallel.enabled === true);
    if (cfgParallelMaxConcurrency) cfgParallelMaxConcurrency.value = parallel.max_concurrency ?? 1;
```

In `setStructuredFieldsDisabled`, add:

```js
    if (cfgParallelEnabled) cfgParallelEnabled.disabled = disabled;
    if (cfgParallelMaxConcurrency) cfgParallelMaxConcurrency.readOnly = disabled;
```

In `collectStructuredPatch`, add:

```js
    patch.parallel_dispatch = collectParallelDispatchConfig("cfg-parallel", { minEnabledConcurrency: 1 });
```

Update the editable fields status text to include `parallel_dispatch`:

```js
        ? "Editable fields: dispatch_plan_path, command_file_path, agent_type, model_id, mode, kill_policy, auto_approve, parallel_dispatch, validator, pm_resolver. Changes apply to subsequent launches."
```

- [ ] **Step 7: Add dispatch-start tool params**

In `src/tool-gateway/tools/dispatch-start.ts`, add params:

```ts
    parallel: {
      type: "string",
      required: false,
      description: "Enable dependency-aware parallel worker dispatch"
    },
    max_concurrency: {
      type: "string",
      required: false,
      description: "Maximum concurrent workers when parallel dispatch is enabled"
    },
```

Extend `executeDispatchStart` args:

```ts
  parallel?: string;
  maxConcurrency?: string;
```

Pass from `execute`:

```ts
        parallel: params.parallel,
        maxConcurrency: params.max_concurrency,
```

Add this parser near `parsePmResolverConfig`:

```ts
function parseParallelDispatchConfig(args: {
  enabled?: string;
  maxConcurrency?: string;
}): { enabled: boolean; max_concurrency: number } {
  const enabled = parseOptionalBoolean(args.enabled) ?? false;
  const rawMax = requireParam(args.maxConcurrency);
  const maxConcurrency = rawMax ? Number.parseInt(rawMax, 10) : 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("max_concurrency must be a positive integer");
  }
  return {
    enabled,
    max_concurrency: enabled ? maxConcurrency : 1
  };
}
```

In `executeDispatchStart`, compute:

```ts
  const parallelDispatch = parseParallelDispatchConfig({
    enabled: args.parallel,
    maxConcurrency: args.maxConcurrency
  });
```

Add it under request `config`:

```ts
          parallel_dispatch: parallelDispatch,
```

Add it under returned `data`:

```ts
      parallel_dispatch: parallelDispatch,
```

- [ ] **Step 8: Run Task 4 tests**

Run:

```bash
npx vitest run src/web/public/__tests__/role-config-credentials.test.ts src/tool-gateway/tools/__tests__/dispatch-start.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

Run:

```bash
git add src/web/public/index.html src/web/public/config.html src/web/public/app.js src/tool-gateway/tools/dispatch-start.ts src/web/public/__tests__/role-config-credentials.test.ts src/tool-gateway/tools/__tests__/dispatch-start.test.ts
git commit -m "feat(dispatcher): expose parallel dispatch controls"
```

---

### Task 5: Integration Verification And Regression Pass

**Files:**
- Verify: all files changed in Tasks 1-4
- Modify only if tests expose a concrete mismatch

- [ ] **Step 1: Run focused dispatcher suites**

Run:

```bash
npx vitest run src/types.test.ts src/roles/agent-dispatcher/__tests__/service-continuation.test.ts src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts src/roles/definitions/__tests__/agent-dispatcher.test.ts src/server/__tests__/role-config-handlers.test.ts src/tool-gateway/tools/__tests__/dispatch-start.test.ts src/web/public/__tests__/role-config-credentials.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run broader static GUI tests likely affected by app.js/config markup**

Run:

```bash
npx vitest run src/web/public/__tests__/scheduler-detail-scripts.test.ts src/web/public/__tests__/process-monitor-scripts.test.ts src/server/__tests__/role-config-handlers.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the full unit test suite if focused tests pass**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat HEAD~4..HEAD
git diff --check HEAD~4..HEAD
git status --short
```

Expected: only intentional dispatcher parallel dispatch files changed, no whitespace errors, clean worktree.

- [ ] **Step 6: Commit any verification-only fixes**

If Step 1-4 exposed fixes after Task 4's commit, commit them:

```bash
git add src tests
git commit -m "fix(dispatcher): stabilize parallel dispatch regressions"
```

If no fixes were needed, skip this step and keep the worktree clean.

---

## Follow-Up Plan: TaskSpec Parallel Mode

Create a separate plan in the Docs skills repo for:

- `taskspec --meridian --parallel`
- `taskspec --meridian --parallel --max-concurrency N`
- DAG dependency audit
- write-scope conflict audit
- per-worker worktree policy for parallel implementation workers
- dispatch command emission of `parallel_dispatch`

Do not implement that in this Meridian-roles runtime branch.
