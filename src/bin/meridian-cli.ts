#!/usr/bin/env node

import path from "node:path";

import { deriveBuiltinCallerKey } from "../shared/caller-bootstrap";
import { ProviderModelCatalog as SharedProviderModelCatalog, type ProviderModelCatalogResult } from "../shared/model-catalog";
import {
  AgentTypeSchema,
  HubResultSchema,
  ReasoningEffortSchema,
  type AgentType,
  type BridgeMode,
  type HubResult,
  type ReasoningEffort
} from "../types";
import { parseModelReference } from "../shared/model-reference";
import { connectToHub, hubHttpRequest, setCallerIdentity, type HubConnection, type HubHttpResponse } from "./hub-connection";

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_INVALID_ARGS = 2;
const EXIT_UNREACHABLE = 3;
const EXIT_NOT_FOUND = 4;

const COMMANDS: Record<string, string> = {
  spawn: "Launch an agent instance",
  models: "List selectable models for a provider",
  kill: "Terminate an agent thread",
  interrupt: "Interrupt the active run without terminating the thread",
  stop: "Alias for interrupt",
  status: "List running agent instances",
  send: "Send a message to an agent thread",
  logs: "Retrieve agent output logs",
  autoapprove: "Get or set auto-approve state",
  health: "Check Meridian API health"
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
  listProviderModels: (provider: AgentType) => Promise<ProviderModelCatalogResult>;
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

const defaultProviderModelCatalog = new SharedProviderModelCatalog();

export const defaultCliDependencies: CliDependencies = {
  connectToHub,
  hubHttpRequest,
  listProviderModels: async (provider: AgentType) => defaultProviderModelCatalog.listModels(provider),
  now: () => new Date(),
  stdout: (text: string) => {
    process.stdout.write(text);
  },
  stderr: (text: string) => {
    process.stderr.write(text);
  }
};

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
  hint(deps, "  3  Meridian API unreachable");
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
      hint(deps, "  meridian models <provider>                List selectable models before spawn");
      hint(deps, "  --effort <low|medium|high|xhigh>         Codex reasoning effort override");
      hint(deps, "  --workdir <path>                          Agent working directory");
      hint(deps, "  --auto-approve                            Enable auto-approve (default)");
      hint(deps, "  --no-auto-approve                         Disable auto-approve");
      hint(deps, "  --mode <bridge|pane_bridge|stateless_call|a2a|agentapi>  Spawn transport mode");
      return;
    case "models":
      hint(deps, "Usage: meridian models <provider>");
      hint(deps, "   or: meridian models --provider <claude|codex|gemini|cursor>");
      return;
    case "kill":
      hint(deps, "Usage: meridian kill <thread-id>");
      return;
    case "interrupt":
      hint(deps, "Usage: meridian interrupt <thread-id>");
      return;
    case "stop":
      hint(deps, "Usage: meridian stop <thread-id>");
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
    case "stateless_call":
    case "stateless-call":
    case "stateless":
      return "stateless_call";
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

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildApiRoute(pathname: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      continue;
    }
    query.set(key, normalized);
  }
  const search = query.toString();
  return search ? `${pathname}?${search}` : pathname;
}

function normalizeApiErrorMessage(response: HubHttpResponse, fallback: string): string {
  if (isJsonRecord(response.body) && typeof response.body.error === "string" && response.body.error.trim()) {
    return response.body.error.trim();
  }
  if (typeof response.body === "string" && response.body.trim()) {
    return response.body.trim();
  }
  return fallback;
}

function exitCodeForApiStatus(statusCode: number, message: string): number {
  switch (statusCode) {
    case 400:
      return EXIT_INVALID_ARGS;
    case 404:
      return EXIT_NOT_FOUND;
    case 408:
    case 429:
    case 502:
    case 503:
    case 504:
      return EXIT_UNREACHABLE;
    default:
      return inferExitCode(message);
  }
}

function toApiTransportError(error: unknown): CliError {
  const message = normalizeErrorMessage(error);
  return new CliError(
    EXIT_UNREACHABLE,
    message ? `Meridian API is not reachable: ${message}` : "Meridian API is not reachable"
  );
}

async function requestApiResponse(
  deps: CliDependencies,
  method: string,
  route: string,
  body?: unknown
): Promise<HubHttpResponse> {
  try {
    return await deps.hubHttpRequest(method, route, body);
  } catch (error) {
    throw toApiTransportError(error);
  }
}

async function requestApiBody(
  deps: CliDependencies,
  method: string,
  route: string,
  body?: unknown
): Promise<unknown> {
  const response = await requestApiResponse(deps, method, route, body);
  if (response.statusCode !== 200) {
    const message = normalizeApiErrorMessage(response, `Meridian API request failed (${method} ${route})`);
    throw new CliError(exitCodeForApiStatus(response.statusCode, message), message);
  }
  return response.body;
}

function assertHubSuccess(result: HubResult, okStatuses: HubResult["status"][] = ["success"]): HubResult {
  if (!okStatuses.includes(result.status)) {
    throw new CliError(inferExitCode(result.content), result.content || "Meridian API request failed");
  }
  return result;
}

async function requestHubResult(
  deps: CliDependencies,
  method: string,
  route: string,
  body: unknown,
  okStatuses: HubResult["status"][] = ["success"]
): Promise<HubResult> {
  const payload = await requestApiBody(deps, method, route, body);
  return assertHubSuccess(HubResultSchema.parse(payload), okStatuses);
}

function requireJsonArray(body: unknown, fallbackMessage: string): Array<Record<string, unknown>> {
  if (!Array.isArray(body)) {
    throw new CliError(EXIT_ERROR, fallbackMessage);
  }
  return body.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function requireJsonRecord(body: unknown, fallbackMessage: string): JsonRecord {
  if (!isJsonRecord(body)) {
    throw new CliError(EXIT_ERROR, fallbackMessage);
  }
  return body;
}

function readListedInstanceString(instance: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = instance[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function listInstances(deps: CliDependencies): Promise<Array<Record<string, unknown>>> {
  return requireJsonArray(
    await requestApiBody(deps, "GET", "/api/instances"),
    "Meridian API returned an unexpected instances payload"
  );
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
    throw new CliError(EXIT_ERROR, "Meridian API returned an instance without thread_id");
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
  const modelRef = parseModelReference(modelId, reasoningEffort);

  const result = await requestHubResult(deps, "POST", "/api/spawn", {
    type: provider,
    provider,
    mode,
    auto_approve: autoApprove,
    ...(modelRef.modelId && { model_id: modelRef.modelId }),
    ...(modelRef.reasoningEffort && { effort: modelRef.reasoningEffort }),
    ...(workdir && { spawn_dir: path.resolve(workdir) })
  });

  jsonOut(deps, {
    ok: true,
    thread_id: result.thread_id,
    agent_type: result.source
  });
}

async function handleModels(args: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.positionals.length > 1) {
    throw new CliError(EXIT_INVALID_ARGS, "models accepts at most one positional provider");
  }

  const provider = parseProvider(expectStringOption(parsed, "provider") ?? parsed.positionals[0]);
  const catalog = await deps.listProviderModels(provider);

  jsonOut(deps, {
    ok: true,
    provider: catalog.provider,
    models: catalog.models
  });
}

async function handleKill(args: string[], deps: CliDependencies): Promise<void> {
  const threadId = args[0]?.trim();
  if (!threadId || args.length !== 1) {
    throw new CliError(EXIT_INVALID_ARGS, "kill requires exactly one thread id");
  }

  await requestHubResult(deps, "POST", "/api/kill", { thread_id: threadId });

  jsonOut(deps, { ok: true });
}

async function handleInterrupt(args: string[], deps: CliDependencies): Promise<void> {
  const threadId = args[0]?.trim();
  if (!threadId || args.length !== 1) {
    throw new CliError(EXIT_INVALID_ARGS, "interrupt requires exactly one thread id");
  }

  await requestHubResult(deps, "POST", "/api/interrupt", { thread_id: threadId });

  jsonOut(deps, { ok: true });
}

async function handleStatus(deps: CliDependencies): Promise<void> {
  const instances = await listInstances(deps);
  const now = deps.now();
  const agents = instances.map((instance) => ({
    thread_id: typeof instance.thread_id === "string" ? instance.thread_id : "",
    type: readListedInstanceString(instance, ["agent_type", "actual_agent", "type"]) ?? "",
    agent_type: readListedInstanceString(instance, ["agent_type", "actual_agent", "type"]) ?? "",
    model: readListedInstanceString(instance, ["current_model_id", "model_id", "model"]),
    model_id: readListedInstanceString(instance, ["current_model_id", "model_id", "model"]),
    current_model_id: readListedInstanceString(instance, ["current_model_id", "model_id", "model"]),
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

  const result = await requestHubResult(
    deps,
    "POST",
    "/api/run",
    {
      thread_id: threadId,
      content: message,
      attachments: []
    },
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

  const entries = requireJsonArray(
    await requestApiBody(deps, "GET", buildApiRoute("/api/history", { thread_id: threadId })),
    "Meridian API returned an unexpected history payload"
  ).map((entry) => ({
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
    const response = requireJsonRecord(
      await requestApiBody(deps, "GET", buildApiRoute("/api/autoapprove", { thread_id: threadId })),
      "Meridian API returned an unexpected auto-approve payload"
    );

    jsonOut(deps, {
      ok: true,
      thread_id: typeof response.thread_id === "string" && response.thread_id.trim() ? response.thread_id : threadId,
      auto_approve: response.auto_approve === true
    });
    return;
  }

  const response = requireJsonRecord(
    await requestApiBody(deps, "POST", "/api/autoapprove", {
      thread_id: threadId,
      enabled: action === "on"
    }),
    "Meridian API returned an unexpected auto-approve payload"
  );

  jsonOut(deps, {
    ok: true,
    thread_id: typeof response.thread_id === "string" && response.thread_id.trim() ? response.thread_id : threadId,
    auto_approve: response.auto_approve === true
  });
}

async function handleHealth(deps: CliDependencies): Promise<void> {
  jsonOut(
    deps,
    requireJsonRecord(await requestApiBody(deps, "GET", "/api/health"), "Meridian API returned an unexpected health payload")
  );
}

async function ensureHubReachable(deps: CliDependencies): Promise<void> {
  try {
    await deps.connectToHub();
  } catch (error) {
    throw toApiTransportError(error);
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
    case "models":
      await handleModels(commandArgs, deps);
      return EXIT_SUCCESS;
    case "kill":
      await handleKill(commandArgs, deps);
      return EXIT_SUCCESS;
    case "interrupt":
    case "stop":
      await handleInterrupt(commandArgs, deps);
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
    const callerId = "meridian-cli";
    const callerKey = deriveBuiltinCallerKey(callerId);
    setCallerIdentity({ caller_id: callerId, caller_key: callerKey, caller_label: "Meridian CLI" });
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
