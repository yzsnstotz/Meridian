#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AgentTypeSchema,
  ReasoningEffortSchema,
  type AgentType,
  type BridgeMode,
  type HubMessage,
  type HubResult,
  type ReasoningEffort
} from "../types";
import { connectToHub, hubHttpRequest, hubSocketRequest, type HubConnection, type HubHttpResponse } from "./hub-connection";

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_INVALID_ARGS = 2;
const EXIT_UNREACHABLE = 3;
const EXIT_NOT_FOUND = 4;
const DEFAULT_SOCKET_PATH = process.env.MERIDIAN_SOCKET ?? "/tmp/hub-core.sock";
const PACKAGE_VERSION = readPackageVersion();

const COMMANDS: Record<string, string> = {
  spawn: "Launch an agent instance",
  kill: "Terminate an agent thread",
  status: "List running agent instances",
  send: "Send a message to an agent thread",
  logs: "Retrieve agent output logs",
  autoapprove: "Get or set auto-approve state",
  health: "Check Meridian hub health"
};

type WriteFn = (text: string) => void;

type ParsedArgs = {
  options: Map<string, string | boolean>;
  positionals: string[];
};

type JsonRecord = Record<string, unknown>;

export interface CliDependencies {
  connectToHub: () => Promise<HubConnection>;
  hubHttpRequest: (method: string, route: string, body?: unknown) => Promise<HubHttpResponse>;
  hubSocketRequest: (message: HubMessage) => Promise<HubResult>;
  inferSocketUptimeSeconds: (socketPath: string) => Promise<number>;
  packageVersion: string;
  socketPath: string;
  now: () => Date;
  stdout: WriteFn;
  stderr: WriteFn;
}

class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string
  ) {
    super(message);
  }
}

export const defaultCliDependencies: CliDependencies = {
  connectToHub,
  hubHttpRequest,
  hubSocketRequest,
  inferSocketUptimeSeconds,
  packageVersion: PACKAGE_VERSION,
  socketPath: DEFAULT_SOCKET_PATH,
  now: () => new Date(),
  stdout: (text: string) => {
    process.stdout.write(text);
  },
  stderr: (text: string) => {
    process.stderr.write(text);
  }
};

function readPackageVersion(): string {
  try {
    const packagePath = path.resolve(__dirname, "../../package.json");
    const raw = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function inferSocketUptimeSeconds(socketPath: string): Promise<number> {
  try {
    const stats = await fs.promises.stat(socketPath);
    const startedAtMs = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
    return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  } catch {
    return 0;
  }
}

function jsonOut(deps: CliDependencies, data: JsonRecord): void {
  deps.stdout(`${JSON.stringify(data, null, 2)}\n`);
}

function hint(deps: CliDependencies, message: string): void {
  deps.stderr(`${message}\n`);
}

function showHelp(deps: CliDependencies): void {
  hint(deps, "Usage: meridian <command> [options]\n");
  hint(deps, "Commands:");
  for (const [command, description] of Object.entries(COMMANDS)) {
    hint(deps, `  ${command.padEnd(14)} ${description}`);
  }
  hint(deps, "\nOptions:");
  hint(deps, "  --help       Show help for a command");
  hint(deps, "  --json       (default) JSON output on stdout");
  hint(deps, "\nExit codes:");
  hint(deps, "  0  Success");
  hint(deps, "  1  General error");
  hint(deps, "  2  Invalid arguments");
  hint(deps, "  3  Service unreachable");
  hint(deps, "  4  Target not found");
}

function showCommandHelp(deps: CliDependencies, command: string): void {
  switch (command) {
    case "spawn":
      hint(deps, "Usage: meridian spawn [agent-type] [options]");
      hint(deps, "");
      hint(deps, "Options:");
      hint(deps, "  --provider <claude|codex|gemini|cursor>  Provider alias for agent type");
      hint(deps, "  --model <model-id>                        Explicit provider model id");
      hint(deps, "  --effort <low|medium|high|xhigh>         Codex reasoning effort override");
      hint(deps, "  --workdir <path>                          Agent working directory");
      hint(deps, "  --auto-approve                            Enable auto-approve (default)");
      hint(deps, "  --no-auto-approve                         Disable auto-approve");
      hint(deps, "  --mode <bridge|pane_bridge|a2a|agentapi>  Spawn transport mode");
      return;
    case "kill":
      hint(deps, "Usage: meridian kill <thread-id>");
      return;
    case "status":
      hint(deps, "Usage: meridian status");
      return;
    case "send":
      hint(deps, "Usage: meridian send <thread-id> <message>");
      return;
    case "logs":
      hint(deps, "Usage: meridian logs <thread-id>");
      return;
    case "autoapprove":
      hint(deps, "Usage: meridian autoapprove <on|off|status> [--thread <id>]");
      return;
    case "health":
      hint(deps, "Usage: meridian health");
      return;
    default:
      hint(deps, `Unknown command: ${command}`);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const options = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("--no-")) {
      options.set(arg.slice(5), false);
      continue;
    }

    const option = arg.slice(2);
    const equalsIndex = option.indexOf("=");
    if (equalsIndex >= 0) {
      const key = option.slice(0, equalsIndex);
      const value = option.slice(equalsIndex + 1);
      options.set(key, value);
      continue;
    }

    const nextArg = args[index + 1];
    if (nextArg && !nextArg.startsWith("--")) {
      options.set(option, nextArg);
      index += 1;
      continue;
    }

    options.set(option, true);
  }

  return { options, positionals };
}

function expectStringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new CliError(EXIT_INVALID_ARGS, `Option --${name} requires a value`);
  }
  return value.trim();
}

function expectBooleanOption(parsed: ParsedArgs, name: string): boolean | undefined {
  const value = parsed.options.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new CliError(EXIT_INVALID_ARGS, `Option --${name} does not accept a value`);
  }
  return value;
}

function parseProvider(raw: string | undefined): AgentType {
  const candidate = (raw ?? "claude").trim().toLowerCase();
  const parsed = AgentTypeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CliError(EXIT_INVALID_ARGS, `Unsupported provider: ${raw ?? ""}`);
  }
  return parsed.data;
}

function parseMode(raw: string | undefined): BridgeMode {
  if (!raw) {
    return "bridge";
  }

  switch (raw.trim().toLowerCase()) {
    case "bridge":
    case "a2a":
    case "agentapi":
      return "bridge";
    case "pane_bridge":
    case "pane-bridge":
      return "pane_bridge";
    default:
      throw new CliError(EXIT_INVALID_ARGS, `Unsupported mode: ${raw}`);
  }
}

function parseReasoningEffort(raw: string | undefined): ReasoningEffort | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new CliError(EXIT_INVALID_ARGS, "Option --effort requires a value");
  }

  const parsed = ReasoningEffortSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new CliError(EXIT_INVALID_ARGS, `Unsupported reasoning effort: ${raw}`);
  }

  return parsed.data;
}

function secondsSince(iso: string | null | undefined, now: Date): number {
  if (!iso) {
    return 0;
  }
  const startedAt = Date.parse(iso);
  if (!Number.isFinite(startedAt)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - startedAt) / 1000));
}

function buildSocketMessage(
  deps: CliDependencies,
  params: {
    intent: HubMessage["intent"];
    threadId: string;
    target: string;
    content?: string;
    mode?: BridgeMode;
    autoApprove?: boolean;
    spawnDir?: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
  }
): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: params.threadId,
    actor_id: "meridian-cli",
    intent: params.intent,
    target: params.target,
    payload: {
      content: params.content ?? "",
      attachments: [],
      reply_to: null,
      ...(params.autoApprove !== undefined && { auto_approve: params.autoApprove }),
      ...(params.spawnDir && { spawn_dir: params.spawnDir }),
      ...(params.modelId && { model_id: params.modelId }),
      ...(params.reasoningEffort && { effort: params.reasoningEffort })
    },
    mode: params.mode ?? "bridge",
    suppress_reply: true,
    reply_channel: {
      channel: "socket",
      chat_id: `meridian-cli-${process.pid}`,
      socket_path: deps.socketPath
    }
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function inferExitCode(message: string): number {
  const lower = message.toLowerCase();
  if (
    lower.includes("econnrefused") ||
    lower.includes("enoent") ||
    lower.includes("not reachable") ||
    lower.includes("timed out") ||
    lower.includes("ipc request") ||
    lower.includes("ipc send")
  ) {
    return EXIT_UNREACHABLE;
  }
  if (
    lower.includes("no active instance") ||
    lower.includes("no active agent") ||
    lower.includes("no registered agent instance found") ||
    lower.includes("not found")
  ) {
    return EXIT_NOT_FOUND;
  }
  return EXIT_ERROR;
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  const message = normalizeErrorMessage(error);
  return new CliError(inferExitCode(message), message);
}

async function requestSocket(deps: CliDependencies, message: HubMessage): Promise<HubResult> {
  try {
    return await deps.hubSocketRequest(message);
  } catch (error) {
    throw toCliError(error);
  }
}

function assertHubSuccess(result: HubResult, okStatuses: HubResult["status"][] = ["success"]): HubResult {
  if (!okStatuses.includes(result.status)) {
    throw new CliError(inferExitCode(result.content), result.content || "Hub request failed");
  }
  return result;
}

function parseJsonArray(content: string, fallbackLabel: string): Array<Record<string, unknown>> {
  const normalized = content.trim();
  if (!normalized || normalized === fallbackLabel) {
    return [];
  }
  const parsed = JSON.parse(normalized) as unknown;
  if (!Array.isArray(parsed)) {
    throw new CliError(EXIT_ERROR, "Hub returned an unexpected payload");
  }
  return parsed.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

async function listInstances(deps: CliDependencies): Promise<Array<Record<string, unknown>>> {
  const result = assertHubSuccess(
    await requestSocket(
      deps,
      buildSocketMessage(deps, {
        intent: "list",
        threadId: "global",
        target: "all"
      })
    )
  );
  return parseJsonArray(result.content, "No active agent instances.");
}

async function resolveTargetThread(deps: CliDependencies, requestedThreadId: string | undefined): Promise<string> {
  if (requestedThreadId?.trim()) {
    return requestedThreadId.trim();
  }
  const instances = await listInstances(deps);
  if (instances.length === 0) {
    throw new CliError(EXIT_NOT_FOUND, "No active agent instances.");
  }
  if (instances.length > 1) {
    throw new CliError(EXIT_INVALID_ARGS, "Multiple active agent instances found; specify --thread <id>.");
  }
  const threadId = instances[0]?.thread_id;
  if (typeof threadId !== "string" || !threadId.trim()) {
    throw new CliError(EXIT_ERROR, "Hub returned an instance without thread_id");
  }
  return threadId.trim();
}

async function handleSpawn(args: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.positionals.length > 1) {
    throw new CliError(EXIT_INVALID_ARGS, "spawn accepts at most one positional agent type");
  }

  const provider = parseProvider(expectStringOption(parsed, "provider") ?? parsed.positionals[0]);
  const modelId = expectStringOption(parsed, "model");
  const reasoningEffort = parseReasoningEffort(expectStringOption(parsed, "effort"));
  const workdir = expectStringOption(parsed, "workdir");
  const autoApprove = expectBooleanOption(parsed, "auto-approve") ?? true;
  const mode = parseMode(expectStringOption(parsed, "mode"));

  const result = assertHubSuccess(
    await requestSocket(
      deps,
      buildSocketMessage(deps, {
        intent: "spawn",
        threadId: "pending",
        target: provider,
        mode,
        autoApprove,
        modelId,
        reasoningEffort,
        spawnDir: workdir ? path.resolve(workdir) : undefined
      })
    )
  );

  jsonOut(deps, {
    ok: true,
    thread_id: result.thread_id,
    agent_type: result.source
  });
}

async function handleKill(args: string[], deps: CliDependencies): Promise<void> {
  const threadId = args[0]?.trim();
  if (!threadId || args.length !== 1) {
    throw new CliError(EXIT_INVALID_ARGS, "kill requires exactly one thread id");
  }

  assertHubSuccess(
    await requestSocket(
      deps,
      buildSocketMessage(deps, {
        intent: "kill",
        threadId,
        target: threadId
      })
    )
  );

  jsonOut(deps, { ok: true });
}

async function handleStatus(deps: CliDependencies): Promise<void> {
  const instances = await listInstances(deps);
  const now = deps.now();
  const agents = instances.map((instance) => ({
    thread_id: typeof instance.thread_id === "string" ? instance.thread_id : "",
    type: typeof instance.agent_type === "string" ? instance.agent_type : "",
    model: typeof instance.model_id === "string" ? instance.model_id : null,
    status: typeof instance.status === "string" ? instance.status : "unknown",
    uptime: secondsSince(typeof instance.created_at === "string" ? instance.created_at : null, now)
  }));

  jsonOut(deps, {
    ok: true,
    agents
  });
}

async function handleSend(args: string[], deps: CliDependencies): Promise<void> {
  const [threadId, ...messageParts] = args;
  if (!threadId?.trim() || messageParts.length === 0) {
    throw new CliError(EXIT_INVALID_ARGS, "send requires a thread id and message");
  }

  const message = messageParts.join(" ").trim();
  if (!message) {
    throw new CliError(EXIT_INVALID_ARGS, "send requires a non-empty message");
  }

  const result = assertHubSuccess(
    await requestSocket(
      deps,
      buildSocketMessage(deps, {
        intent: "run",
        threadId,
        target: threadId,
        content: message
      })
    ),
    ["success", "partial", "timeout"]
  );

  jsonOut(deps, {
    ok: true,
    thread_id: result.thread_id,
    status: result.status
  });
}

async function handleLogs(args: string[], deps: CliDependencies): Promise<void> {
  const threadId = args[0]?.trim();
  if (!threadId || args.length !== 1) {
    throw new CliError(EXIT_INVALID_ARGS, "logs requires exactly one thread id");
  }

  const result = assertHubSuccess(
    await requestSocket(
      deps,
      buildSocketMessage(deps, {
        intent: "history",
        threadId,
        target: threadId
      })
    )
  );

  const entries = parseJsonArray(result.content, "").map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : null,
    event_kind: typeof entry.event_kind === "string" ? entry.event_kind : null,
    source: typeof entry.source === "string" ? entry.source : null,
    type: typeof entry.type === "string" ? entry.type : null,
    content:
      typeof entry.details_text === "string" && entry.details_text.trim()
        ? entry.details_text
        : typeof entry.content === "string"
          ? entry.content
          : "",
    raw_content: typeof entry.raw_content === "string" ? entry.raw_content : "",
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null
  }));

  jsonOut(deps, {
    ok: true,
    thread_id: threadId,
    entries
  });
}

async function handleAutoapprove(args: string[], deps: CliDependencies): Promise<void> {
  const action = args[0]?.trim().toLowerCase();
  if (!action || !["on", "off", "status"].includes(action)) {
    throw new CliError(EXIT_INVALID_ARGS, "autoapprove requires one of: on, off, status");
  }

  const parsed = parseArgs(args.slice(1));
  const threadId = await resolveTargetThread(deps, expectStringOption(parsed, "thread"));

  if (action === "status") {
    const instances = await listInstances(deps);
    const matched = instances.find((instance) => String(instance.thread_id ?? "") === threadId);
    if (!matched) {
      throw new CliError(EXIT_NOT_FOUND, `No active agent instance found for thread=${threadId}`);
    }

    jsonOut(deps, {
      ok: true,
      thread_id: threadId,
      auto_approve: matched.auto_approve === true
    });
    return;
  }

  assertHubSuccess(
    await requestSocket(
      deps,
      buildSocketMessage(deps, {
        intent: "set_auto_approve",
        threadId,
        target: threadId,
        content: action === "on" ? "true" : "false"
      })
    )
  );

  jsonOut(deps, {
    ok: true,
    thread_id: threadId,
    auto_approve: action === "on"
  });
}

async function handleHealth(deps: CliDependencies): Promise<void> {
  try {
    const response = await deps.hubHttpRequest("GET", "/api/health");
    if (response.statusCode === 200 && typeof response.body === "object" && response.body !== null) {
      jsonOut(deps, response.body as JsonRecord);
      return;
    }
  } catch {
    // Fall back to socket-derived health below.
  }

  const instances = await listInstances(deps);
  const uptime = await deps.inferSocketUptimeSeconds(deps.socketPath);
  jsonOut(deps, {
    ok: true,
    version: deps.packageVersion,
    uptime,
    agents_count: instances.length
  });
}

async function ensureHubReachable(deps: CliDependencies): Promise<void> {
  try {
    await deps.connectToHub();
  } catch {
    throw new CliError(EXIT_UNREACHABLE, "Meridian hub is not reachable");
  }
}

export async function runCli(args: string[], deps: CliDependencies = defaultCliDependencies): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    showHelp(deps);
    return EXIT_SUCCESS;
  }

  const [command, ...commandArgs] = args;
  if (!command || !(command in COMMANDS)) {
    throw new CliError(EXIT_INVALID_ARGS, `unknown command: ${command ?? ""}`);
  }

  if (commandArgs.includes("--help")) {
    showCommandHelp(deps, command);
    return EXIT_SUCCESS;
  }

  await ensureHubReachable(deps);

  switch (command) {
    case "spawn":
      await handleSpawn(commandArgs, deps);
      return EXIT_SUCCESS;
    case "kill":
      await handleKill(commandArgs, deps);
      return EXIT_SUCCESS;
    case "status":
      await handleStatus(deps);
      return EXIT_SUCCESS;
    case "send":
      await handleSend(commandArgs, deps);
      return EXIT_SUCCESS;
    case "logs":
      await handleLogs(commandArgs, deps);
      return EXIT_SUCCESS;
    case "autoapprove":
      await handleAutoapprove(commandArgs, deps);
      return EXIT_SUCCESS;
    case "health":
      await handleHealth(deps);
      return EXIT_SUCCESS;
    default:
      throw new CliError(EXIT_INVALID_ARGS, `unknown command: ${command}`);
  }
}

async function main(): Promise<void> {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    const cliError = toCliError(error);
    jsonOut(defaultCliDependencies, {
      ok: false,
      error: cliError.message
    });
    process.exit(cliError.exitCode);
  }
}

if (require.main === module) {
  void main();
}
