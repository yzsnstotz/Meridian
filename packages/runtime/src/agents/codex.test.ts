import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexExecArgs, buildCodexResumeArgs, buildCodexSpawnArgs } from "./codex";

// Every builder appends these by default; see appendLeanContextConfig in codex.ts.
const LEAN_CONTEXT_ARGS = [
  "-c",
  "skills.include_instructions=false",
  "-c",
  "features.memories=false",
  "-c",
  "features.multi_agent=false"
];

function withLeanContextOptOut(value: string, run: () => void): void {
  const previous = process.env.MERIDIAN_CODEX_LEAN_CONTEXT;
  process.env.MERIDIAN_CODEX_LEAN_CONTEXT = value;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.MERIDIAN_CODEX_LEAN_CONTEXT;
    } else {
      process.env.MERIDIAN_CODEX_LEAN_CONTEXT = previous;
    }
  }
}

test("buildCodexSpawnArgs omits auto-approve flag by default", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock");

  assert.deepEqual(args, [
    "server",
    "--type=codex",
    "--socket=/tmp/codex.sock",
    "--",
    "codex",
    ...LEAN_CONTEXT_ARGS,
    "--skip-git-repo-check"
  ]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexSpawnArgs appends auto-approve flag when requested", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", true, "xhigh");

  assert.deepEqual(args, [
    "server",
    "--type=codex",
    "--socket=/tmp/codex.sock",
    "--",
    "codex",
    "-c",
    'model_reasoning_effort="xhigh"',
    ...LEAN_CONTEXT_ARGS,
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check"
  ]);
});

test("buildCodexSpawnArgs uses read-only sandbox when requested", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", false, "xhigh", "read-only");

  assert.deepEqual(args, [
    "server",
    "--type=codex",
    "--socket=/tmp/codex.sock",
    "--",
    "codex",
    "-c",
    'model_reasoning_effort="xhigh"',
    ...LEAN_CONTEXT_ARGS,
    "--model",
    "gpt-5.4",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check"
  ]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexExecArgs enables direct JSON streaming mode", () => {
  const args = buildCodexExecArgs("gpt-5.4", true, "xhigh");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    ...LEAN_CONTEXT_ARGS,
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check"
  ]);
});

test("buildCodexExecArgs uses read-only sandbox when requested", () => {
  const args = buildCodexExecArgs("gpt-5.4", false, "xhigh", "read-only");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    ...LEAN_CONTEXT_ARGS,
    "--model",
    "gpt-5.4",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check"
  ]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexExecArgs always includes bypass flag even when autoApprove is false", () => {
  const args = buildCodexExecArgs("gpt-5.4", false);

  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
    "headless exec must always bypass approvals");
});

test("buildCodexExecArgs always includes bypass flag even when autoApprove is undefined", () => {
  const args = buildCodexExecArgs("gpt-5.4");

  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
    "headless exec must always bypass approvals");
});

test("buildCodexResumeArgs resumes an existing exec session", () => {
  const args = buildCodexResumeArgs("session-123", "gpt-5.4", true, "xhigh");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "resume",
    "session-123",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    ...LEAN_CONTEXT_ARGS,
    "--model",
    "gpt-5.4",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check"
  ]);
});

test("buildCodexResumeArgs uses read-only sandbox when requested", () => {
  const args = buildCodexResumeArgs("session-123", "gpt-5.4", false, "xhigh", "read-only");

  assert.deepEqual(args, [
    "codex",
    "exec",
    "resume",
    "session-123",
    "--json",
    "-c",
    'model_reasoning_effort="xhigh"',
    ...LEAN_CONTEXT_ARGS,
    "--model",
    "gpt-5.4",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check"
  ]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("buildCodexResumeArgs always includes bypass flag even when autoApprove is false", () => {
  const args = buildCodexResumeArgs("session-456", "gpt-5.4", false);

  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
    "headless resume must always bypass approvals");
});

test("lean-context config is appended by every builder by default", () => {
  const builders: Array<[string, string[]]> = [
    ["spawn", buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", true, "xhigh")],
    ["exec", buildCodexExecArgs("gpt-5.4", true, "xhigh")],
    ["resume", buildCodexResumeArgs("session-123", "gpt-5.4", true, "xhigh")]
  ];

  for (const [label, args] of builders) {
    assert.ok(args.join(" ").includes(LEAN_CONTEXT_ARGS.join(" ")),
      `${label} must append the lean-context config flags in order`);
  }
});

test("lean-context config keeps the exact key names codex 0.146.0 accepts", () => {
  // codex validates -c keys and hard-errors on an unknown key or wrong value
  // type, which would abort every hub spawn. Pin the literal strings.
  assert.deepEqual(LEAN_CONTEXT_ARGS, [
    "-c",
    "skills.include_instructions=false",
    "-c",
    "features.memories=false",
    "-c",
    "features.multi_agent=false"
  ]);
});

test("MERIDIAN_CODEX_LEAN_CONTEXT=0 suppresses lean-context config in every builder", () => {
  withLeanContextOptOut("0", () => {
    assert.deepEqual(buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", true, "xhigh"), [
      "server",
      "--type=codex",
      "--socket=/tmp/codex.sock",
      "--",
      "codex",
      "-c",
      'model_reasoning_effort="xhigh"',
      "--model",
      "gpt-5.4",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check"
    ]);

    assert.deepEqual(buildCodexExecArgs("gpt-5.4", true, "xhigh"), [
      "codex",
      "exec",
      "--json",
      "-c",
      'model_reasoning_effort="xhigh"',
      "--model",
      "gpt-5.4",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check"
    ]);

    assert.deepEqual(buildCodexResumeArgs("session-123", "gpt-5.4", true, "xhigh"), [
      "codex",
      "exec",
      "resume",
      "session-123",
      "--json",
      "-c",
      'model_reasoning_effort="xhigh"',
      "--model",
      "gpt-5.4",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check"
    ]);
  });
});

test("MERIDIAN_CODEX_LEAN_CONTEXT=false suppresses lean-context config", () => {
  withLeanContextOptOut("false", () => {
    assert.equal(buildCodexExecArgs("gpt-5.4").includes("features.memories=false"), false);
  });
});

test("MERIDIAN_CODEX_LEAN_CONTEXT with any other value keeps lean-context config on", () => {
  withLeanContextOptOut("1", () => {
    assert.ok(buildCodexExecArgs("gpt-5.4").includes("features.memories=false"));
  });
  withLeanContextOptOut("", () => {
    assert.ok(buildCodexExecArgs("gpt-5.4").includes("features.memories=false"));
  });
});

test("lean-context config is read at call time, not captured at module load", () => {
  const before = buildCodexExecArgs("gpt-5.4").includes("skills.include_instructions=false");
  withLeanContextOptOut("0", () => {
    assert.equal(buildCodexExecArgs("gpt-5.4").includes("skills.include_instructions=false"), false);
  });
  const after = buildCodexExecArgs("gpt-5.4").includes("skills.include_instructions=false");

  assert.equal(before, true);
  assert.equal(after, true);
});

test("lean-context config sits after reasoning effort and before --model and sandbox args", () => {
  const args = buildCodexExecArgs("gpt-5.4", false, "xhigh", "read-only");
  const reasoningIndex = args.indexOf('model_reasoning_effort="xhigh"');
  const firstLeanIndex = args.indexOf("skills.include_instructions=false");
  const lastLeanIndex = args.indexOf("features.multi_agent=false");
  const modelIndex = args.indexOf("--model");
  const sandboxIndex = args.indexOf("--sandbox");

  assert.ok(reasoningIndex < firstLeanIndex, "reasoning effort must precede lean-context config");
  assert.ok(lastLeanIndex < modelIndex, "lean-context config must precede --model");
  assert.ok(modelIndex < sandboxIndex, "--model must precede --sandbox");
});

test("lean-context config precedes the codex subcommand's model and sandbox args in spawn form", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", false, "xhigh", "read-only");
  const separatorIndex = args.indexOf("--");
  const commandIndex = args.indexOf("codex");
  const firstLeanIndex = args.indexOf("skills.include_instructions=false");
  const modelIndex = args.indexOf("--model");
  const sandboxIndex = args.indexOf("--sandbox");

  assert.ok(separatorIndex < commandIndex, "codex command must follow the -- separator");
  assert.ok(commandIndex < firstLeanIndex, "lean-context config belongs to the codex command, not the server wrapper");
  assert.ok(firstLeanIndex < modelIndex, "lean-context config must precede --model");
  assert.ok(modelIndex < sandboxIndex, "--model must precede --sandbox");
});
