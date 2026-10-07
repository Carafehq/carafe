/**
 * HandoffBench — the v6 invariants.
 *
 * These live under `src/bench/` on purpose: the open extractor layers may never
 * import the benchmark, and the bench's own tests are the only place that may
 * import both.
 */
import { describe, expect, test } from "bun:test";
import { checkInvariants, quotedAnchor, reposInHeader, reposInRightNow } from "./handoff";

describe("V9 the header's repo list and Right now's are one list", () => {
  test("the bench sees the two lists as one list", () => {
    const text = [
      "# Handoff: x",
      "- repos: /tmp/backend (732 tool calls), not checked: /tmp/gone (directory missing) · branch main",
      "",
      "## Right now (checked at 2026-09-20 12:00 UTC, when this handoff was written)",
      "",
      "- /tmp/backend",
      "  branch main",
      "- not checked: /tmp/gone (directory missing)",
      "",
    ].join("\n");
    expect(reposInHeader(text)).toEqual(["/tmp/backend", "/tmp/gone"]);
    expect(reposInRightNow(text)).toEqual(["/tmp/backend", "/tmp/gone"]);
    expect(checkInvariants(text).find((one) => one.name === "header repo list equals Right now repo list")!.ok).toBe(true);
  });
});

describe("V9 the bench catches a doubly-labelled seq", () => {
  test("the bench catches a file that labels one seq twice", () => {
    const doubled = [
      "## Lessons (dead ends and breakthroughs, verbatim)",
      "",
      "- 2026-09-14 · dead end: the reset threw the work away  [seq 42]",
      "- 2026-09-14 · breakthrough: and then it passed  [seq 42]",
    ].join("\n");
    expect(checkInvariants(doubled).find((one) => one.name === "no seq labelled with two kinds")!.ok).toBe(false);
  });
});

/* ================================================================== *
 * The bench's own new invariants
 * ================================================================== */

describe("the bench's v6 invariants", () => {
  test("a `+N more` under fifteen named single-disk branches fails", () => {
    const bad = [
      "## Right now (checked at 2026-09-20 12:00 UTC, when this handoff was written)",
      "",
      "- /tmp/backend",
      "  on this disk only (no remote has these commits): a 1111111 (2026-09-14) · b 2222222 (2026-09-13)",
      "  +4 more — git -C /tmp/backend for-each-ref --no-merged origin/main refs/heads",
    ].join("\n");
    expect(checkInvariants(bad).find((one) => one.name === "no +N more under 15 single-disk branches")!.ok).toBe(false);

    const good = [
      "## Right now (checked at 2026-09-20 12:00 UTC, when this handoff was written)",
      "",
      "- /tmp/backend",
      `  on this disk only (no remote has these commits): ${Array.from({ length: 15 }, (_, index) => `b${index} 111111${index} (2026-09-14)`).join(" · ")}`,
      "  +4 more — git -C /tmp/backend for-each-ref --no-merged origin/main refs/heads",
    ].join("\n");
    expect(checkInvariants(good).find((one) => one.name === "no +N more under 15 single-disk branches")!.ok).toBe(true);
  });

  test("the banner must be present exactly when no probe answered", () => {
    const silent = "## Right now\n\n- **LIVE STATE UNKNOWN** — carafe did not contact any service.\n";
    expect(checkInvariants(silent).find((one) => one.name === "LIVE STATE UNKNOWN iff no health reading")!.ok).toBe(true);
    const both = `${silent}- health: https://x.invalid/health → ok\n`;
    expect(checkInvariants(both).find((one) => one.name === "LIVE STATE UNKNOWN iff no health reading")!.ok).toBe(true);
    const neither = "## Right now\n\n- /tmp/p\n";
    expect(checkInvariants(neither).find((one) => one.name === "LIVE STATE UNKNOWN iff no health reading")!.ok).toBe(false);
  });

  test("a missing-answers warning below the fifth line fails", () => {
    const late = ["# Handoff: x", "", "- session: y", "- repos: none", "- started in: /tmp", "", "_No answers file. Ask the outgoing agent to run: carafe handoff y --questions_"].join("\n");
    expect(checkInvariants(late).find((one) => one.name === "missing answers warned in the first five lines")!.ok).toBe(false);
    const early = ["# Handoff: x", "> **No outgoing-agent answers.** ask them", "", "_No answers file. Ask the outgoing agent to run: carafe handoff y --questions_"].join("\n");
    expect(checkInvariants(early).find((one) => one.name === "missing answers warned in the first five lines")!.ok).toBe(true);
  });

  test("a file with none of these problems passes every invariant it can", () => {
    const clean = [
      "# Handoff: x",
      "> **No outgoing-agent answers.** This file is extraction only.",
      "",
      "- repos: /tmp/backend (7 tool calls)",
      "",
      "## Right now (checked at 2026-09-20 12:00 UTC, when this handoff was written)",
      "",
      "- **LIVE STATE UNKNOWN** — carafe did not contact any service.",
      "- /tmp/backend",
      "  branch main  [seq 4, 2026-09-17 10:01 UTC]",
      "",
      "## The tail, verbatim (seq 1 → 9: the last 2 turns of work in backend)",
      "",
    ].join("\n");
    expect(checkInvariants(clean).filter((one) => !one.ok).map((one) => one.name)).toEqual([]);
  });
});

/* ================================================================== *
 * ROUND 1 — every quoted sentence resolves at its own seq
 * ================================================================== */

describe("round 1 · the anchor invariant", () => {
  const section = (heading: string, ...rows: string[]): string => [`## ${heading}`, "", ...rows, ""].join("\n");

  test("it reads the LAST seq on the line — an incident mark is a different claim", () => {
    expect(quotedAnchor(`- "never push without asking" (said after an incident [seq 4])  [seq 9, 2026-09-13 10:01 UTC]`))
      .toEqual({ text: "never push without asking", seq: 9 });
    // an unquoted Waiting-on-the-owner line
    expect(quotedAnchor(`- Do you want one piece of work or two?  [seq 12, 2026-09-13 10:02 UTC]`))
      .toEqual({ text: "Do you want one piece of work or two?", seq: 12 });
    // a line anchored to a helper's own trace is not the main trace's business
    expect(quotedAnchor(`- "x"  [agent-ab12cd34 seq 3]`)).toBeNull();
    expect(quotedAnchor(`  not a row`)).toBeNull();
  });

  test("a seq that is not in the main trace fails, and so does one whose text never said it", () => {
    const trace = new Map<number, string>([[9, "**user:** never push without asking me first"]]);

    const good = section("Do not (the owner's prohibitions, verbatim)", `- "never push without asking me first"  [seq 9, 2026-09-13 10:01 UTC]`);
    expect(checkInvariants(good, trace).find((one) => one.name === "every quoted sentence resolves at its own seq")!.ok).toBe(true);

    // the real defect: a helper's prompt quoted under a seq of this trace
    const missing = section("Do not (the owner's prohibitions, verbatim)", `- "Do NOT deploy."  [seq 0]`);
    const failed = checkInvariants(missing, trace).find((one) => one.name === "every quoted sentence resolves at its own seq")!;
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("seq 0 is not in the main trace");

    const wrong = section("Standing instructions from the owner (verbatim)", `- "always answer in plain english"  [seq 9, 2026-09-13 10:01 UTC]`);
    expect(checkInvariants(wrong, trace).find((one) => one.name === "every quoted sentence resolves at its own seq")!.detail)
      .toContain(`seq 9 does not contain "always answer in plain english"`);
  });

  test("it covers Waiting on the owner too, and is skipped when no trace is supplied", () => {
    const trace = new Map<number, string>([[12, "**assistant:** Do you want one piece of work or two?"]]);
    const waiting = section("Waiting on the owner (asked, never answered)", `- Do you want one piece of work or two?  [seq 12, 2026-09-13 10:02 UTC]`);
    expect(checkInvariants(waiting, trace).find((one) => one.name === "every quoted sentence resolves at its own seq")!.ok).toBe(true);
    // no trace, no claim: the invariant is simply not reported
    expect(checkInvariants(waiting).some((one) => one.name === "every quoted sentence resolves at its own seq")).toBe(false);
  });
});
