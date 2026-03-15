import { randomUUID } from "node:crypto";

import { config } from "../config";
import { sendIpcRequest } from "../shared/ipc";
import { AgentInstanceSchema, type AgentInstance, type HubMessage, type HubResult } from "../types";
import { MonitorIpcReporter } from "./ipc-reporter";
import { getMonitorLogger } from "./logger";
import { MonitorManager } from "./monitor";

const monitorLog = getMonitorLogger();

export function createMonitorManager(): MonitorManager {
  const reporter = new MonitorIpcReporter({
    socketPath: config.HUB_SOCKET_PATH
  });

  return new MonitorManager({
    reporter,
    heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
    heartbeatMissedThreshold: config.HEARTBEAT_MISSED_THRESHOLD
  });
}

function buildListRequestMessage(): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: "global",
    actor_id: "monitor",
    intent: "list",
    target: "all",
    payload: {
      content: "",
      attachments: [],
      reply_to: null
    },
    mode: "bridge",
    suppress_reply: true,
    reply_channel: {
      channel: "socket",
      chat_id: "monitor",
      socket_path: config.HUB_SOCKET_PATH
    }
  };
}

async function fetchInstancesFromHub(): Promise<AgentInstance[]> {
  const response = await sendIpcRequest<HubMessage, HubResult>(
    config.HUB_SOCKET_PATH,
    buildListRequestMessage()
  );

  if (response.status !== "success") {
    throw new Error(`Hub list request failed: ${response.content}`);
  }
  if (response.content.includes("No active agent instances.")) {
    return [];
  }

  const parsed = JSON.parse(response.content) as unknown;
  return AgentInstanceSchema.array().parse(parsed);
}

function syncMonitorRegistrations(
  manager: MonitorManager,
  knownThreads: Map<string, AgentInstance>,
  instances: AgentInstance[]
): void {
  const nextThreads = new Map<string, AgentInstance>();
  for (const instance of instances) {
    nextThreads.set(instance.thread_id, instance);
  }

  for (const [threadId, existingInstance] of knownThreads.entries()) {
    const next = nextThreads.get(threadId);
    if (!next) {
      manager.unregister(threadId);
      knownThreads.delete(threadId);
      continue;
    }

    if (
      next.socket_path !== existingInstance.socket_path ||
      next.status !== existingInstance.status ||
      next.pid !== existingInstance.pid
    ) {
      manager.register(next);
      knownThreads.set(threadId, next);
    }
  }

  for (const [threadId, instance] of nextThreads.entries()) {
    if (knownThreads.has(threadId)) {
      continue;
    }
    manager.register(instance);
    knownThreads.set(threadId, instance);
  }
}

export async function startMonitorService(): Promise<void> {
  const manager = createMonitorManager();
  const keepAlive = setInterval(() => undefined, 60_000);
  const knownThreads = new Map<string, AgentInstance>();

  const syncFromHub = async (): Promise<void> => {
    try {
      const instances = await fetchInstancesFromHub();
      syncMonitorRegistrations(manager, knownThreads, instances);
    } catch (error) {
      monitorLog.warn(
        {
          trace_id: null,
          thread_id: null,
          hub_socket_path: config.HUB_SOCKET_PATH,
          err: error instanceof Error ? error.message : String(error)
        },
        "Failed to sync monitor tasks from hub"
      );
    }
  };

  const syncTimer = setInterval(() => {
    void syncFromHub();
  }, config.MONITOR_SYNC_INTERVAL_MS);
  void syncFromHub();

  const shutdown = (signal: NodeJS.Signals): void => {
    clearInterval(syncTimer);
    clearInterval(keepAlive);
    manager.shutdown();
    monitorLog.info({ trace_id: null, thread_id: null, signal }, "Monitor service stopped");
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  monitorLog.info(
    {
      trace_id: null,
      thread_id: null,
      monitor_sync_interval_ms: config.MONITOR_SYNC_INTERVAL_MS,
      heartbeat_interval_ms: config.HEARTBEAT_INTERVAL_MS,
      heartbeat_missed_threshold: config.HEARTBEAT_MISSED_THRESHOLD
    },
    "Monitor service started"
  );
}

if (require.main === module) {
  void startMonitorService();
}
