import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RoleContext } from "../../base-role";
import { ChatterRole } from "../../definitions/chatter";
import { ChatterStateStore } from "../chatter-state-store";
import { loadManifestFromFile, parseBackgroundTriggerDurationMs } from "../manifest";
import {
  resetChatterBackgroundTriggerCountersForTests,
  snapshotChatterBackgroundTriggerCounters
} from "../observability";
import {
  BackgroundTriggerEvaluator,
  type BackgroundTriggerFireRequest
} from "../trigger-evaluator";
import type { ChatterRoleConfig, HubMessage, ReplyChannel } from "../../../types";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
};

const NOW = new Date("2026-05-21T00:10:00.000Z");

beforeEach(() => {
  resetChatterBackgroundTriggerCountersForTests();
});

describe("background trigger manifest loading", () => {
  it("parses duration strings and rejects malformed intervals at manifest load", () => {
    expect(parseBackgroundTriggerDurationMs("30s")).toBe(30_000);
    expect(parseBackgroundTriggerDurationMs("10m")).toBe(600_000);
    expect(parseBackgroundTriggerDurationMs("1h")).toBe(3_600_000);

    const root = makeRoot();
    const manifestPath = writeManifest(root, { minInterval: "ten minutes" });

    expect(() => loadManifestFromFile(manifestPath)).toThrow(/min_interval/);
  });

  it("rejects trigger references that do not exist at manifest load", () => {
    const missingPromptRoot = makeRoot();
    const missingPrompt = writeManifest(missingPromptRoot, {
      actionSystemPromptId: "missing_prompt"
    });
    expect(() => loadManifestFromFile(missingPrompt)).toThrow(/unknown system_prompt_id 'missing_prompt'/);

    const missingRecordRoot = makeRoot();
    const missingRecordType = writeManifest(missingRecordRoot, {
      triggerRecordType: "missing_record"
    });
    expect(() => loadManifestFromFile(missingRecordType)).toThrow(/unknown record_type 'missing_record'/);
  });
});

describe("BackgroundTriggerEvaluator", () => {
  it("increments matching trigger state without scheduling below the record threshold", async () => {
    const { evaluator, scheduled, root } = makeEvaluator({ minRecords: 3 });

    await evaluator.handleStructuredWrite(writeEvent("story_short_drama", "s1"));
    await evaluator.handleStructuredWrite(writeEvent("story_short_drama", "s2"));

    expect(scheduled).toEqual([]);
    expect(new ChatterStateStore(root).load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 2,
      last_fire_at: null
    });
  });

  it("does not schedule when records are met but min interval has not elapsed", async () => {
    const { evaluator, scheduled, store } = makeEvaluator({
      minRecords: 3,
      now: new Date("2026-05-21T00:05:00.000Z")
    });
    store.save({
      ...store.load(),
      trigger_state: {
        style_observe_after_stories: {
          records_since_last_fire: 2,
          last_fire_at: "2026-05-21T00:00:00.000Z"
        }
      }
    });

    await evaluator.handleStructuredWrite(writeEvent("story_short_drama", "s3"));

    expect(scheduled).toEqual([]);
    expect(store.load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 3,
      last_fire_at: "2026-05-21T00:00:00.000Z"
    });
  });

  it("schedules and resets throttle state only after the scheduler resolves", async () => {
    const { evaluator, scheduled, store } = makeEvaluator({ minRecords: 3, now: NOW });
    store.save({
      ...store.load(),
      trigger_state: {
        style_observe_after_stories: {
          records_since_last_fire: 2,
          last_fire_at: "2026-05-20T23:00:00.000Z"
        }
      }
    });

    await evaluator.handleStructuredWrite(writeEvent("story_short_drama", "s3"));

    expect(scheduled).toEqual([{
      system_prompt_id: "style_observe",
      origin: "trigger",
      trigger_name: "style_observe_after_stories",
      record_type: "story_short_drama",
      record_key: "s3",
      record: { id: "s3" }
    }]);
    expect(store.load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 0,
      last_fire_at: NOW.toISOString()
    });
    expect(snapshotChatterBackgroundTriggerCounters()).toEqual({
      "style_observe_after_stories|scheduled": 1
    });
  });

  it("keeps throttle state when scheduling fails and records a silent error metric", async () => {
    const { evaluator, store } = makeEvaluator({
      minRecords: 3,
      schedule: async () => {
        throw new Error("scheduler unavailable");
      }
    });
    store.save({
      ...store.load(),
      trigger_state: {
        style_observe_after_stories: {
          records_since_last_fire: 2,
          last_fire_at: null
        }
      }
    });

    await expect(evaluator.handleStructuredWrite(writeEvent("story_short_drama", "s3"))).resolves.toBeUndefined();

    expect(store.load().trigger_state?.style_observe_after_stories).toEqual({
      records_since_last_fire: 3,
      last_fire_at: null
    });
    expect(snapshotChatterBackgroundTriggerCounters()).toEqual({
      "style_observe_after_stories|error": 1
    });
  });

  it("ignores writes for non-matching record types", async () => {
    const { evaluator, scheduled, store } = makeEvaluator({ minRecords: 1 });

    await evaluator.handleStructuredWrite(writeEvent("style_short_drama", "profile"));

    expect(scheduled).toEqual([]);
    expect(store.load().trigger_state).toBeUndefined();
  });
});

describe("ChatterRole background trigger subscription", () => {
  it("routes successful structured.upsert events through the background trigger evaluator", async () => {
    const root = makeRoot();
    const manifestPath = writeManifest(root, { minRecords: 3, minInterval: "10m" });
    const scheduled: BackgroundTriggerFireRequest[] = [];
    const sent: HubMessage[] = [];
    const ctx: RoleContext = {
      sendToHub: async (msg) => {
        sent.push(msg as HubMessage);
      },
      listInstances: async () => [],
      log: { debug() {}, info() {}, warn() {}, error() {} }
    };
    const role = new ChatterRole("chatter-tenant-a", makeConfig(root, manifestPath), {
      scheduleSelfInitiatedTurn: async (request) => {
        scheduled.push(request);
      },
      now: () => NOW
    });
    await role.onActivate(ctx);

    await role.handleAgentToolCall("structured.upsert", {
      type: "story_short_drama",
      key: "s1",
      record: { id: "s1" }
    });
    await role.handleAgentToolCall("structured.upsert", {
      type: "story_short_drama",
      key: "s2",
      record: { id: "s2" }
    });
    await role.handleAgentToolCall("structured.upsert", {
      type: "story_short_drama",
      key: "s3",
      record: { id: "s3" }
    });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      system_prompt_id: "style_observe",
      origin: "trigger",
      trigger_name: "style_observe_after_stories",
      record_type: "story_short_drama",
      record_key: "s3"
    });
    expect(sent).toEqual([]);
  });
});

function makeEvaluator(options: {
  minRecords?: number;
  minInterval?: string;
  now?: Date;
  schedule?: (request: BackgroundTriggerFireRequest) => Promise<void>;
} = {}): {
  evaluator: BackgroundTriggerEvaluator;
  scheduled: BackgroundTriggerFireRequest[];
  store: ChatterStateStore;
  root: string;
} {
  const root = makeRoot();
  const manifest = loadManifestFromFile(writeManifest(root, options));
  const store = new ChatterStateStore(root);
  const scheduled: BackgroundTriggerFireRequest[] = [];
  const evaluator = new BackgroundTriggerEvaluator({
    manifest,
    store,
    now: () => options.now ?? NOW,
    scheduleSelfInitiatedTurn: options.schedule ?? (async (request) => {
      scheduled.push(request);
    }),
    log: { warn() {}, debug() {} }
  });
  return { evaluator, scheduled, store, root };
}

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "chatter-background-triggers-"));
}

function writeManifest(root: string, options: {
  minRecords?: number;
  minInterval?: string;
  actionSystemPromptId?: string;
  triggerRecordType?: string;
} = {}): string {
  const promptsDir = path.join(root, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(path.join(promptsDir, "style_observe.md"), "observe style");

  const manifestPath = path.join(root, `${randomUUID()}.json`);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      record_schemas: {
        story_short_drama: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false
        },
        style_short_drama: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false
        }
      },
      system_prompts: {
        style_observe: { prompt_path: "prompts/style_observe.md" }
      },
      background_triggers: [{
        name: "style_observe_after_stories",
        fires_on: {
          type: "after_structured_upsert",
          record_type: options.triggerRecordType ?? "story_short_drama"
        },
        throttle: {
          min_records_since_last_fire: options.minRecords ?? 3,
          min_interval: options.minInterval ?? "10m"
        },
        action: { system_prompt_id: options.actionSystemPromptId ?? "style_observe" }
      }]
    })
  );
  return manifestPath;
}

function writeEvent(type: string, key: string) {
  return {
    name: "structured.write" as const,
    type,
    key,
    record: { id: key }
  };
}

function makeConfig(memoryFolder: string, manifestPath: string): ChatterRoleConfig {
  return {
    chatter_id: "tenant-a",
    memory_folder: memoryFolder,
    manifest_path: manifestPath,
    allowed_modes: ["stateless", "session"],
    skill_allowlist: ["structured.upsert"],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL
  };
}
