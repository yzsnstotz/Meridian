import { GUI_PORT } from "./config";
import { A2AClient } from "./a2a/client";
import { A2AServer } from "./a2a/server";
import { AgentDispatcherRole } from "./roles/definitions/agent-dispatcher";
import { DispatcherRole } from "./roles/definitions";
import { PromptStore } from "./roles/prompt-store";
import { RoleRegistry } from "./roles/role-registry";
import { RoleRunner } from "./roles/role-runner";
import { createPromptHandlers } from "./server/prompt-handlers";
import { HttpServer } from "./server/http-server";
import { createRoleHandlers } from "./server/role-handlers";
import { StateStore } from "./state-store";
import { shouldUseAgentDispatcherConfig } from "./types";

export * from "./types";
export * from "./config";

export interface MeridianRolesService {
  close(): Promise<void>;
}

export async function startMeridianRolesService(): Promise<MeridianRolesService> {
  const log = console;
  const stateStore = new StateStore();
  const client = new A2AClient({ log });
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: (message) => client.send(message),
    listInstances: () => client.listInstances(),
    log
  });
  const resultServer = new A2AServer((result) => runner.dispatch(result), { log });

  registry.register(
    "dispatcher",
    (threadId, config) => shouldUseAgentDispatcherConfig(config)
      ? new AgentDispatcherRole(threadId, config, { stateStore })
      : new DispatcherRole(threadId, config, { stateStore })
  );
  registry.register("agent-dispatcher", (threadId, config) => new AgentDispatcherRole(threadId, config, { stateStore }));

  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    log
  });
  const promptStore = new PromptStore({
    stateStore,
    resolveRole: roleHandlers.resolveRole
  });
  const promptHandlers = createPromptHandlers(promptStore);
  const httpServer = new HttpServer({
    port: GUI_PORT,
    roleHandlers,
    promptHandlers,
    log
  });

  await resultServer.listen();
  await httpServer.listen();
  void client.start().catch((error) => {
    if (error instanceof Error && error.message === "A2A client stopped before register_service completed") {
      return;
    }
    log.warn("A2A client background start failed", error);
  });

  return {
    async close(): Promise<void> {
      await Promise.allSettled([httpServer.close(), resultServer.close(), client.stop()]);
    }
  };
}

async function main(): Promise<void> {
  const service = await startMeridianRolesService();

  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
