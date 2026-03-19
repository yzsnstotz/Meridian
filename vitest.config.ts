import { defineConfig } from "vitest/config";

const isE2EInvocation = process.argv.some((argument) => argument.includes("tests/e2e"));

export default defineConfig({
  test: {
    include: isE2EInvocation ? ["tests/e2e/**/*.ts"] : ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    testTimeout: isE2EInvocation ? 30_000 : 10_000,
    hookTimeout: 30_000,
    fileParallelism: !isE2EInvocation
  }
});
