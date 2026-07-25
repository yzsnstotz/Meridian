import path from "node:path";

import { PathResolver } from "@meridian/contracts";

import {
  ensureSharedBootstrapKey,
  ensureWebGuiToken,
  loadSupervisorEnvironment
} from "./environment";
import { createDefaultProcessSpecs } from "./process-spec";
import { NodeSupervisorAdapter } from "./node-adapter";
import { JsonSupervisorStateStore, MeridianSupervisor } from "./supervisor";

async function main(): Promise<void> {
  const resolver = new PathResolver();
  const paths = resolver.resolve();
  resolver.ensurePrivateDirectories(paths);
  loadSupervisorEnvironment(paths.configDir);
  ensureSharedBootstrapKey(paths.configDir);
  ensureWebGuiToken(paths.configDir);
  const stateStore = new JsonSupervisorStateStore(path.join(paths.stateDir, "supervisor.json"));
  const previous = stateStore.load();
  if (previous && processAlive(previous.supervisorPid)) {
    throw new Error(`Meridian supervisor is already running as PID ${previous.supervisorPid}`);
  }

  const supervisor = new MeridianSupervisor({
    specs: createDefaultProcessSpecs(),
    adapter: new NodeSupervisorAdapter({
      declarationDir: paths.serviceDeclarationDir,
      descriptorDir: paths.runtimeDescriptorDir,
      logDir: paths.logDir
    }),
    stateStore
  });

  let stopping = false;
  let renewal: NodeJS.Timeout | undefined;
  const shutdown = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (renewal) {
      clearInterval(renewal);
    }
    await supervisor.stop();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await supervisor.start();
  renewal = setInterval(() => supervisor.renewRegistrations(), 20_000);
  renewal.unref();
  await new Promise<void>(() => {});
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
