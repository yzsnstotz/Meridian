import type { ChatterStateStore } from "./chatter-state-store";
import {
  parseBackgroundTriggerDurationMs,
  type ChatterManifest
} from "./manifest";
import { incrementChatterBackgroundTriggerTotal } from "./observability";
import type { StructuredWriteEvent } from "./skills/structured";

export interface BackgroundTriggerFireRequest {
  system_prompt_id: string;
  origin: "trigger";
  trigger_name: string;
  record_type: string;
  record_key: string;
  record: unknown;
}

export type ScheduleSelfInitiatedTurn = (request: BackgroundTriggerFireRequest) => Promise<void>;

export interface BackgroundTriggerLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface BackgroundTriggerEvaluatorOptions {
  manifest: ChatterManifest;
  store: ChatterStateStore;
  scheduleSelfInitiatedTurn: ScheduleSelfInitiatedTurn;
  now?: () => Date;
  log?: BackgroundTriggerLogger;
}

export class BackgroundTriggerEvaluator {
  private readonly manifest: ChatterManifest;
  private readonly store: ChatterStateStore;
  private readonly scheduleSelfInitiatedTurn: ScheduleSelfInitiatedTurn;
  private readonly now: () => Date;
  private readonly log?: BackgroundTriggerLogger;

  constructor(options: BackgroundTriggerEvaluatorOptions) {
    this.manifest = options.manifest;
    this.store = options.store;
    this.scheduleSelfInitiatedTurn = options.scheduleSelfInitiatedTurn;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
  }

  async handleStructuredWrite(event: StructuredWriteEvent): Promise<void> {
    for (const trigger of this.manifest.background_triggers ?? []) {
      if (
        trigger.fires_on.type !== "after_structured_upsert"
        || trigger.fires_on.record_type !== event.type
      ) {
        continue;
      }

      try {
        await this.evaluateTrigger(trigger, event);
      } catch (error) {
        incrementChatterBackgroundTriggerTotal(trigger.name, "error");
        this.log?.warn("chatter: background trigger evaluation failed", {
          trigger_name: trigger.name,
          record_type: event.type,
          record_key: event.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async evaluateTrigger(
    trigger: NonNullable<ChatterManifest["background_triggers"]>[number],
    event: StructuredWriteEvent
  ): Promise<void> {
    const nextState = this.store.incrementTriggerRecord(trigger.name);
    if (nextState.records_since_last_fire < trigger.throttle.min_records_since_last_fire) {
      this.log?.debug("chatter: background trigger below record threshold", {
        trigger_name: trigger.name,
        records_since_last_fire: nextState.records_since_last_fire
      });
      return;
    }

    const now = this.now();
    const minIntervalMs = parseBackgroundTriggerDurationMs(trigger.throttle.min_interval);
    if (!hasMinIntervalElapsed(nextState.last_fire_at, now, minIntervalMs)) {
      this.log?.debug("chatter: background trigger below interval threshold", {
        trigger_name: trigger.name,
        last_fire_at: nextState.last_fire_at
      });
      return;
    }

    await this.scheduleSelfInitiatedTurn({
      system_prompt_id: trigger.action.system_prompt_id,
      origin: "trigger",
      trigger_name: trigger.name,
      record_type: event.type,
      record_key: event.key,
      record: event.record
    });
    this.store.markTriggerFired(trigger.name, now.toISOString());
    incrementChatterBackgroundTriggerTotal(trigger.name, "scheduled");
  }
}

function hasMinIntervalElapsed(lastFireAt: string | null, now: Date, minIntervalMs: number): boolean {
  if (lastFireAt === null) {
    return true;
  }
  return now.getTime() - Date.parse(lastFireAt) >= minIntervalMs;
}
