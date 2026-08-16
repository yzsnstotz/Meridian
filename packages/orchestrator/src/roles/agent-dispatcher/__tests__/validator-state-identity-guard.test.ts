import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../lifecycle-store";
import {
  applyValidatorVerdictFromContent,
  type ValidatorOrchestratorDeps
} from "../validator-orchestrator";
import { computeValidationStateIdentity } from "../validation-state-identity";
import { resolveManualInterventionWorker, type DispatchContinuationPlanRow } from "../service-continuation";
import type { MeridianApiClient } from "../meridian-api-client";
import type { ValidationStateIdentityIo } from "../validation-state-identity";

/**
 * Wasted-work guard: the `fix_requested` path must refuse to spawn cycle N+1
 * when the row's observable state is byte-identical to the state cycle N was
 * already judged against.
 *
 * Round `unification-layer-decoupling-2026-08-06`, worker `BATCH-8-GATE`:
 * cycles 1-4 all returned `fix_requested` with an identical objection set and
 * a score stuck at 0.5, each "rework" finishing in 56-79 seconds because the
 * worker had nothing it was permitted to change. Each wasted cycle cost one
 * worker resume plus one validator session (~47k tokens of tool output).
 */

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("fix_requested state-identity guard", () => {
  it("routes the row to PM and spawns no further cycle when nothing changed", async () => {
    const harness = await createHarness({ branch: "round/W1-01", headSha: "a".repeat(40) });

    // Cycle 1 — no prior fingerprint exists, so the cycle proceeds normally
    // and the fingerprint of the judged state is recorded.
    const first = await applyVerdict(harness, "Acceptance criterion 3 is unmet.");
    expect(first).toMatchObject({ status: "fix_requested", cycle: 1 });

    const afterFirst = harness.lifecycleStore.load().workers["W1-01"];
    expect(afterFirst?.status).toBe("fix_requested");
    expect(afterFirst?.validation?.state_identity?.determinate).toBe(true);
    const recordedFingerprint = afterFirst?.validation?.state_identity?.fingerprint;
    expect(recordedFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The worker "reworks" without changing a single byte, and the validator
    // returns the same objection.
    harness.lifecycleStore.setWorkerStatus("W1-01", "awaiting_validation", "test_rework_completed");
    const second = await applyVerdict(harness, "Acceptance criterion 3 is unmet.");

    expect(second?.status).toBe("blocked");
    expect(second).toMatchObject({ score: 0.5 });
    expect((second as { reason: string }).reason).toContain("state unchanged since validation cycle 1");

    const afterSecond = harness.lifecycleStore.load().workers["W1-01"];
    // `blocked` — not `failed`. A failed row is only routed to PM once its
    // validation budget is exhausted; this row is stopped well before that.
    expect(afterSecond?.status).toBe("blocked");
    expect(afterSecond?.validation?.current_cycle).toBe(2);
    expect(afterSecond?.validation?.max_fix_cycles).toBe(3);
    expect(afterSecond?.validation?.state_identity?.fingerprint).toBe(recordedFingerprint);
    // The feedback PM will read carries both the orchestrator's reason and the
    // validator's unchanged objection set.
    expect(afterSecond?.validation?.last_feedback).toContain("[ORCHESTRATOR]");
    expect(afterSecond?.validation?.last_feedback).toContain("PM/human decision is required");
    expect(afterSecond?.validation?.last_feedback).toContain("Acceptance criterion 3 is unmet.");

    // The dispatcher's manual-intervention resolver — the code path that
    // actually hands a row to the PM resolver — now selects this row. Asserted
    // with the row's ORIGINAL plan status, so this proves the lifecycle status
    // alone routes it and the assertion does not lean on plan-markdown sync.
    expect(
      resolveManualInterventionWorker([buildPlanRow()], harness.lifecycleStore.load())
    ).toBe("W1-01");

    // And the worker's session is left alive so PM can resume it.
    expect(harness.kill).not.toHaveBeenCalledWith("worker-thread-w101");
  });

  it("lets the cycle proceed normally when the branch head advanced", async () => {
    const harness = await createHarness({ branch: "round/W1-01", headSha: "a".repeat(40) });

    const first = await applyVerdict(harness, "Add the missing test.");
    expect(first).toMatchObject({ status: "fix_requested", cycle: 1 });
    const firstFingerprint = harness.lifecycleStore.load().workers["W1-01"]
      ?.validation?.state_identity?.fingerprint;

    harness.headSha = "b".repeat(40);
    harness.lifecycleStore.setWorkerStatus("W1-01", "awaiting_validation", "test_rework_completed");
    const second = await applyVerdict(harness, "Still not quite there.");

    expect(second).toMatchObject({ status: "fix_requested", cycle: 2, maxCycles: 3 });
    const afterSecond = harness.lifecycleStore.load().workers["W1-01"];
    expect(afterSecond?.status).toBe("fix_requested");
    expect(afterSecond?.validation?.state_identity?.fingerprint).not.toBe(firstFingerprint);
  });

  it("lets the cycle proceed when only the report changed", async () => {
    const harness = await createHarness({ branch: "round/W1-01", headSha: "a".repeat(40) });

    await applyVerdict(harness, "Document the migration path.");
    await fs.writeFile(harness.reportPath, "# W1-01\n\nRevised after cycle 1 feedback.\n", "utf8");

    harness.lifecycleStore.setWorkerStatus("W1-01", "awaiting_validation", "test_rework_completed");
    const second = await applyVerdict(harness, "Migration path still thin.");

    expect(second).toMatchObject({ status: "fix_requested", cycle: 2 });
  });

  // ─── NO-GIT rows ──────────────────────────────────────────────────────────
  //
  // Gate rows (`BATCH-*-GATE`, `LEGACY-ZERO-GATE`, `W0-03`) have no branch at
  // all. Their identity is card + capsule + report, and a missing branch is
  // recorded as `absent` rather than silently read as "identical" — an empty
  // `git log` for such a row means "there is nothing to log", not "no new
  // commits".

  it("fires on a NO-GIT gate row whose card, capsule and report are all unchanged", async () => {
    const harness = await createHarness({ workerId: "BATCH-8-GATE", branch: null });

    const first = await applyVerdict(harness, "Batch 8 acceptance not demonstrated.");
    expect(first).toMatchObject({ status: "fix_requested", cycle: 1 });

    harness.lifecycleStore.setWorkerStatus("BATCH-8-GATE", "awaiting_validation", "test_rework_completed");
    const second = await applyVerdict(harness, "Batch 8 acceptance not demonstrated.");

    expect(second?.status).toBe("blocked");
    expect(harness.lifecycleStore.load().workers["BATCH-8-GATE"]?.status).toBe("blocked");
    // No git was consulted for a row that has no branch.
    expect(harness.execFile).not.toHaveBeenCalled();
  });

  it("does NOT fire on a NO-GIT row that rewrote its report — the report is that row's only deliverable", async () => {
    const harness = await createHarness({ workerId: "BATCH-8-GATE", branch: null });

    await applyVerdict(harness, "Batch 8 acceptance not demonstrated.");
    await fs.writeFile(harness.reportPath, "# BATCH-8-GATE\n\nRe-ran every acceptance command.\n", "utf8");

    harness.lifecycleStore.setWorkerStatus("BATCH-8-GATE", "awaiting_validation", "test_rework_completed");
    const second = await applyVerdict(harness, "Still not demonstrated.");

    expect(second).toMatchObject({ status: "fix_requested", cycle: 2 });
  });

  it("does NOT fire when nothing at all was observable", async () => {
    // No card, no capsule, no branch, no expected outputs: every component is
    // `absent`, so both fingerprints are byte-equal and both mean "we know
    // nothing". Routing to PM on that would be routing on our own blindness.
    const harness = await createHarness({
      workerId: "LEGACY-ZERO-GATE",
      branch: null,
      writeCard: false,
      writeCapsule: false,
      expectedOutputs: []
    });

    await applyVerdict(harness, "No evidence found.");
    harness.lifecycleStore.setWorkerStatus("LEGACY-ZERO-GATE", "awaiting_validation", "test_rework_completed");
    const second = await applyVerdict(harness, "No evidence found.");

    expect(second).toMatchObject({ status: "fix_requested", cycle: 2 });
    const stored = harness.lifecycleStore.load().workers["LEGACY-ZERO-GATE"]?.validation?.state_identity;
    expect(stored?.observed).toBe(false);
    expect(stored?.determinate).toBe(false);
  });

  it("does NOT fire when a declared branch could not be resolved", async () => {
    const harness = await createHarness({ branch: "round/W1-01", headSha: null });

    await applyVerdict(harness, "Unmet criterion.");
    harness.lifecycleStore.setWorkerStatus("W1-01", "awaiting_validation", "test_rework_completed");
    const second = await applyVerdict(harness, "Unmet criterion.");

    // Byte-equal fingerprints, but the branch component is `unresolved`: the
    // row may well have advanced and we simply could not see it.
    expect(second).toMatchObject({ status: "fix_requested", cycle: 2 });
  });

  it("stops the row before the budget is exhausted, saving the remaining cycles", async () => {
    const harness = await createHarness({ branch: "round/W1-01", headSha: "a".repeat(40) });

    await applyVerdict(harness, "Objection A.");
    harness.lifecycleStore.setWorkerStatus("W1-01", "awaiting_validation", "test_rework_completed");
    await applyVerdict(harness, "Objection A.");

    const worker = harness.lifecycleStore.load().workers["W1-01"];
    // The old behaviour burned cycles 3 and 4 (worker resume + validator
    // session each) before max_fix_cycles finally stopped the row.
    expect(worker?.validation?.current_cycle).toBe(2);
    expect(worker?.validation?.history).toHaveLength(2);
    expect(worker?.status).toBe("blocked");
  });
});

describe("lifecycle state backward compatibility", () => {
  it("loads on-disk state written before state_identity existed", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-identity-compat-"));
    tempDirectories.add(directory);
    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    const sidecarPath = path.join(directory, "dispatch_threads.json");

    // Byte-shaped exactly like the currently-deployed binary writes it: the
    // `validation` block has no `state_identity` key at all.
    await fs.writeFile(sidecarPath, JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-legacy",
        started_at: "2026-08-06T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "W1-01": {
          thread_id: "codex_11",
          trace_id: null,
          started_at: "2026-08-06T00:00:00.000Z",
          last_seen_at: "2026-08-06T01:00:00.000Z",
          status: "fix_requested",
          expected_outputs: ["/tmp/reports/W1-01.md"],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: 0.5,
            last_feedback: "Acceptance criterion 3 is unmet.",
            history: [
              {
                cycle: 1,
                score: 0.5,
                feedback: "Acceptance criterion 3 is unmet.",
                validator_thread_id: "codex_19",
                timestamp: "2026-08-06T01:00:00.000Z"
              }
            ],
            spawn_failure_count: 0,
            last_spawn_failure_at: null
          }
        }
      },
      last_reconciled_at: null
    }, null, 2), "utf8");

    const store = new LifecycleStore(sidecarPath, { dispatchPlanPath });
    const state = store.load();

    expect(state.workers["W1-01"]?.validation?.current_cycle).toBe(1);
    expect(state.workers["W1-01"]?.validation?.state_identity).toBeUndefined();
    // And the missing field must read as "no comparand yet", not as a crash
    // and not as an accidental match.
    expect(state.workers["W1-01"]?.validation?.state_identity ?? null).toBeNull();

    // A round-trip through the store must still be writable and re-loadable.
    store.recordValidationStateIdentity(
      "W1-01",
      computeValidationStateIdentity(
        {
          workerId: "W1-01",
          dispatchPlanPath,
          branch: null,
          repoDir: directory,
          expectedOutputs: [],
          cycle: 1
        },
        {}
      )
    );
    expect(store.load().workers["W1-01"]?.validation?.state_identity?.cycle).toBe(1);
    expect(store.load().workers["W1-01"]?.validation?.history).toHaveLength(1);
  });
});

// ─── Harness ────────────────────────────────────────────────────────────────

interface Harness {
  lifecycleStore: LifecycleStore;
  deps: ValidatorOrchestratorDeps;
  workerId: string;
  reportPath: string;
  kill: ReturnType<typeof vi.fn>;
  execFile: ReturnType<typeof vi.fn>;
  headSha: string | null;
}

async function createHarness(options: {
  workerId?: string;
  branch: string | null;
  headSha?: string | null;
  writeCard?: boolean;
  writeCapsule?: boolean;
  expectedOutputs?: string[] | null;
}): Promise<Harness> {
  const workerId = options.workerId ?? "W1-01";
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-identity-guard-"));
  tempDirectories.add(directory);

  const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
  await fs.writeFile(dispatchPlanPath, [
    "# Dispatch Plan",
    "",
    "| Status | Batch | Worker | Task | Model | Branch | Depends On | Notes |",
    "|--------|-------|--------|------|-------|--------|------------|-------|",
    `| 🔍 | 1 | ${workerId} | Build | CODEX | ${options.branch ?? "—"} | — | awaiting validation |`
  ].join("\n"), "utf8");

  if (options.writeCard !== false) {
    await fs.writeFile(path.join(directory, `${workerId}.md`), `# ${workerId}\n\nDo the thing.\n`, "utf8");
  }
  if (options.writeCapsule !== false) {
    await fs.mkdir(path.join(directory, "context"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "context", `${workerId}-context.md`),
      "## Files Owned\n- src/a.ts\n\n## Explicitly Forbidden\n- everything else\n",
      "utf8"
    );
  }

  const reportPath = path.join(directory, "reports", `${workerId}.md`);
  const expectedOutputs = options.expectedOutputs === undefined
    ? [reportPath]
    : (options.expectedOutputs ?? []);
  if (expectedOutputs.length > 0) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `# ${workerId}\n\nInitial report.\n`, "utf8");
  }

  const lifecycleStore = new LifecycleStore(path.join(directory, "dispatch_threads.json"), {
    dispatchPlanPath
  });
  lifecycleStore.save({
    version: 2,
    dispatcher: {
      thread_id: "dispatcher-thread-identity",
      started_at: "2026-08-06T00:00:00.000Z",
      status: "running"
    },
    workers: {
      [workerId]: {
        thread_id: `worker-thread-${workerId.toLowerCase().replace(/[^a-z0-9]/gu, "")}`,
        trace_id: null,
        started_at: "2026-08-06T00:00:00.000Z",
        last_seen_at: "2026-08-06T01:00:00.000Z",
        status: "awaiting_validation",
        expected_outputs: expectedOutputs,
        hub_result: null,
        command_preamble: null,
        retry_count: 0,
        validation: {
          current_cycle: 0,
          max_fix_cycles: 3,
          validator_thread_id: null,
          last_score: null,
          last_feedback: null,
          history: []
        }
      }
    },
    last_reconciled_at: null
  });

  const harness: Harness = {
    lifecycleStore,
    workerId,
    reportPath,
    headSha: options.headSha === undefined ? "a".repeat(40) : options.headSha,
    kill: vi.fn().mockResolvedValue({ threadId: "validator", status: "killed", raw: {} }),
    execFile: vi.fn(),
    deps: undefined as unknown as ValidatorOrchestratorDeps
  };

  harness.execFile.mockImplementation(() => {
    if (harness.headSha === null) {
      throw new Error("fatal: Needed a single revision");
    }
    return `${harness.headSha}\n`;
  });

  const stateIdentityIo: ValidationStateIdentityIo = { execFile: harness.execFile };
  const meridianApi: MeridianApiClient = {
    spawn: vi.fn(),
    run: vi.fn(),
    kill: harness.kill,
    listCredentials: vi.fn().mockResolvedValue([])
  };

  harness.deps = {
    lifecycleStore,
    validatorConfig: {
      enabled: true,
      agent_type: "codex",
      mode: "bridge",
      auto_approve: false,
      threshold_type: "score",
      pass_threshold: 0.7,
      max_fix_cycles: 3,
      base_branch: "main"
    },
    meridianApi,
    // "always" so a mistaken terminal-kill would be observable in the test
    // that asserts the worker session survives the PM route.
    killPolicy: "always",
    spawnDir: directory,
    dispatchPlanPath,
    taskspecPath: null,
    stateIdentityIo,
    log: { info: vi.fn(), warn: vi.fn() }
  };

  return harness;
}

async function applyVerdict(harness: Harness, feedback: string) {
  return applyValidatorVerdictFromContent(
    harness.deps,
    harness.workerId,
    "validator-thread-identity",
    [
      "<<<MERIDIAN-STATUS>>>",
      "role: validator",
      `worker_id: ${harness.workerId}`,
      "outcome: fix_requested",
      "score: 0.5",
      "feedback: |",
      `  ${feedback}`,
      "<<<END>>>"
    ].join("\n"),
    { ...buildPlanRow(), worker: harness.workerId }
  );
}

function buildPlanRow(): DispatchContinuationPlanRow {
  return {
    status: "🔍",
    batch: "1",
    worker: "W1-01",
    model: "CODEX",
    depends_on: "—",
    notes: "awaiting validation"
  };
}
