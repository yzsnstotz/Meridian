import { randomUUID } from "node:crypto";

import {
  SchedulerConfigSchema,
  AppStateSchema,
  type SchedulerConfig,
  type AppState
} from "../../types";
import { StateStore } from "../../state-store";
import type { BaseRole, RoleContext } from "../base-role";
import { SchedulerEngine, type SchedulerEngineCallbacks } from "../scheduler/scheduler-engine";
import { SchedulerStateStore } from "../scheduler/scheduler-state-store";
import { createMeridianApiClient, type MeridianApiClient } from "../agent-dispatcher/meridian-api-client";
import {
  resolveConfiguredDispatchRepoRoot,
  resolveConfiguredDocsRoot
} from "../agent-dispatcher/dispatch-paths";
import { launchDispatcher, type LaunchConfig } from "../agent-dispatcher/launcher";
import {
  buildSystemPrompt,
  type PromptVars
} from "../agent-dispatcher/prompt-builder";

type PersistableStateStore = Pick<StateStore, "load" | "save">;

const EMPTY_APP_STATE: AppState = {
  roles: [],
  promptStore: {}
};

export interface SchedulerRoleOptions {
  stateStore?: PersistableStateStore;
  meridianApi?: MeridianApiClient;
  launchDispatcher?: (config: LaunchConfig) => Promise<{ ok: boolean; threadId: string; error?: string }>;
  continueWorker?: SchedulerEngineCallbacks["continueWorker"];
}

export class SchedulerRole implements BaseRole {
  readonly roleType = "scheduler" as const;
  readonly threadId: string;
  readonly config: SchedulerConfig;

  private readonly stateStore: PersistableStateStore;
  private readonly meridianApi: MeridianApiClient;
  private readonly launch: (config: LaunchConfig) => Promise<{ ok: boolean; threadId: string; error?: string }>;
  private readonly continueWorkerCallback: SchedulerEngineCallbacks["continueWorker"] | undefined;

  private ctx: RoleContext | null = null;
  private engine: SchedulerEngine | null = null;
  private schedulerStateStore: SchedulerStateStore | null = null;

  constructor(threadId: string, config: unknown, options: SchedulerRoleOptions = {}) {
    this.threadId = threadId;
    this.config = SchedulerConfigSchema.parse(config);
    this.stateStore = options.stateStore ?? new StateStore();
    this.meridianApi = options.meridianApi ?? createMeridianApiClient();
    this.launch = options.launchDispatcher ?? launchDispatcher;
    this.continueWorkerCallback = options.continueWorker;
  }

  async onActivate(ctx: RoleContext): Promise<void> {
    this.ctx = ctx;
    this.schedulerStateStore = new SchedulerStateStore(this.config.dispatch_plan_path);

    const callbacks: SchedulerEngineCallbacks = {
      launchDispatcher: (config) => this.launchChildDispatcher(config),
      killDispatcher: async (threadId) => { await this.meridianApi.kill(threadId); },
      notifyChannels: (config, message) => this.notifyChannels(config, message),
      continueWorker: this.continueWorkerCallback
    };

    this.engine = new SchedulerEngine({
      schedulerThreadId: this.threadId,
      config: this.config,
      stateStore: this.schedulerStateStore,
      callbacks,
      log: ctx.log
    });

    await this.persistState("active");
    this.engine.start();
  }

  async onDeactivate(): Promise<void> {
    if (this.engine) {
      this.engine.stop();
      this.engine = null;
    }

    await this.removePersistedRole().catch(() => {});
    this.schedulerStateStore = null;
    this.ctx = null;
  }

  async onInboundResult(): Promise<void> {
    // Scheduler does not handle inbound results directly
  }

  async onStatusChange(threadId: string, status: string): Promise<void> {
    if (threadId !== this.threadId) return;

    if (status === "paused") {
      this.engine?.pause();
      await this.persistState("paused");
    } else if (status === "active") {
      this.engine?.resume();
      await this.persistState("active");
    }
  }

  // ─── Public API for handlers ──────────────────────────────────────────────

  getEngine(): SchedulerEngine | null {
    return this.engine;
  }

  getSchedulerStateStore(): SchedulerStateStore | null {
    return this.schedulerStateStore;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async launchChildDispatcher(config: SchedulerConfig): Promise<string> {
    const systemPrompt = buildSystemPrompt({
      dispatch_plan_path: config.dispatch_plan_path,
      command_file_path: config.command_file_path,
      dispatcher_role_id: this.threadId,
      dispatch_repo_root: resolveConfiguredDispatchRepoRoot(config),
      docs_root: resolveConfiguredDocsRoot(config),
      user_reply_channels: JSON.stringify(config.user_reply_channels),
      default_agent_type: config.agent_type,
      default_mode: config.mode,
      kill_policy: config.kill_policy,
      auto_approve: config.auto_approve,
      resolved_model_map_json: JSON.stringify(config.model_map ?? {}),
      pm_resolver_config_json: JSON.stringify(config.pm_resolver)
    } as PromptVars);

    const result = await this.launch({
      agentType: config.agent_type,
      modelId: config.model_id,
      mode: config.mode,
      autoApprove: config.auto_approve,
      systemPrompt,
      dispatchRepoRoot: resolveConfiguredDispatchRepoRoot(config),
      dispatchPlanPath: config.dispatch_plan_path,
      commandFilePath: config.command_file_path,
      dispatcherRoleId: this.threadId,
      userReplyChannel: config.user_reply_channels[0]!
    });

    if (!result.ok || !result.threadId.trim()) {
      throw new Error(result.error ?? "Failed to launch child dispatcher");
    }

    return result.threadId;
  }

  private async notifyChannels(config: SchedulerConfig, message: string): Promise<void> {
    const primaryChannel = config.user_reply_channels[0];
    if (!primaryChannel || !this.ctx) return;

    try {
      await this.ctx.sendToHub({
        trace_id: randomUUID(),
        thread_id: this.threadId,
        actor_id: "service:meridian-roles",
        intent: "run",
        target: this.threadId,
        priority: 3,
        mode: "bridge",
        reply_channel: primaryChannel,
        payload: {
          content: message,
          attachments: []
        }
      });
    } catch (error) {
      this.ctx?.log.warn("Scheduler notification failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async persistState(status: string): Promise<void> {
    const currentState = AppStateSchema.parse(
      (await this.stateStore.load()) ?? EMPTY_APP_STATE
    );
    const roles = currentState.roles.filter((role) => role.threadId !== this.threadId);

    roles.push({
      threadId: this.threadId,
      roleType: this.roleType,
      config: this.config,
      status
    });

    await this.stateStore.save({
      roles,
      promptStore: currentState.promptStore
    });
  }

  private async removePersistedRole(): Promise<void> {
    const currentState = await this.stateStore.load();
    if (!currentState) return;

    const nextRoles = currentState.roles.filter((role) => role.threadId !== this.threadId);
    if (nextRoles.length === currentState.roles.length) return;

    await this.stateStore.save({
      roles: nextRoles,
      promptStore: currentState.promptStore
    });
  }
}
