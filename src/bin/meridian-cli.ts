#!/usr/bin/env node

import path from "node:path";
import readline from "node:readline";

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
  list: "List running agent instances with caller info",
  status: "List running agent instances",
  send: "Send a message to an agent thread",
  logs: "Retrieve agent output logs",
  history: "Retrieve conversation history entries with caller info",
  autoapprove: "Get or set auto-approve state",
  health: "Check Meridian API health",
  caller: "Manage caller identities (list/mint/rotate/revoke)"
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
  readLine: (prompt: string) => Promise<string>;
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
  },
  readLine: (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
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
      hint(deps, "  --mode <bridge|stateless_call|a2a|agentapi>  Spawn transport mode");
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
    case "list":
      hint(deps, "Usage: meridian list [--json]");
      hint(deps, "");
      hint(deps, "Options:");
      hint(deps, "  --json  Emit raw instance JSON including spawned_by, last_caller, last_caller_at");
      return;
    case "history":
      hint(deps, "Usage: meridian history <thread-id> [--json]");
      hint(deps, "");
      hint(deps, "Options:");
      hint(deps, "  --json  JSON output (default; includes caller_id, caller_label per entry)");
      return;
    case "caller":
      hint(deps, "Usage: meridian caller <subcommand> [options]");
      hint(deps, "");
      hint(deps, "Subcommands:");
      hint(deps, "  list                                     List all caller identities");
      hint(deps, "  mint --id <kebab-id> --label <label>     Mint a new caller key");
      hint(deps, "  rotate --id <kebab-id> [--yes]           Rotate a caller key");
      hint(deps, "  revoke --id <kebab-id> [--yes]           Revoke a caller");
      hint(deps, "");
      hint(deps, "Notes:");
      hint(deps, "  mint and rotate print the cleartext key once to stdout. Copy it immediately.");
      hint(deps, "  --id must match ^[a-z][a-z0-9_-]*$");
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

async function confirmAction(deps: CliDependencies, message: string, autoConfirm: boolean): Promise<boolean> {
  if (autoConfirm) {
    return true;
  }
  const answer = await deps.readLine(`${message} [y/N] `);
  return answer.trim().toLowerCase() === "y";
}

function formatShortTime(iso: string): string {
  return `${iso.slice(0, 16)}Z`;
}

async function handleList(args: string[], deps: CliDependencies): Promise<void> {
  const isJson = args.includes("--json");
  const instances = await listInstances(deps);

  if (isJson) {
    deps.stdout(`${JSON.stringify({ ok: true, instances }, null, 2)}\n`);
    return;
  }

  const header = `${"THREAD_ID".padEnd(16)} ${"TYPE".padEnd(10)} ${"STATUS".padEnd(10)} CALLER`;
  hint(deps, header);
  hint(deps, "-".repeat(60));

  for (const instance of instances) {
    const threadId = String(instance.thread_id ?? "").padEnd(16);
    const type = String(instance.agent_type ?? instance.type ?? "").padEnd(10);
    const status = String(instance.status ?? "").padEnd(10);

    let callerCol = "(none)";
    const lastCaller = instance.last_caller;
    if (lastCaller !== null && lastCaller !== undefined && typeof lastCaller === "object" && !Array.isArray(lastCaller)) {
      const callerRecord = lastCaller as Record<string, unknown>;
      const callerId = typeof callerRecord.caller_id === "string" ? callerRecord.caller_id : null;
      const callerAt = typeof instance.last_caller_at === "string" ? instance.last_caller_at : null;
      if (callerId) {
        const shortTime = callerAt ? formatShortTime(callerAt) : "";
        callerCol = shortTime ? `caller=${callerId}@${shortTime}` : `caller=${callerId}`;
      }
    }

    hint(deps, `${threadId} ${type} ${status} ${callerCol}`);
  }
}

async function handleCallerList(args: string[], deps: CliDependencies): Promise<void> {
  const isJson = args.includes("--json");
  const body = await requestApiBody(deps, "GET", "/api/callers");
  const callers = requireJsonArray(body, "Meridian API returned an unexpected callers payload");

  if (isJson) {
    deps.stdout(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  const header = `${"ID".padEnd(24)} ${"LABEL".padEnd(24)} ${"KIND".padEnd(10)} ${"AUTHORITY".padEnd(10)} ${"CREATED".padEnd(26)} ${"LAST_SEEN".padEnd(26)} STATUS`;
  hint(deps, header);
  hint(deps, "-".repeat(120));

  for (const caller of callers) {
    const id = String(caller.caller_id ?? "").padEnd(24);
    const label = String(caller.caller_label ?? "").padEnd(24);
    const kind = String(caller.caller_kind ?? "").padEnd(10);
    const authority = String(caller.caller_authority ?? "write").padEnd(10);
    const created = String(caller.created_at ?? "").padEnd(26);
    const lastSeen = String(caller.last_seen_at ?? "(never)").padEnd(26);
    const status = caller.revoked_at ? "revoked" : "active";
    hint(deps, `${id} ${label} ${kind} ${authority} ${created} ${lastSeen} ${status}`);
  }
}

async function handleCallerMint(args: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs(args);

  // Playbook §3.2: write-env convenience flag is deferred; reject it explicitly
  if (parsed.options.has("write-env")) {
    throw new CliError(EXIT_INVALID_ARGS, "the write-env convenience flag is not supported in this version; save the key manually");
  }

  const id = expectStringOption(parsed, "id");
  const label = expectStringOption(parsed, "label");

  if (!id) {
    throw new CliError(EXIT_INVALID_ARGS, "--id is required for caller mint");
  }
  if (!label) {
    throw new CliError(EXIT_INVALID_ARGS, "--label is required for caller mint");
  }

  const ID_REGEX = /^[a-z][a-z0-9_-]*$/;
  if (!ID_REGEX.test(id)) {
    throw new CliError(EXIT_INVALID_ARGS, `--id must match ^[a-z][a-z0-9_-]*$ (got: ${id})`);
  }

  const body = requireJsonRecord(
    await requestApiBody(deps, "POST", "/api/callers", { caller_id: id, caller_label: label }),
    "Meridian API returned an unexpected caller mint payload"
  );

  const callerId = typeof body.caller_id === "string" ? body.caller_id : id;
  const callerKey = typeof body.caller_key === "string" ? body.caller_key : "";

  // Playbook §3.4: cleartext key to stdout only, never persisted
  deps.stdout(`caller_id:  ${callerId}\n`);
  deps.stdout(`caller_key: ${callerKey}\n`);
  deps.stdout(`IMPORTANT: Save this key now. You will not see it again.\n`);
}

async function handleCallerRotate(args: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs(args);
  const id = expectStringOption(parsed, "id");
  const autoConfirm = parsed.options.get("yes") === true;

  if (!id) {
    throw new CliError(EXIT_INVALID_ARGS, "--id is required for caller rotate");
  }

  const confirmed = await confirmAction(deps, `Rotate key for caller '${id}'?`, autoConfirm);
  if (!confirmed) {
    hint(deps, "Aborted.");
    return;
  }

  const body = requireJsonRecord(
    await requestApiBody(deps, "POST", `/api/callers/${encodeURIComponent(id)}/rotate`, {}),
    "Meridian API returned an unexpected caller rotate payload"
  );

  const callerId = typeof body.caller_id === "string" ? body.caller_id : id;
  const callerKey = typeof body.caller_key === "string" ? body.caller_key : "";

  // Playbook §3.4: cleartext key to stdout only
  deps.stdout(`caller_id:  ${callerId}\n`);
  deps.stdout(`caller_key: ${callerKey}\n`);
  deps.stdout(`IMPORTANT: Save this key now. You will not see it again.\n`);
}

async function handleCallerRevoke(args: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs(args);
  const id = expectStringOption(parsed, "id");
  const autoConfirm = parsed.options.get("yes") === true;

  if (!id) {
    throw new CliError(EXIT_INVALID_ARGS, "--id is required for caller revoke");
  }

  const confirmed = await confirmAction(deps, `Revoke caller '${id}'? This cannot be undone.`, autoConfirm);
  if (!confirmed) {
    hint(deps, "Aborted.");
    return;
  }

  const body = requireJsonRecord(
    await requestApiBody(deps, "DELETE", `/api/callers/${encodeURIComponent(id)}`),
    "Meridian API returned an unexpected caller revoke payload"
  );

  const revokedAt = typeof body.revoked_at === "string" ? body.revoked_at : "";
  deps.stdout(`revoked_at: ${revokedAt}\n`);
}

async function handleCaller(args: string[], deps: CliDependencies): Promise<void> {
  const [subcommand, ...subArgs] = args;
  switch (subcommand) {
    case "list":
      await handleCallerList(subArgs, deps);
      return;
    case "mint":
      await handleCallerMint(subArgs, deps);
      return;
    case "rotate":
      await handleCallerRotate(subArgs, deps);
      return;
    case "revoke":
      await handleCallerRevoke(subArgs, deps);
      return;
    default:
      throw new CliError(EXIT_INVALID_ARGS, `unknown caller subcommand: ${subcommand ?? ""}. Use: list, mint, rotate, revoke`);
  }
}

async function handleHistory(args: string[], deps: CliDependencies): Promise<void> {
  const filteredArgs = args.filter((a) => a !== "--json");
  const threadId = filteredArgs[0]?.trim();
  if (!threadId) {
    throw new CliError(EXIT_INVALID_ARGS, "history requires exactly one thread id");
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
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
    caller_id: typeof entry.caller_id === "string" ? entry.caller_id : null,
    caller_label: typeof entry.caller_label === "string" ? entry.caller_label : null
  }));

  jsonOut(deps, {
    ok: true,
    thread_id: threadId,
    entries
  });
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
    case "list":
      await handleList(commandArgs, deps);
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
    case "history":
      await handleHistory(commandArgs, deps);
      return EXIT_SUCCESS;
    case "autoapprove":
      await handleAutoapprove(commandArgs, deps);
      return EXIT_SUCCESS;
    case "health":
      await handleHealth(deps);
      return EXIT_SUCCESS;
    case "caller":
      await handleCaller(commandArgs, deps);
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
