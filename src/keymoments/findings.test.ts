import { describe, expect, test } from "bun:test";
import { detectFindings } from "./findings";
import type { SignalContext } from "./signals";

function findings(...lines: string[]) {
  const context: SignalContext = {
    blocks: [{ startSeq: 0, endSeq: lines.length, files: new Set(), userLine: null, userSeq: null, assistantLines: lines.map((text, seq) => ({ seq, text: `**assistant:** ${text}` })) }],
    runs: [], edits: [], streaks: [],
  };
  return detectFindings(context);
}

describe("assistant-reported findings", () => {
  test("keeps explicit conclusions and outcome measurements verbatim", () => {
    const lines = [
      "Duplicates went from about three percent to zero on the replay run.",
      "The root cause was the stale cache key.",
      "Staging rebuilds in under twenty seconds now.",
      "That's not a failure rate problem — **scrapers haven't run in 5 months**.",
      "Full pipeline ran end-to-end in 44 minutes.",
    ];
    expect(findings(...lines).map((moment) => moment.text)).toEqual(lines);
  });

  test("emits at most the highest-cue sentence from one assistant message", () => {
    const moments = findings("The replay took twenty seconds. The root cause was the stale key and it went from ten percent to zero.");
    expect(moments).toHaveLength(1);
    expect(moments[0]?.text).toContain("root cause");
  });

  // Every rejected line below was a finding under a number-plus-unit rule on a
  // real session (Acme 1.0): the detector quotes assistant prose, so precision
  // beats recall here.
  test("rejects questions, logs, bare acknowledgements, headings, list items, table rows, plans and idle numbers", () => {
    const moments = findings(
      "Does the replay now pass?",
      "FAIL src/a.test.ts — 2 tests failed",
      "Confirmed.",
      "I will inspect one more caller.",
      "Dev server up at **http://localhost:3000** (ready in 542ms).",
      "- **Six token types** — table format so you can match a header to its middleware in seconds",
      "**Phase 0 — measure baseline (1 day):** Take a 5K-product sample, compute pairwise similarity.",
      "| **Live-query (federated)** | Catalogue is huge or volatile | Zero — nothing stored |",
      "Typical latency budget is 200 ms per request.",
      "We should retry the export with 3 workers.",
      "**Remove** the audit pipeline import (`runProbes`, `scoreAudit`) from `runtime.ts` and move it to the 2 new executors.",
      "Now drop the audit + Pop Mart blocks from runtime, including the 3 executors.",
      "If you want B, I'd scope the spike to a single test file and run 50 queries through it.",
      "**T3 — zod migration** (~30 min) — convert `SinglePickResult` from interfaces to zod schemas.",
      "Probably 500-600 lines now given the dynamic canvas section.",
      "I’m checking the session generator now so we can run one test with a real token.",
      "I recommend Yarn here because Netlify is already using it and PR 121 is now green with Yarn.",
      `The root cause was ${"x".repeat(240)}.`,
    );
    expect(moments).toEqual([]);
  });

  test("a reply the adapter surfaced twice yields one finding", () => {
    const line = "I’ve confirmed the other worktrees stayed clean; only the isolated branch has the doc tweak.";
    const moments = findings(line, line, "Full pipeline ran end-to-end in 44 minutes.");
    expect(moments.map((moment) => [moment.seq, moment.text])).toEqual([[0, line], [2, "Full pipeline ran end-to-end in 44 minutes."]]);
  });
});
