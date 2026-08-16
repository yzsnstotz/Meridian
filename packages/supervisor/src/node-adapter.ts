import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  RuntimeServiceRegistration,
  ServiceDeclarationSchema,
  type RuntimeInstanceDescriptor
} from "@meridian/contracts";

import type { ManagedProcessSpec } from "./process-spec";
import type {
  ChildProcessHandle,
  ServiceRegistrationHandle,
  SupervisorAdapter
} from "./supervisor";

export interface NodeSupervisorAdapterOptions {
  declarationDir: string;
  descriptorDir: string;
  logDir: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

class NodeChildHandle implements ChildProcessHandle {
  readonly pid: number;

  constructor(private readonly child: childProcess.ChildProcess) {
    if (!child.pid) {
      throw new Error("spawned child did not expose a PID");
    }
    this.pid = child.pid;
  }

  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.once("exit", listener);
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (isProcessAlive(this.pid)) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, 5_000);
      timeout.unref();
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}

export class NodeSupervisorAdapter implements SupervisorAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: NodeSupervisorAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async spawn(spec: ManagedProcessSpec): Promise<ChildProcessHandle> {
    fs.mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(this.options.logDir, `${spec.id}.log`);
    const logFd = fs.openSync(logPath, "a", 0o600);
    try {
      const child = childProcess.spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", logFd, logFd]
      });
      return new NodeChildHandle(child);
    } finally {
      fs.closeSync(logFd);
    }
  }

  async waitUntilReady(spec: ManagedProcessSpec, child: ChildProcessHandle): Promise<boolean> {
    const deadline = Date.now() + spec.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(child.pid)) {
        return false;
      }
      try {
        const headers = new Headers();
        const token = spec.id === "runtime" ? spec.env.WEB_GUI_TOKEN?.trim() : undefined;
        if (token) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const response = await this.fetchImpl(spec.readinessUrl, {
          headers,
          signal: AbortSignal.timeout(Math.min(1_000, spec.readinessIntervalMs * 3))
        });
        if (response.status >= 200 && response.status < 300) {
          return true;
        }
      } catch {
        // Expected during startup; retry until the bounded deadline.
      }
      await this.sleep(spec.readinessIntervalMs);
    }
    return false;
  }

  register(
    spec: ManagedProcessSpec,
    pid: number,
    instanceId: string
  ): ServiceRegistrationHandle {
    const declaration = ServiceDeclarationSchema.parse(
      JSON.parse(fs.readFileSync(spec.declarationPath, "utf8"))
    );
    const registration = new RuntimeServiceRegistration({
      declaration,
      declarationDir: this.options.declarationDir,
      descriptorDir: this.options.descriptorDir,
      instanceId,
      pid,
      transports: [{
        kind: "http",
        endpoint: spec.readinessUrl.replace(/\/api\/health$/, ""),
        features: ["streaming", "cancellation", "provider_acknowledgement"]
      }]
    });
    return {
      publish(health: "ready" | "degraded" | "unhealthy"): void {
        registration.publish(health as RuntimeInstanceDescriptor["health"]["state"]);
      },
      unregister(): void {
        registration.unregister();
      }
    };
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
