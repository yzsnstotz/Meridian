import { describe, expect, it } from "vitest";

import { parseMeridianStatusMarker } from "../meridian-status-marker";

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

  it("returns null when block is malformed (no closing <<<END>>>)", () => {
    const reply = [
      "<<<MERIDIAN-STATUS>>>",
      "role: worker",
      "worker_id: N-04",
      "outcome: complete"
    ].join("\n");

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
});
