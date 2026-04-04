#!/usr/bin/env node

/**
 * Meridian CLI — external interface for controlling Meridian hub.
 *
 * All command output is JSON on stdout; human-readable hints go to stderr.
 * Exit codes: 0=success, 1=general error, 2=invalid args, 3=service unreachable, 4=target not found.
 */

import { connectToHub, type HubConnection } from "./hub-connection";

// ── Exit codes ──────────────────────────────────────────────────────────────

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_INVALID_ARGS = 2;
// EXIT_UNREACHABLE (3) and EXIT_NOT_FOUND (4) are defined in hub-connection.ts
// and surfaced by the connection layer, but we re-export for local use:
const EXIT_UNREACHABLE = 3;
const _EXIT_NOT_FOUND = 4; // reserved for N-02

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonOut(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function hint(msg: string): void {
  process.stderr.write(msg + "\n");
}

// ── Subcommand stubs (implemented in N-02) ──────────────────────────────────

const COMMANDS: Record<string, string> = {
  spawn: "Launch an agent instance",
  kill: "Terminate an agent thread",
  status: "List running agent instances",
  send: "Send a message to an agent thread",
  logs: "Retrieve agent output logs",
  autoapprove: "Get or set auto-approve state",
  health: "Check Meridian hub health",
};

function stub(command: string): never {
  jsonOut({ ok: false, error: `${command}: not implemented` });
  process.exit(EXIT_ERROR);
}

// ── Help ────────────────────────────────────────────────────────────────────

function showHelp(): void {
  hint("Usage: meridian <command> [options]\n");
  hint("Commands:");
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    hint(`  ${cmd.padEnd(14)} ${desc}`);
  }
  hint("\nOptions:");
  hint("  --help       Show help for a command");
  hint("  --json       (default) JSON output on stdout");
  hint("\nExit codes:");
  hint("  0  Success");
  hint("  1  General error");
  hint("  2  Invalid arguments");
  hint("  3  Service unreachable");
  hint("  4  Target not found");
}

function showCommandHelp(command: string): void {
  hint(`Usage: meridian ${command} [options]`);
  hint(`\n${COMMANDS[command] ?? "Unknown command"}`);
  hint("\nThis command is a stub. Implementation pending (N-02).");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No args or --help at top level
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    showHelp();
    process.exit(EXIT_SUCCESS);
  }

  const command = args[0]!;

  // Validate command
  if (!(command in COMMANDS)) {
    hint(`Unknown command: ${command}`);
    hint('Run "meridian --help" for available commands.');
    jsonOut({ ok: false, error: `unknown command: ${command}` });
    process.exit(EXIT_INVALID_ARGS);
  }

  // Per-command --help
  if (args.includes("--help")) {
    showCommandHelp(command);
    process.exit(EXIT_SUCCESS);
  }

  // Verify hub connectivity before dispatching (exit 3 if unreachable)
  let _conn: HubConnection;
  try {
    _conn = await connectToHub();
  } catch {
    jsonOut({ ok: false, error: "Meridian hub is not reachable" });
    process.exit(EXIT_UNREACHABLE);
  }

  // Dispatch — all stubs for now, N-02 will replace these
  stub(command);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  jsonOut({ ok: false, error: message });
  process.exit(EXIT_ERROR);
});
