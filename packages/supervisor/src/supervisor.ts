import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ManagedProcessId, ManagedProcessSpec } from "./process-spec";

export type ManagedProcessStatus =
  | "starting"
  | "ready"
  | "degraded"
  | "failed"
  | "stopping"
  | "stopped";

export interface ManagedProcessSnapshot {
  id: ManagedProcessId;
  providerId: string;
  instanceId: string;
  pid: number;
  status: ManagedProcessStatus;
  restartCount: number;
  startedAt: string;
  updatedAt: string;
  readinessUrl: string;
  message?: string;
}

export interface SupervisorSnapshot {
  schemaVersion: "1";
  supervisorPid: number;
  generation: number;
  startedAt: string;
  updatedAt: string;
  stopping: boolean;
  children: Partial<Record<ManagedProcessId, ManagedProcessSnapshot>>;
}

export interface SupervisorStateStore {
  load(): SupervisorSnapshot | null;
  save(snapshot: SupervisorSnapshot): void;
}

export interface ChildProcessHandle {
  readonly pid: number;
  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
  terminate(): Promise<void>;
}

export interface ServiceRegistrationHandle {
  publish(health: "ready" | "degraded" | "unhealthy"): void;
  unregister(): void;
}

export interface SupervisorAdapter {
  spawn(spec: ManagedProcessSpec): Promise<ChildProcessHandle>;
  waitUntilReady(spec: ManagedProcessSpec, child: ChildProcessHandle): Promise<boolean>;
  register(
    spec: ManagedProcessSpec,
    pid: number,
    instanceId: string
  ): ServiceRegistrationHandle;
}

export interface MeridianSupervisorOptions {
  specs: ManagedProcessSpec[];
  adapter: SupervisorAdapter;
  stateStore: SupervisorStateStore;
  randomId?: () => string;
  now?: () => Date;
  supervisorPid?: number;
}

interface LiveChild {
  child: ChildProcessHandle;
  registration?: ServiceRegistrationHandle;
}

/**
 * Owns process execution only. Provider state and Run Graph data stay in each
 * provider's durable state directory; the supervisor never copies or rewrites
 * them. Every child process lifetime gets a fresh instanceId while providerId
 * remains stable.
 */
export class MeridianSupervisor {
  private readonly specs: ManagedProcessSpec[];
  private readonly adapter: SupervisorAdapter;
  private readonly stateStore: SupervisorStateStore;
  private readonly randomId: () => string;
  private readonly now: () => Date;
  private readonly supervisorPid: number;
  private readonly live = new Map<ManagedProcessId, LiveChild>();
  private snapshot: SupervisorSnapshot;
  private stopping = false;

  constructor(options: MeridianSupervisorOptions) {
    this.specs = [...options.specs];
    this.assertValidSpecs();
    this.adapter = options.adapter;
    this.stateStore = options.stateStore;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
    this.supervisorPid = options.supervisorPid ?? process.pid;
    const previous = this.stateStore.load();
    const timestamp = this.now().toISOString();
    this.snapshot = {
      schemaVersion: "1",
      supervisorPid: this.supervisorPid,
      generation: (previous?.generation ?? 0) + 1,
      startedAt: timestamp,
      updatedAt: timestamp,
      stopping: false,
      children: {}
    };
  }

  async start(): Promise<SupervisorSnapshot> {
    this.stopping = false;
    this.snapshot.stopping = false;
    this.persist();
    for (const spec of this.specs) {
      await this.startWithRetries(spec, 0);
    }
    return this.currentSnapshot();
  }

  async stop(): Promise<SupervisorSnapshot> {
    this.stopping = true;
    this.snapshot.stopping = true;
    this.persist();

    await Promise.all(this.specs.map(async (spec) => {
      const live = this.live.get(spec.id);
      const current = this.snapshot.children[spec.id];
      if (!live || !current) {
        return;
      }
      this.updateChild(spec.id, { status: "stopping" });
      live.registration?.unregister();
      live.registration = undefined;
      await live.child.terminate();
      this.live.delete(spec.id);
      this.updateChild(spec.id, { status: "stopped" });
    }));

    return this.currentSnapshot();
  }

  currentSnapshot(): SupervisorSnapshot {
    return structuredClone(this.snapshot);
  }

  renewRegistrations(): void {
    for (const [id, live] of this.live) {
      if (this.snapshot.children[id]?.status === "ready") {
        live.registration?.publish("ready");
      }
    }
  }

  private async startWithRetries(spec: ManagedProcessSpec, initialRestartCount: number): Promise<void> {
    let restartCount = initialRestartCount;
    while (!this.stopping) {
      const instanceId = this.randomId();
      const child = await this.adapter.spawn(spec);
      const timestamp = this.now().toISOString();
      this.live.set(spec.id, { child });
      this.snapshot.children[spec.id] = {
        id: spec.id,
        providerId: spec.providerId,
        instanceId,
        pid: child.pid,
        status: "starting",
        restartCount,
        startedAt: timestamp,
        updatedAt: timestamp,
        readinessUrl: spec.readinessUrl
      };
      this.persist();

      const ready = await this.adapter.waitUntilReady(spec, child);
      if (ready && !this.stopping) {
        const registration = this.adapter.register(spec, child.pid, instanceId);
        registration.publish("ready");
        this.live.set(spec.id, { child, registration });
        this.updateChild(spec.id, { status: "ready", message: undefined });
        child.onExit((exitCode, signal) => {
          void this.handleUnexpectedExit(spec, child, exitCode, signal);
        });
        return;
      }

      await child.terminate();
      this.live.delete(spec.id);
      if (restartCount >= spec.restartLimit) {
        this.updateChild(spec.id, {
          status: "failed",
          message: `readiness failed after ${restartCount + 1} attempt(s)`
        });
        return;
      }
      restartCount += 1;
    }
  }

  private async handleUnexpectedExit(
    spec: ManagedProcessSpec,
    child: ChildProcessHandle,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    if (this.stopping || this.live.get(spec.id)?.child !== child) {
      return;
    }
    const previous = this.snapshot.children[spec.id];
    const live = this.live.get(spec.id);
    live?.registration?.unregister();
    this.live.delete(spec.id);
    const restartCount = previous?.restartCount ?? 0;
    if (restartCount >= spec.restartLimit) {
      this.updateChild(spec.id, {
        status: "failed",
        message: `process exited (${exitCode ?? signal ?? "unknown"}); restart limit exhausted`
      });
      return;
    }
    this.updateChild(spec.id, {
      status: "degraded",
      message: `process exited (${exitCode ?? signal ?? "unknown"}); restarting`
    });
    await this.startWithRetries(spec, restartCount + 1);
  }

  private updateChild(
    id: ManagedProcessId,
    update: Partial<Pick<ManagedProcessSnapshot, "status" | "message">>
  ): void {
    const child = this.snapshot.children[id];
    if (!child) {
      return;
    }
    const next = { ...child, ...update, updatedAt: this.now().toISOString() };
    if (update.message === undefined) {
      delete next.message;
    }
    this.snapshot.children[id] = next;
    this.persist();
  }

  private persist(): void {
    this.snapshot.updatedAt = this.now().toISOString();
    this.stateStore.save(this.snapshot);
  }

  private assertValidSpecs(): void {
    const seen = new Set<ManagedProcessId>();
    for (const spec of this.specs) {
      if (spec.id === ("gateway" as ManagedProcessId)) {
        throw new Error("Gateway cannot be managed by the Meridian supervisor");
      }
      if (seen.has(spec.id)) {
        throw new Error(`duplicate managed process: ${spec.id}`);
      }
      seen.add(spec.id);
    }
  }
}

export class JsonSupervisorStateStore implements SupervisorStateStore {
  constructor(readonly filePath: string) {}

  load(): SupervisorSnapshot | null {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SupervisorSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  save(snapshot: SupervisorSnapshot): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      fs.chmodSync(path.dirname(this.filePath), 0o700);
    }
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    if (process.platform !== "win32") {
      fs.chmodSync(this.filePath, 0o600);
    }
  }
}
