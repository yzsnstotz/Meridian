#!/usr/bin/env node

import { InvalidProjectPolicyError, loadProjectPolicy, ProjectNotRegisteredError } from "../web/project-policy-loader";

export interface ProjectPolicyCliIo {
  stdout: {
    write(chunk: string): unknown;
  };
  stderr: {
    write(chunk: string): unknown;
  };
}

const defaultIo: ProjectPolicyCliIo = {
  stdout: process.stdout,
  stderr: process.stderr
};

export async function runProjectPolicyCli(argv: string[], io: ProjectPolicyCliIo = defaultIo): Promise<number> {
  const normalizedArgv = argv[0] === "project-policy" ? argv.slice(1) : argv;
  const [command, projectId, ...rest] = normalizedArgv;
  const repoRoot = readRepoRoot(rest);

  if (command !== "validate" || !projectId) {
    io.stderr.write("Usage: project-policy validate <project_id> [--repo-root path]\n");
    return 1;
  }

  try {
    await loadProjectPolicy(projectId, { repoRoot });
    io.stdout.write(`Project policy ${projectId} is valid\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${formatProjectPolicyError(error)}\n`);
    return 1;
  }
}

function readRepoRoot(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--repo-root") {
      continue;
    }
    return args[index + 1];
  }
  return undefined;
}

function formatProjectPolicyError(error: unknown): string {
  if (error instanceof ProjectNotRegisteredError) {
    return `${error.filePath}: line 1: project is not registered`;
  }

  if (error instanceof InvalidProjectPolicyError) {
    const details = error.fieldPaths.map((fieldPath) => {
      const lineNumber = error.fieldLineNumbers[fieldPath] ?? 1;
      return `${error.filePath}: line ${lineNumber}: ${fieldPath}: ${error.message}`;
    });
    return details.join("\n");
  }

  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  void runProjectPolicyCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${formatProjectPolicyError(error)}\n`);
      process.exitCode = 1;
    }
  );
}
