import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Logger } from "../roles/base-role";

// Append a `[projects."<memoryFolder>"]` trust block to the codex CLI's
// config.toml so the codex agent that meridian-hub spawns for a fresh
// chatter doesn't hang at the interactive "Do you trust this directory?"
// prompt on first turn.
//
// Today the codex spawn args include `--dangerously-bypass-approvals-
// and-sandbox`, which masks the trust prompt entirely — so this helper
// is currently belt-and-suspenders. But when (not if) someone tightens
// the sandbox by dropping that flag, every new user's first turn would
// otherwise hang silently. Cheap to do now, expensive to debug later.
//
// Idempotent: if the trust block for this exact path is already present,
// the file is left untouched. Never throws — a failure here is logged
// and provisioning continues (trust is a UX nicety, not load-bearing).

export interface EnsureCodexTrustOptions {
  /** Absolute path to the user's mumu memory folder. */
  memoryFolder: string;
  /** Override the codex config.toml path; defaults to `~/.codex/config.toml`. */
  configTomlPath?: string;
  /** Logger; defaults to console. */
  log?: Logger;
  /** Set true (from MUMU_DISABLE_CODEX_AUTO_TRUST) to no-op. */
  disabled?: boolean;
}

const TRUST_BLOCK_TEMPLATE = (memoryFolder: string): string => `
# Auto-added by meridian-roles auto-provisioner — gives codex CLI permission
# to operate inside this user's mumu memory folder without an interactive
# trust prompt on first turn.
[projects."${memoryFolder}"]
trust_level = "trusted"
approval_policy = "never"
sandbox_mode = "danger-full-access"
`;

const trustBlockHeader = (memoryFolder: string): string => `[projects."${memoryFolder}"]`;

export async function ensureCodexTrustEntry(
  options: EnsureCodexTrustOptions
): Promise<{ appended: boolean; reason?: string }> {
  const log = options.log ?? console;
  if (options.disabled) {
    return { appended: false, reason: "disabled_by_env" };
  }

  const configPath = options.configTomlPath ?? path.join(homedir(), ".codex", "config.toml");
  const header = trustBlockHeader(options.memoryFolder);

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No codex config yet — write a fresh file with just our trust block.
      // First-write isn't load-bearing for any other codex flag because if
      // the operator hadn't set anything else, they don't depend on this
      // file for anything.
      try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, TRUST_BLOCK_TEMPLATE(options.memoryFolder), { mode: 0o600 });
        return { appended: true };
      } catch (writeError) {
        log.warn?.("codex-auto-trust: write new config failed (non-fatal)", {
          configPath,
          memoryFolder: options.memoryFolder,
          error: writeError instanceof Error ? writeError.message : String(writeError)
        });
        return { appended: false, reason: "write_new_failed" };
      }
    }
    log.warn?.("codex-auto-trust: read config failed (non-fatal)", {
      configPath,
      memoryFolder: options.memoryFolder,
      error: error instanceof Error ? error.message : String(error)
    });
    return { appended: false, reason: "read_failed" };
  }

  if (existing.includes(header)) {
    return { appended: false, reason: "already_present" };
  }

  // Append the trust block. Codex parses TOML so it'll pick up the new
  // section on next spawn — no codex daemon to restart.
  const next = existing.endsWith("\n") ? existing + TRUST_BLOCK_TEMPLATE(options.memoryFolder) : existing + "\n" + TRUST_BLOCK_TEMPLATE(options.memoryFolder);
  try {
    await fs.writeFile(configPath, next, { mode: 0o600 });
    return { appended: true };
  } catch (error) {
    log.warn?.("codex-auto-trust: append failed (non-fatal)", {
      configPath,
      memoryFolder: options.memoryFolder,
      error: error instanceof Error ? error.message : String(error)
    });
    return { appended: false, reason: "append_failed" };
  }
}

// The chatter's `llm_agent_kind` lands at this auto-trust gate; only codex-
// family kinds actually consume `~/.codex/config.toml`. Claude / Gemini have
// their own (or no) trust mechanisms.
export const llmAgentKindUsesCodexTrust = (kind: string): boolean =>
  /^codex(?:-|$)/u.test(kind);
