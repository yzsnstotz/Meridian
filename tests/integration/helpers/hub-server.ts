import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

import type { ChannelAdapter } from "../../../src/hub/channel-adapter";
import { HubServer } from "../../../src/hub/server";
import { HubRouter } from "../../../src/hub/router";
import { InstanceManager } from "../../../src/hub/instance-manager";
import { InstanceRegistry } from "../../../src/hub/registry";
import { PaneBroadcaster } from "../../../src/hub/pane-broadcaster";
import { ResultSender } from "../../../src/hub/result-sender";
import { SocketChannelAdapter } from "../../../src/hub/socket-adapter";
import type { HubResult, ReplyChannel } from "../../../src/types";

const stubAgentapiPath = path.resolve(path.join(__dirname, "..", "..", "fixtures", "stub-agentapi.mjs"));

/** Telegram/Web no-op so tests never call external APIs; socket replies are delivered for A2A / meridian-roles. */
class NoOpTelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  canHandle(replyChannel: ReplyChannel): boolean {
    return replyChannel.channel === "telegram";
  }
  async send(_result: HubResult, _replyChannel: ReplyChannel): Promise<void> {}
}

class NoOpWebAdapter implements ChannelAdapter {
  readonly channel = "web" as const;
  canHandle(replyChannel: ReplyChannel): boolean {
    return replyChannel.channel === "web";
  }
  async send(_result: HubResult, _replyChannel: ReplyChannel): Promise<void> {}
}

export interface IntegrationHubContext {
  hubSocketPath: string;
  tempDir: string;
  hubServer: HubServer;
  cleanup: () => Promise<void>;
}

/**
 * Start a HubServer with a temp Unix socket and stub agentapi for integration tests.
 * Call setIntegrationTestEnv() before importing modules that use config.
 */
export async function startIntegrationHub(): Promise<IntegrationHubContext> {
  const tempDir = fs.mkdtempSync(path.join(path.sep, "tmp", "meridian-int-"));
  const hubSocketPath = path.join(tempDir, "hub.sock");
  const statePath = path.join(tempDir, "state.json");
  const logDir = path.join(tempDir, "log");

  fs.mkdirSync(logDir, { recursive: true });

  const socketPathFactory = (threadId: string) => path.join(tempDir, `agentapi-${threadId}.sock`);
  const registry = new InstanceRegistry();

  const spawnFn = (command: string, args: string[], options: object) => {
    return nodeSpawn(process.execPath, [stubAgentapiPath, ...args], options);
  };

  const instanceManager = new InstanceManager(registry, {
    agentapiBinPath: stubAgentapiPath,
    logDir,
    socketPathFactory,
    spawnFn,
    agentapiSocketSupport: true,
    agentapiAttachSocketSupport: false
  });

  const router = new HubRouter(registry, {
    instanceManager,
    statePath
  });

  const hubServer = new HubServer({
    socketPath: hubSocketPath,
    router,
    resultSender: new ResultSender([new SocketChannelAdapter(), new NoOpTelegramAdapter(), new NoOpWebAdapter()]),
    paneBroadcaster: new PaneBroadcaster({ logDir }),
    staticServiceEndpoints: []
  });

  await hubServer.start();

  async function cleanup(): Promise<void> {
    await hubServer.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { hubSocketPath, tempDir, hubServer, cleanup };
}
