import { describe, expect, it } from "vitest";

import {
  parseMeridianStatusMarker,
  parseValidatorBlocking,
  parseValidatorDelegatable
} from "../meridian-status-marker";

describe("parseMeridianStatusMarker", () => {
  it("parses a well-formed worker marker at end of reply", () => {
    const reply = [
      "Some narrative about what was done.",
      "",
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-01",
      "outcome: complete",
      "report_path: artifacts/reports/N-01-report.md",
      "notes: all green",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "worker",
      worker_id: "N-01",
      outcome: "complete",
      report_path: "artifacts/reports/N-01-report.md",
      notes: "all green"
    });
  });

  it("parses a marker at the start of the reply with narrative after", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-02",
      "outcome: failed",
      "error: timed out",
      "<<<END>>>",
      "",
      "And here is some trailing narrative."
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "worker",
      worker_id: "N-02",
      outcome: "failed",
      error: "timed out"
    });
  });

  it("returns the LAST marker when two markers appear (e.g. quoted re-summary)", () => {
    const reply = [
      "Earlier I said:",
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-03",
      "outcome: failed",
      "<<<END>>>",
      "",
      "But the final outcome is:",
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-03",
      "outcome: complete",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "worker",
      worker_id: "N-03",
      outcome: "complete"
    });
  });

  it("returns null when no marker is present", () => {
    expect(parseMeridianStatusMarker("just a plain narrative reply")).toBeNull();
  });

  // Contract changed 2026-08-10: a TRAILING block with no closer is now
  // parsed rather than discarded. Discarding it stranded rows in `running`
  // with no transition and no PM routing (four incidents on
  // agent-dispatcher-abd83457). The fields are the worker's final word; a
  // missing or mistyped closer does not make them less authoritative.
  it("parses a trailing block even with no closing <<<END>>>", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-04",
      "outcome: complete"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toMatchObject({
      role: "worker",
      worker_id: "N-04",
      outcome: "complete"
    });
  });

  it("returns null when an unterminated block carries no valid fields", () => {
    const reply = ["<<<MERIDIAN-STATUS>>>", "just narrative, nothing parseable"].join("\n");

    expect(parseMeridianStatusMarker(reply)).toBeNull();
  });

  it("returns null when outcome value is unknown", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-05",
      "outcome: vibes",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toBeNull();
  });

  it("preserves multiline YAML-pipe feedback for validator markers", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: validator",
      "worker_id: N-06",
      "outcome: fix_requested",
      "cycle: 1",
      "score: 0.6",
      "feedback: |",
      "  first line of feedback",
      "  second line of feedback",
      "  third line",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "validator",
      worker_id: "N-06",
      outcome: "fix_requested",
      cycle: 1,
      score: 0.6,
      feedback: "first line of feedback\nsecond line of feedback\nthird line"
    });
  });

  it("ignores markers inside ``` fenced code blocks", () => {
    const reply = [
      "Here is an example of the marker format:",
      "```",
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-07",
      "outcome: complete",
      "<<<END>>>",
      "```",
      "",
      "(That was just illustration.)"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toBeNull();
  });

  it("ignores markers inside ~~~ fenced code blocks", () => {
    const reply = [
      "~~~",
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-08",
      "outcome: complete",
      "<<<END>>>",
      "~~~"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toBeNull();
  });

  it("with allowFenced parses markers inside ``` fences (artifact-file context)", () => {
    // Workers writing report files sometimes wrap their final marker in a
    // ```text fence for readability. In the chat-reply context this would be
    // ambiguous, but a worker's own report file unambiguously claims the
    // outcome regardless of fencing — that is what allowFenced expresses.
    const reportContent = [
      "## Reply marker",
      "",
      "```text",
      "<<<MERIDIAN-STATUS>>>",
      "worker_id: C-01",
      "role: worker",
      "outcome: complete",
      "report_path: /abs/reports/C-01.md",
      "notes: shipped",
      "<<<END>>>",
      "```"
    ].join("\n");

    expect(parseMeridianStatusMarker(reportContent)).toBeNull();
    expect(parseMeridianStatusMarker(reportContent, { allowFenced: true })).toEqual({
      role: "worker",
      worker_id: "C-01",
      outcome: "complete",
      report_path: "/abs/reports/C-01.md",
      notes: "shipped"
    });
  });

  it("parses a validator marker with cycle, score, and multiline feedback", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: validator",
      "worker_id: N-09",
      "outcome: fix_requested",
      "cycle: 2",
      "score: 0.85",
      "feedback: |",
      "  one",
      "  two",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "validator",
      worker_id: "N-09",
      outcome: "fix_requested",
      cycle: 2,
      score: 0.85,
      feedback: "one\ntwo"
    });
  });

  it("parses a pm-resolver marker with pm_action and notes", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: pm-resolver",
      "worker_id: N-10",
      "outcome: resolved",
      "pm_action: skip",
      "notes: worker repeatedly failed validation; skipping per policy",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "pm-resolver",
      worker_id: "N-10",
      outcome: "resolved",
      pm_action: "skip",
      notes: "worker repeatedly failed validation; skipping per policy"
    });
  });

  it("skips a stray opener and parses the next genuinely paired block", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "this opener has no closer",
      "",
      "later in narrative...",
      "",
      "<<<MERIDIAN-STATUS>>>",
      "worker_id: N-12",
      "role: worker",
      "outcome: complete",
      "report_path: /tmp/N-12.md",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "worker",
      worker_id: "N-12",
      outcome: "complete",
      report_path: "/tmp/N-12.md"
    });
  });

  it("captures key-like lines inside a YAML-pipe body as part of the string", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-13",
      "outcome: complete",
      "notes: |",
      "  earlier i wrote:",
      "  role: worker",
      "  outcome: failed",
      "  but that was wrong",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "worker",
      worker_id: "N-13",
      outcome: "complete",
      notes: "earlier i wrote:\nrole: worker\noutcome: failed\nbut that was wrong"
    });
  });

  it("keeps the last value when a key appears twice in the same block", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-14a",
      "worker_id: N-14b",
      "outcome: complete",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toEqual({
      role: "worker",
      worker_id: "N-14b",
      outcome: "complete"
    });
  });

  it("returns null when a required field is missing (no worker_id)", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "outcome: complete",
      "<<<END>>>"
    ].join("\n");

    expect(parseMeridianStatusMarker(reply)).toBeNull();
  });

  it("parses a validator marker with delegatable + blocking multi-line fields (v1.23.0)", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: validator",
      "worker_id: R-04",
      "outcome: fix_requested",
      "cycle: 1",
      "score: 0.5",
      "feedback: |",
      "  Real foreground measurement not provided.",
      "delegatable: |",
      "  ref=R-04.md:155 target=V-01 reason=Applied Laws delegates desktop run",
      "blocking: |",
      "  branch task/r-04 missing",
      "<<<END>>>"
    ].join("\n");

    const parsed = parseMeridianStatusMarker(reply);
    expect(parsed).not.toBeNull();
    expect(parsed?.role).toBe("validator");
    if (parsed?.role !== "validator") return;
    expect(parsed.outcome).toBe("fix_requested");
    expect(parsed.delegatable).toBe("ref=R-04.md:155 target=V-01 reason=Applied Laws delegates desktop run");
    expect(parsed.blocking).toBe("branch task/r-04 missing");
  });
});

describe("parseValidatorDelegatable", () => {
  it("returns empty array for undefined/null/empty input", () => {
    expect(parseValidatorDelegatable(undefined)).toEqual([]);
    expect(parseValidatorDelegatable(null)).toEqual([]);
    expect(parseValidatorDelegatable("")).toEqual([]);
    expect(parseValidatorDelegatable("   \n   ")).toEqual([]);
  });

  it("parses a single ref=target line", () => {
    const raw = "ref=R-04.md:155 target=V-01";
    expect(parseValidatorDelegatable(raw)).toEqual([{ ref: "R-04.md:155", target: "V-01" }]);
  });

  it("parses ref=target line with reason= tail", () => {
    const raw = "ref=R-04.md:155 target=V-01 reason=Applied Laws delegates desktop run";
    expect(parseValidatorDelegatable(raw)).toEqual([
      {
        ref: "R-04.md:155",
        target: "V-01",
        reason: "Applied Laws delegates desktop run"
      }
    ]);
  });

  it("parses multiple lines and skips empty / malformed lines", () => {
    const raw = [
      "ref=R-04.md:155 target=V-01",
      "",
      "this is not a valid delegatable line",
      "ref=R-05.md:99 target=V-02 reason=second one"
    ].join("\n");
    expect(parseValidatorDelegatable(raw)).toEqual([
      { ref: "R-04.md:155", target: "V-01" },
      { ref: "R-05.md:99", target: "V-02", reason: "second one" }
    ]);
  });
});

describe("parseValidatorBlocking", () => {
  it("returns empty array for undefined/null/empty input", () => {
    expect(parseValidatorBlocking(undefined)).toEqual([]);
    expect(parseValidatorBlocking(null)).toEqual([]);
    expect(parseValidatorBlocking("")).toEqual([]);
  });

  it("splits each non-empty line into one criterion", () => {
    const raw = [
      "branch task/r-04 missing",
      "",
      "tests not green"
    ].join("\n");
    expect(parseValidatorBlocking(raw)).toEqual([
      { criterion: "branch task/r-04 missing" },
      { criterion: "tests not green" }
    ]);
  });
});

describe("terminator tolerance (regression: rows stranded in `running`)", () => {
  const body = [
    "worker_id: C-08",
    "role: worker",
    "outcome: needs_pm",
    "notes: contract and files-owned gap"
  ].join("\n");

  it("parses a block closed with two angle brackets", () => {
    // Observed on agent-dispatcher-abd83457: C-07, C-08 and C-09 all typed
    // `<<<END>>`; the strict matcher found zero blocks, so no lifecycle
    // transition and no PM routing ever happened.
    const marker = parseMeridianStatusMarker(`done.\n\n<<<MERIDIAN-STATUS>>>\n${body}\n<<<END>>`);
    expect(marker).toMatchObject({ worker_id: "C-08", role: "worker", outcome: "needs_pm" });
  });

  it("parses a block closed with four angle brackets", () => {
    const marker = parseMeridianStatusMarker(`done.\n\n<<<MERIDIAN-STATUS>>>\n${body}\n<<<END>>>>`);
    expect(marker).toMatchObject({ worker_id: "C-08", outcome: "needs_pm" });
  });

  it("parses a trailing block whose terminator is missing entirely", () => {
    const marker = parseMeridianStatusMarker(`done.\n\n<<<MERIDIAN-STATUS>>>\n${body}`);
    expect(marker).toMatchObject({ worker_id: "C-08", outcome: "needs_pm" });
  });

  it("still parses the canonical three-bracket terminator", () => {
    const marker = parseMeridianStatusMarker(`done.\n\n<<<MERIDIAN-STATUS>>>\n${body}\n<<<END>>>`);
    expect(marker).toMatchObject({ worker_id: "C-08", outcome: "needs_pm" });
  });

  it("falls back to the last VALID block when a stray opener trails it", () => {
    const text = [
      "<<<MERIDIAN-STATUS>>>",
      "worker_id: C-08",
      "role: worker",
      "outcome: complete",
      "report_path: /tmp/C-08.md",
      "<<<END>>>",
      "",
      "PS: the format is <<<MERIDIAN-STATUS>>> and then narrative with no fields"
    ].join("\n");
    const marker = parseMeridianStatusMarker(text);
    expect(marker).toMatchObject({ worker_id: "C-08", outcome: "complete" });
  });

  it("returns null when no marker fields are present at all", () => {
    expect(parseMeridianStatusMarker("just narrative, no marker")).toBeNull();
  });
});
