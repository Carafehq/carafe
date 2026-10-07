import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { launchFixture, storeFixture } from "../handoff/launch-fixture";
import type { EventPieces } from "../handoff/pieces";
import { anchoredExcerpts, authoredLines, runRealHandoffBench, verifyAnchoredExcerpts, verifyPrintedText, verifyQuotes } from "./handoff-real";
for (const shape of ["codex", "claude-code"] as const) test(`${shape}: real harness reads three isolated sessions without writing`, async () => {
  const root = mkdtempSync(join(tmpdir(), "carafe-real-bench-"));
  try {
    const store = new CarafeStore(join(root, "store"));
    for (let i = 0; i < 3; i++) storeFixture(store, launchFixture(root, i === 1 ? (shape === "codex" ? "claude-code" : "codex") : shape, `fixture-${shape}-${i}`));
    const snapshot = () => readdirSync(store.root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => `${d.parentPath}/${d.name}`).sort().map((p) => [p, readFileSync(p).toString("base64")]);
    const before = snapshot();
    const card = await runRealHandoffBench({ store });
    expect(card.sessions).toHaveLength(3); expect(card.total.falseStatements).toEqual([]); expect(card.total.badQuotes).toEqual([]);
    expect(card.total.dropped).toBeGreaterThanOrEqual(3); expect(card.ok).toBe(true); expect(snapshot()).toEqual(before);
    expect(verifyPrintedText("## Right now (checked at 2026-09-22)\n\n- repo `/missing` · branch `fake`")).toHaveLength(1);
    expect(verifyQuotes("[seq 1]\n> a planted quotation", [], "missing")).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("anchored excerpts: carried as trace text, verified against the event they cite", () => {
  const piece = (seq: number, ...lines: string[]): EventPieces => ({ seq, kind: "message", lines, chars: lines.join("").length, ts: null });
  const grep = "  ⤷ src/bench/render-codex.ts:29:  put(\"session_meta\", {})\nsrc/bench/generate.ts:89:  function pr(): void { const url = `https://github.com/${repo}/pull/${number}`; const a = shell(`gh pr create --title \"Improve the bench\" --body x`); }";
  const helper = [piece(81, "→ **Bash** {\"command\":\"grep -rn pr src\"}"), piece(82, grep)];
  const main = [
    piece(4, "**user:** keep going"),
    piece(5, "**assistant:** The root cause is that the forwarder passed the timestamp as a raw string instead of Unix seconds, which the upstream API rejects."),
    piece(6, "**assistant:** Something else entirely."),
  ];
  const traces = new Map<string, EventPieces[][]>([["", [main]], ["a9e0fa42", [helper]]]);
  const moments = (...body: string[]): string => ["## Key moments (deterministic, seq-anchored — selected from the WHOLE session, not just the tail)", "", "### Ch 1 · 3 turns · [seq 0–90]", ...body, "", "## Dig deeper", ""].join("\n");
  // the real line: a helper's grep output, two printed lines, clipped, ending in the helper's anchor
  const real = moments(
    "- pr: ⤷ src/bench/render-codex.ts:29:  put(\"session_meta\", {})",
    "src/bench/generate.ts:89:  function pr(): void { const url = `https://github.com/${repo}/pull/${number}`; const a = shell(`gh pr create --title \"Impr…  [agent-a9e0fa42 seq 82]",
  );

  test("a ${var} inside an anchored excerpt is trace text: carried, and verified in the helper event it cites", () => {
    expect(authoredLines(real).join("\n")).not.toContain("${repo}");
    expect(authoredLines(real).join("\n")).toContain("[agent-a9e0fa42 seq 82]"); // the frame stays carafe's
    const audit = verifyAnchoredExcerpts(real, traces);
    expect(audit).toEqual({ failures: [], checked: 1 });
  });

  test("the same ${var} in a Right now fact line is carafe's own words, whatever its brackets", () => {
    const fact = ["## Right now (checked at 2026-09-22 10:00 UTC, when this handoff was written)", "", "- /srv/app", "  uncommitted: src/${repo}/x.ts  [seq 82]", "- finding: https://github.com/${repo}/pull  [seq 82]", "", "## Dig deeper", ""].join("\n");
    const authored = authoredLines(fact);
    expect(authored.filter((line) => line.includes("${repo}"))).toHaveLength(2);
    expect(anchoredExcerpts(fact)).toEqual([]);
  });

  test("an excerpt that is not in the event it cites fails — fabricated, or anchored to the wrong event or trace", () => {
    const fabricated = moments("- finding: The forwarder was rewritten in Rust and now uses ${TZ}.  [seq 5]");
    expect(authoredLines(fabricated).join("\n")).not.toContain("${TZ}");
    expect(verifyAnchoredExcerpts(fabricated, traces).failures).toEqual([expect.stringContaining("not in the event it is anchored to [seq 5]")]);
    const misAnchored = moments("- finding: Something else entirely.  [seq 5]");
    expect(verifyAnchoredExcerpts(misAnchored, traces).failures).toHaveLength(1);
    const wrongTrace = real.replace("[agent-a9e0fa42 seq 82]", "[seq 5]");
    expect(verifyAnchoredExcerpts(wrongTrace, traces).failures).toHaveLength(1);
    const unknownHelper = real.replace("agent-a9e0fa42", "agent-deadbeef");
    expect(verifyAnchoredExcerpts(unknownHelper, traces).failures).toEqual([expect.stringContaining("cannot read")]);
    const lesson = ["## Lessons (dead ends and breakthroughs, verbatim)", "", "- 2026-09-21 · dead end: The root cause is that the forwarder passed ${x} as a raw string.  [seq 5]", ""].join("\n");
    expect(authoredLines(lesson).join("\n")).not.toContain("${x}");
    expect(verifyAnchoredExcerpts(lesson, traces).failures).toHaveLength(1);
  });

  test("a clipped excerpt passes; every run between clip markers must still be there", () => {
    const clipped = ["## Lessons (dead ends and breakthroughs, verbatim)", "", "- 2026-09-21 · breakthrough: The root cause is that the forwarder passed the timestamp as a raw…  [seq 5]", ""].join("\n");
    expect(verifyAnchoredExcerpts(clipped, traces)).toEqual({ failures: [], checked: 1 });
    const spliced = clipped.replace("as a raw…", "as a raw… string, and the fix was ${FIX}.");
    expect(verifyAnchoredExcerpts(spliced, traces).failures).toHaveLength(1);
  });

  test("carafe's notes stay authored; each excerpt of a composed moment is in its own trace", () => {
    const steer = moments("- steering: keep going → then: \"The root cause is that the forwarder passed the timestamp…\"  [seq 4]");
    expect(verifyAnchoredExcerpts(steer, traces)).toEqual({ failures: [], checked: 1 });
    expect(authoredLines(steer).join("\n")).toContain(`- steering: ‹excerpt› → then: "‹excerpt›"  [seq 4]`);
    const invented = steer.replace("The root cause is", "The fix is");
    expect(verifyAnchoredExcerpts(invented, traces).failures).toEqual([expect.stringContaining("not in the trace [seq 4]")]);
    // a flattened shell command writes ` ; ` for the newline in the tool input's JSON
    const tool = new Map<string, EventPieces[][]>([["", [[piece(7, "→ **Bash** {\"command\":\"cd \\\"/x y\\\" && echo ARMED\\ncd runs && node t.cjs\"}")]]]]);
    expect(verifyAnchoredExcerpts(moments("- dead end: Bash: cd \"/x y\" && echo ARMED ; cd runs && node t.cjs → explicit reversal  [seq 7]"), tool)).toEqual({ failures: [], checked: 1 });
    expect(verifyAnchoredExcerpts(moments("- dead end: Bash: cd \"/x y\" && echo ARMED ; cd runs && rm -rf t → explicit reversal  [seq 7]"), tool).failures).toHaveLength(1);
    // two Codex helpers can share a label; the entry holds when one of them holds it
    const shared = new Map<string, EventPieces[][]>([["", [main]], ["a9e0fa42", [[piece(82, "**assistant:** unrelated")], helper]]]);
    expect(verifyAnchoredExcerpts(real, shared)).toEqual({ failures: [], checked: 1 });
    const quoted = ["## Standing instructions from the owner (verbatim)", "", "- \"keep going\"  [seq 4, 2026-09-21 14:30 UTC, 2 d before the end]", ""].join("\n");
    expect(verifyAnchoredExcerpts(quoted, traces)).toEqual({ failures: [], checked: 1 });
  });
});
