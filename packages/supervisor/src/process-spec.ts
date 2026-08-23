import path from "node:path";

export type ManagedProcessId = "runtime" | "orchestrator";

export interface ManagedProcessSpec {
  id: ManagedProcessId;
  providerId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  readinessUrl: string;
  declarationPath: string;
  restartLimit: number;
  readinessTimeoutMs: number;
  readinessIntervalMs: number;
}

export interface DefaultProcessSpecOptions {
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  nodeExecutable?: string;
}

/**
 * Builds the two Meridian product processes. Gateway is intentionally absent:
 * it is an independently installable ingress product, not a prerequisite for
 * native Runtime or Orchestrator lifecycle.
 */
export function createDefaultProcessSpecs(
  options: DefaultProcessSpecOptions = {}
): ManagedProcessSpec[] {
  const env = { ...(options.env ?? process.env) };
  const workspaceRoot = options.workspaceRoot ?? path.resolve(__dirname, "../../..");
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const runtimePort = parsePort(env.WEB_GUI_PORT, 3000);
  const orchestratorPort = parsePort(env.GUI_PORT, 7701);

  return [
    {
      id: "runtime",
      providerId: "org.meridian/runtime",
      command: nodeExecutable,
      args: [path.join(workspaceRoot, "packages/runtime/dist/supervised.js")],
      cwd: workspaceRoot,
      env: {
        ...env,
        WEB_GUI_ENABLED: "true",
        WEB_GUI_HOST: env.WEB_GUI_HOST?.trim() || "127.0.0.1",
        WEB_GUI_PORT: String(runtimePort)
      },
      readinessUrl: `http://127.0.0.1:${runtimePort}/api/health`,
      declarationPath: path.join(workspaceRoot, "packages/runtime/service.json"),
      restartLimit: 3,
      readinessTimeoutMs: 15_000,
      readinessIntervalMs: 250
    },
    {
      id: "orchestrator",
      providerId: "org.meridian/orchestrator",
      command: nodeExecutable,
      args: [path.join(workspaceRoot, "packages/orchestrator/dist/index.js")],
      cwd: workspaceRoot,
      env: {
        ...env,
        GUI_LISTEN_HOST: env.GUI_LISTEN_HOST?.trim() || "127.0.0.1",
        GUI_PORT: String(orchestratorPort)
      },
      readinessUrl: `http://127.0.0.1:${orchestratorPort}/api/health`,
      declarationPath: path.join(workspaceRoot, "packages/orchestrator/service.json"),
      restartLimit: 3,
      readinessTimeoutMs: 15_000,
      readinessIntervalMs: 250
    }
  ];
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`invalid Meridian service port: ${value}`);
  }
  return parsed;
}
