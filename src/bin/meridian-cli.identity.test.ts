import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileP = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, "../..");
const cliEntry = path.join(repositoryRoot, "src/bin/meridian-cli.ts");
const hubEntry = path.join(repositoryRoot, "src/hub/index.ts");

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWithEmptyEnvironment(entry: string, args: string[] = []): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      ["--import", "tsx", entry, ...args],
      {
        cwd: repositoryRoot,
        env: {}
      }
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message
    };
  }
}

test("CLI reports its package identity with no environment configuration", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8")
  ) as {
    name: string;
    version: string;
  };

  const result = await runWithEmptyEnvironment(cliEntry, ["--version"]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, `${packageJson.name} ${packageJson.version}\n`);
  assert.equal(result.stderr, "");
});

test("CLI shows help with no environment configuration", async () => {
  const result = await runWithEmptyEnvironment(cliEntry, ["--help"]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /Usage: meridian <command> \[options\]/);
  assert.match(result.stderr, /--version\s+Show the installed Meridian version/);
});

test("an operational CLI command still requires caller configuration", async () => {
  const result = await runWithEmptyEnvironment(cliEntry, ["spawn", "codex"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /bootstrap_key_missing/);
});

test("a configuration-dependent entry still rejects an empty environment", async () => {
  const result = await runWithEmptyEnvironment(hubEntry);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Invalid environment configuration/);
  assert.match(result.stderr, /TELEGRAM_BOT_TOKEN/);
  assert.match(result.stderr, /ALLOWED_USER_IDS/);
});
