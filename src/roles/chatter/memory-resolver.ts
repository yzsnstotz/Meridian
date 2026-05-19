import path from "node:path";
import { realpathSync, existsSync } from "node:fs";
import type { ChatterManifest } from "./manifest";

export class SandboxViolationError extends Error {
  constructor(reason: string, public readonly attempted: string) {
    super(`Sandbox violation: ${reason} (attempted=${attempted})`);
    this.name = "SandboxViolationError";
  }
}

export class MemoryResolver {
  /**
   * Pre-realpath input as supplied by the operator. Public for diagnostics
   * (logs, error messages) but NEVER use this for sandbox path checks —
   * always compare against rootReal, which has symlinks resolved.
   */
  readonly rootInput: string;
  private readonly rootReal: string;

  constructor(rootInput: string, public readonly manifest: ChatterManifest) {
    this.rootInput = rootInput;
    this.rootReal = realpathSync(rootInput);
  }

  resolveBinding(name: string, vars: Record<string, string>): string {
    const template = this.manifest.bindings[name];
    if (!template) {
      throw new Error(`Unknown binding: ${name}`);
    }
    // Placeholder vocabulary: lowercase letters, uppercase letters, digits,
    // and underscores. Widened from the original [a-z_]+ so manifest authors
    // can use camelCase or numeric suffixes (e.g. <turnId>, <date2>).
    const expanded = template.replace(/<([a-zA-Z0-9_]+)>/g, (_, key) => {
      if (vars[key] === undefined) {
        throw new Error(`Missing placeholder <${key}> for binding ${name}`);
      }
      return vars[key];
    });
    if (path.isAbsolute(expanded)) {
      throw new SandboxViolationError("binding produced an absolute path", expanded);
    }
    const candidate = path.resolve(this.rootReal, expanded);
    this.assertUnderRoot(candidate);
    return candidate;
  }

  /**
   * Validate that an absolute user-supplied path resolves under the sandbox
   * root. Returns the lexically-resolved path on success.
   *
   * NOTE: caller owns TOCTOU between this check and any subsequent fs op.
   * The realpath probe defends against a symlink target sitting outside the
   * root at check time, but a symlink swap AFTER this returns and BEFORE the
   * caller's fs operation will not be caught here. This is acceptable per
   * design — the agent process itself runs under a claude-code permission
   * profile (settings.json deny rules) that constrains its filesystem access
   * to the memory_folder root at the OS level.
   */
  resolveAbsoluteUserPath(p: string): string {
    const resolved = path.resolve(p);
    // For non-existent paths, the lexical resolution must already sit under root.
    // For existing paths (or paths whose ancestors exist), follow symlinks via
    // realpath of the closest existing ancestor and verify that too.
    this.assertUnderRoot(resolved);
    const existingAncestor = this.findExistingAncestor(resolved);
    if (existingAncestor !== null) {
      const real = realpathSync(existingAncestor);
      this.assertUnderRoot(real);
    }
    return resolved;
  }

  private findExistingAncestor(target: string): string | null {
    let cur = target;
    while (true) {
      if (existsSync(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }

  private assertUnderRoot(abs: string): void {
    const rel = path.relative(this.rootReal, abs);
    if (rel === "") return;
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new SandboxViolationError("path is not under sandbox root", abs);
    }
  }
}
