#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_INTERNAL_DEPENDENCIES = {
  contracts: new Set(),
  runtime: new Set(["contracts"]),
  orchestrator: new Set(["contracts"]),
  gateway: new Set(["contracts", "runtime"]),
  supervisor: new Set(["contracts"]),
  cli: new Set(["contracts", "runtime", "supervisor"]),
};

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== "dist" && entry.name !== "node_modules")
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
      }),
  );
  return nested.flat();
}

function isInside(path, root) {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !offset.startsWith(sep));
}

export async function checkPackageBoundaries(workspaceRoot) {
  const packagesRoot = join(workspaceRoot, "packages");
  const packageEntries = await readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
  const violations = [];

  for (const entry of packageEntries.filter((candidate) => candidate.isDirectory())) {
    const packageName = entry.name;
    const packageRoot = join(packagesRoot, packageName);
    const allowed = ALLOWED_INTERNAL_DEPENDENCIES[packageName] ?? new Set();

    for (const file of await sourceFiles(join(packageRoot, "src"))) {
      const content = await readFile(file, "utf8");
      const imports = content.matchAll(
        /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
      );

      for (const match of imports) {
        const specifier = match[1] ?? match[2];
        const internal = specifier.match(/^@meridian\/([^/]+)/);
        if (internal && !allowed.has(internal[1])) {
          violations.push(
            `${relative(workspaceRoot, file)}: ${packageName} cannot depend on ${internal[1]}`,
          );
        }

        if (specifier.startsWith(".")) {
          const resolved = resolve(dirname(file), specifier);
          if (!isInside(resolved, packageRoot)) {
            violations.push(
              `${relative(workspaceRoot, file)}: relative import escapes package boundary (${specifier})`,
            );
          }
        }
      }
    }
  }

  return violations;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const workspaceRoot = resolve(process.argv[2] ?? process.cwd());
  const violations = await checkPackageBoundaries(workspaceRoot);
  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Package boundaries are valid.\n");
  }
}
