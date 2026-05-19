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
  readonly root: string;
  private readonly rootReal: string;

  constructor(root: string, public readonly manifest: ChatterManifest) {
    this.root = root;
    this.rootReal = realpathSync(root);
  }

  resolveBinding(name: string, vars: Record<string, string>): string {
    const template = this.manifest.bindings[name];
    if (!template) {
      throw new Error(`Unknown binding: ${name}`);
    }
    const expanded = template.replace(/<([a-z_]+)>/g, (_, key) => {
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
    if (rel === "" ) return;
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new SandboxViolationError("path is not under sandbox root", abs);
    }
  }
}
