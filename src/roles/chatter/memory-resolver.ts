import path from "node:path";
import { realpathSync, existsSync } from "node:fs";
import type { ChatterManifest } from "./manifest";

export type SandboxRootMode = "rw" | "ro";

export interface ResolvedSandboxRoot {
  rootInput: string;
  rootReal: string;
  mode: SandboxRootMode;
}

export class SandboxViolationError extends Error {
  constructor(reason: string, public readonly attempted: string) {
    super(`Sandbox violation: ${reason} (attempted=${attempted})`);
    this.name = "SandboxViolationError";
  }
}

export class DeniedReadOnlyRootError extends Error {
  readonly code = "denied_ro_root";

  constructor(public readonly attemptedPath: string) {
    super(`denied_ro_root: ${attemptedPath}`);
    this.name = "DeniedReadOnlyRootError";
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
  readonly sandboxRoots: ReadonlyArray<ResolvedSandboxRoot>;
  private readonly readRoots: ReadonlyArray<ResolvedSandboxRoot>;
  private readonly rwRoots: ReadonlyArray<ResolvedSandboxRoot>;
  private readonly roRoots: ReadonlyArray<ResolvedSandboxRoot>;

  constructor(rootInput: string, public readonly manifest: ChatterManifest) {
    this.rootInput = rootInput;
    this.rootReal = realpathSync(rootInput);

    const declaredRoots = manifest.sandbox_roots?.length
      ? manifest.sandbox_roots.map((root) => this.resolveSandboxRoot(root.root, root.mode))
      : [this.resolveSandboxRoot(rootInput, "rw")];

    this.rwRoots = declaredRoots.filter((root) => root.mode === "rw");
    this.roRoots = declaredRoots.filter((root) => root.mode === "ro");
    this.readRoots = [...this.rwRoots, ...this.roRoots];
    this.sandboxRoots = Object.freeze([...this.readRoots]);
  }

  resolveBinding(name: string, vars: Record<string, string>): string {
    return this.resolveBindingForRead(name, vars);
  }

  resolveBindingForRead(name: string, vars: Record<string, string>): string {
    return this.resolveRelativePathForRead(this.expandBinding(name, vars));
  }

  resolveBindingForWrite(name: string, vars: Record<string, string>): string {
    return this.resolveRelativePathForWrite(this.expandBinding(name, vars));
  }

  resolveBindingParentPathsForRead(name: string, vars: Record<string, string>): string[] {
    return this.resolveRelativePathCandidatesForRead(path.dirname(this.expandBinding(name, vars)));
  }

  private expandBinding(name: string, vars: Record<string, string>): string {
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
    return expanded;
  }

  /**
   * Validate that an absolute user-supplied path resolves under a sandbox
   * root. Returns the lexically-resolved path on success.
   *
   * NOTE: caller owns TOCTOU between this check and any subsequent fs op.
   * The realpath probe defends against a symlink target sitting outside the
   * root at check time, but a symlink swap AFTER this returns and BEFORE the
   * caller's fs operation will not be caught here. This is acceptable per
   * design — the agent process itself runs under a claude-code permission
   * profile (settings.json deny rules) that constrains its filesystem access
   * to the declared sandbox roots at the OS level.
   */
  resolveAbsoluteUserPath(p: string): string {
    const resolved = path.resolve(p);
    // For non-existent paths, the lexical resolution must already sit under root.
    // For existing paths (or paths whose ancestors exist), follow symlinks via
    // realpath of the closest existing ancestor and verify that too.
    this.assertUnderAnyRoot(resolved);
    const existingAncestor = this.findExistingAncestor(resolved);
    if (existingAncestor !== null) {
      const real = realpathSync(existingAncestor);
      this.assertUnderAnyRoot(real);
    }
    return resolved;
  }

  /**
   * Resolve controlled memory-folder-relative path segments to a writable
   * target. Callers pass each semantic segment separately so traversal markers
   * are rejected before filesystem helpers receive a path.
   */
  resolveMemoryPath(...segments: string[]): string {
    return this.resolveMemoryPathForWrite(...segments);
  }

  resolveMemoryPathForRead(...segments: string[]): string {
    return this.resolveRelativePathForRead(this.safeRelativeMemoryPath(segments));
  }

  resolveMemoryPathForWrite(...segments: string[]): string {
    return this.resolveRelativePathForWrite(this.safeRelativeMemoryPath(segments));
  }

  resolveMemoryPathCandidatesForRead(...segments: string[]): string[] {
    return this.resolveRelativePathCandidatesForRead(this.safeRelativeMemoryPath(segments));
  }

  private safeRelativeMemoryPath(segments: string[]): string {
    if (segments.length === 0) {
      throw new SandboxViolationError("missing memory path segment", "");
    }
    for (const segment of segments) {
      this.assertSafeMemorySegment(segment);
    }
    return path.join(...segments);
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

  private assertSafeMemorySegment(segment: string): void {
    if (
      segment === ""
      || segment === "."
      || segment === ".."
      || path.isAbsolute(segment)
      || /[\\/]/.test(segment)
    ) {
      throw new SandboxViolationError("memory path segment is unsafe", segment);
    }
  }

  private resolveSandboxRoot(root: string, mode: SandboxRootMode): ResolvedSandboxRoot {
    const expanded = root
      .replaceAll("{memory_folder}", this.rootInput)
      .replaceAll("{user_id}", path.basename(this.rootInput));
    const rootInput = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(this.rootInput, expanded);
    return {
      rootInput,
      rootReal: realpathSync(rootInput),
      mode
    };
  }

  private resolveRelativePathForRead(relativePath: string): string {
    for (const candidate of this.resolveRelativePathCandidates(relativePath, this.readRoots)) {
      if (existsSync(candidate.path)) {
        return candidate.path;
      }
    }
    return this.resolveRelativePathCandidates(relativePath, this.rwRoots)[0]?.path
      ?? this.resolveRelativePathCandidates(relativePath, this.readRoots)[0]?.path
      ?? this.resolveRelativePathCandidates(relativePath, [{
        rootInput: this.rootInput,
        rootReal: this.rootReal,
        mode: "rw"
      }])[0].path;
  }

  private resolveRelativePathForWrite(relativePath: string): string {
    for (const candidate of this.resolveRelativePathCandidates(relativePath, this.rwRoots)) {
      if (existsSync(candidate.path)) {
        return candidate.path;
      }
    }

    const roMatch = this.resolveRelativePathCandidates(relativePath, this.roRoots).find((candidate) =>
      existsSync(candidate.path)
    );
    if (roMatch) {
      throw new DeniedReadOnlyRootError(roMatch.path);
    }

    const writeCandidate = this.resolveRelativePathCandidates(relativePath, this.rwRoots)[0];
    if (writeCandidate) {
      return writeCandidate.path;
    }

    const fallback = this.resolveRelativePathCandidates(relativePath, this.roRoots)[0];
    throw new DeniedReadOnlyRootError(fallback?.path ?? relativePath);
  }

  private resolveRelativePathCandidatesForRead(relativePath: string): string[] {
    return this.resolveRelativePathCandidates(relativePath, this.readRoots).map((candidate) => candidate.path);
  }

  private resolveRelativePathCandidates(
    relativePath: string,
    roots: ReadonlyArray<ResolvedSandboxRoot>
  ): Array<{ root: ResolvedSandboxRoot; path: string }> {
    return roots.map((root) => {
      const candidate = path.resolve(root.rootReal, relativePath);
      this.assertUnderRoot(root, candidate);
      return { root, path: candidate };
    });
  }

  private assertUnderAnyRoot(abs: string): void {
    if (this.readRoots.some((root) => this.isUnderRoot(root, abs))) {
      return;
    }
    throw new SandboxViolationError("path is not under sandbox root", abs);
  }

  private assertUnderRoot(root: ResolvedSandboxRoot, abs: string): void {
    if (!this.isUnderRoot(root, abs)) {
      throw new SandboxViolationError("path is not under sandbox root", abs);
    }
  }

  private isUnderRoot(root: ResolvedSandboxRoot, abs: string): boolean {
    const rel = path.relative(root.rootReal, abs);
    if (rel === "") return true;
    return !(rel.startsWith("..") || path.isAbsolute(rel));
  }
}
