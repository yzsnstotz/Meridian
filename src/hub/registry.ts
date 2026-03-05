import { createLogger } from "../logger";
import type { AgentInstance, AgentInstanceStatus } from "../types";

const hubLog = createLogger("hub");

export class InstanceRegistry {
  private readonly instances = new Map<string, AgentInstance>();

  register(instance: AgentInstance): void {
    this.instances.set(instance.thread_id, { ...instance });
    hubLog.info(
      {
        trace_id: null,
        thread_id: instance.thread_id,
        agent_type: instance.agent_type,
        status: instance.status
      },
      "Agent instance registered"
    );
  }

  unregister(threadId: string): AgentInstance | undefined {
    const existing = this.instances.get(threadId);
    if (!existing) {
      return undefined;
    }

    this.instances.delete(threadId);
    hubLog.info(
      {
        trace_id: null,
        thread_id: threadId,
        agent_type: existing.agent_type,
        status: existing.status
      },
      "Agent instance unregistered"
    );
    return { ...existing };
  }

  has(threadId: string): boolean {
    return this.instances.has(threadId);
  }

  get(threadId: string): AgentInstance | undefined {
    const instance = this.instances.get(threadId);
    return instance ? { ...instance } : undefined;
  }

  list(): AgentInstance[] {
    return Array.from(this.instances.values(), (instance) => ({ ...instance }));
  }

  setStatus(threadId: string, status: AgentInstanceStatus): AgentInstance | undefined {
    const existing = this.instances.get(threadId);
    if (!existing) {
      return undefined;
    }

    const updated: AgentInstance = {
      ...existing,
      status
    };
    this.instances.set(threadId, updated);
    return { ...updated };
  }

  clear(): void {
    this.instances.clear();
  }
}
