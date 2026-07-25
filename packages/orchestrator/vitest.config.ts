import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

const isE2EInvocation = process.argv.some((argument) => argument.includes("tests/e2e"));

export default defineConfig({
  test: {
    include: isE2EInvocation ? ["tests/e2e/**/*.ts"] : ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Historical Mumu cross-repository E2E specs require an explicit ADS
    // checkout and are not portable unit tests. Keep them out of the default
    // package gate; the standalone tests/e2e suite remains opt-in.
    exclude: isE2EInvocation ? [] : ["src/__e2e__/**"],
    env: {
      MERIDIAN_DOCS_ROOT:
        process.env.MERIDIAN_DOCS_ROOT
        ?? path.join(os.tmpdir(), "meridian-orchestrator-test-docs")
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: !isE2EInvocation
  }
});
