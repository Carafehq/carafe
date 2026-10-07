import { describe, expect, test } from "bun:test";
import type { SessionDistillate } from "../format/distillate";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment, KeyMomentSet, MomentKind } from "./extract";
import { extractKeyMoments, summarizeAnswers } from "./extract";
import { renderMomentsSection, renderResumeBlock } from "./render";
import { chapterHeadline } from "./render";
import type { Chapter } from "./chapters";

function d(sessionId = "s1"): SessionDistillate {
  return {
    tool: "codex",
    sessionId,
    sourcePath: "/tmp/session.jsonl",
    title: "test session",
    cwd: "/tmp",
    gitBranch: "main",
    startTs: "2026-01-01T10:00:00Z",
    endTs: "2026-01-01T11:00:00Z",
    eventCount: 100,
    toolUseCount: 6,
    sidechain: false,
    rawBytes: 10,
    version: 1,
  };
}

function p(seq: number, kind: string, lines: string[]): EventPieces {
  return { seq, kind, ts: `2026-01-01T10:${String(seq).padStart(2, "0")}:00Z`, chars: lines.join("\n").length, lines };
}

function fixture(): EventPieces[] {
  return [
    p(1, "system", ["**system:** hidden instruction"]),
    p(2, "user", ["**user:** build key moments"]),
    p(3, "assistant", ["→ **AskUserQuestion** {\"question\":\"Use deterministic selection?\"}"]),
    p(4, "tool_result", ["  ⤷ yes, keep it deterministic"]),
    p(5, "tool_use", ["→ **Bash** {\"cmd\":\"git commit -m key-moments\"}"]),
    p(6, "tool_result", ["pr-link ready https://example.com/pr-link/123"]),
    p(7, "user", ["**user:** actually keep this open tier only"]),
    p(9, "tool_use", ["→ **Bash** {\"cmd\":\"bun test\"}"]),
    p(10, "tool_result", ["  ⤷ early error failed but later fixed"]),
    p(40, "tool_use", ["→ **Bash** {\"cmd\":\"git reset --hard HEAD~1\"}"]),
    p(93, "user", ["**user:** do not touch closed files"]),
    p(94, "tool_use", ["→ **Bash** {\"cmd\":\"bun run bad-command\"}"]),
    p(95, "tool_result", ["  ⤷ tail error failed with exit code 1"]),
    p(96, "tool_use", ["→ **Edit** {\"file_path\":\"src/keymoments/extract.ts\"}"]),
    p(100, "assistant", ["**assistant:** done"]),
  ];
}

describe("extractKeyMoments", () => {
  test("is deterministic", () => {
    expect(extractKeyMoments(fixture())).toEqual(extractKeyMoments(fixture()));
  });

  test("selects goal and later user steering as asks", () => {
    const set = extractKeyMoments(fixture());
    expect(set.moments.find((m) => m.kind === "goal")?.text).toContain("build key moments");
    const asks = set.moments.filter((m) => m.kind === "ask").map((m) => m.text);
    expect(asks).toContain("**user:** actually keep this open tier only");
    expect(asks).toContain("**user:** do not touch closed files");
  });

  test("never includes system lines", () => {
    const allText = extractKeyMoments(fixture()).moments.map((m) => `${m.text}\n${m.note ?? ""}`).join("\n");
    expect(allText).not.toContain("**system:**");
    expect(allText).not.toContain("hidden instruction");
  });

  test("falls back to the old decision shape when a result has no question-answer pairs", () => {
    const decision = extractKeyMoments(fixture()).moments.find((m) => m.kind === "decision");
    expect(decision?.seq).toBe(3);
    expect(decision?.text).toContain("AskUserQuestion");
    expect(decision?.note).toBe("  ⤷ yes, keep it deterministic");
  });

  test("summarizes a real multi-question result as question to chosen answer", () => {
    const result = '  ⤷ User has answered your questions: "What kind of website are we building?"="App-like web experience", "There\'s already an `acme-app/landing` repo (pushed 2024-08). Start there or fresh?"="Replace contents of `landing` repo", "How tightly should the web mirror the mobile app\'s look?"="Brand-consistent, web-native". You can now continue with the user\'s answers in mind.';
    const summary = summarizeAnswers(result);
    const decision = extractKeyMoments([
      p(1, "user", ["**user:** build the website"]),
      p(2, "assistant", ['→ **AskUserQuestion** {"question":"What kind of website are we building?"}']),
      p(3, "tool_result", [result]),
    ]).moments.find((moment) => moment.kind === "decision");

    expect(summary).toContain("App-like web experience");
    expect(summary).toContain("→");
    expect(summary).not.toContain("ELI10");
    expect(summary!.length).toBeLessThan(320);
    expect(decision?.text).toBe(summary ?? undefined);
    expect(decision?.note).toBeUndefined();
  });

  test("reduces a long-bodied decision question to its headline", () => {
    const summary = summarizeAnswers('"D1 — headline\\n\\nELI10: blah blah\\n\\nStakes: blah"="Chosen"');

    expect(summary).toContain("D1 — headline → Chosen");
    expect(summary).not.toContain("ELI10");
    expect(summary).not.toContain("Stakes");
  });

  test("uses only the question headline in the fallback decision shape", () => {
    const decision = extractKeyMoments([
      p(1, "user", ["**user:** choose"]),
      p(2, "assistant", ['→ **AskUserQuestion** {"question":"D1 — headline\\n\\nELI10: long body\\n\\nStakes: high"}']),
      p(3, "tool_result", ["  ⤷ no structured pairs here"]),
    ]).moments.find((moment) => moment.kind === "decision");

    expect(decision?.text).toContain("D1 — headline");
    expect(decision?.text).not.toContain("ELI10");
    expect(decision?.note).toBe("  ⤷ no structured pairs here");
  });

  test("a cancelled question is NOT recorded as a locked decision", () => {
    const moments = extractKeyMoments([
      p(1, "user", ["**user:** go"]),
      p(2, "assistant", ['→ **AskUserQuestion** {"question":"Which cron should drive the poll?"}']),
      p(3, "tool_result", ["  ⤷ The user doesn't want to proceed with this tool use. The tool use was rejected."]),
    ]).moments;

    expect(moments.filter((m) => m.kind === "decision")).toEqual([]);
    expect(moments.map((m) => `${m.text}${m.note ?? ""}`).join("\n")).not.toContain("was rejected");
  });

  test("captures commits and pr-link lines as artifacts", () => {
    const artifacts = extractKeyMoments(fixture()).moments.filter((m) => m.kind === "artifact");
    expect(artifacts.some((m) => m.text.includes("git commit"))).toBe(true);
    expect(artifacts.some((m) => m.text.includes("pr-link"))).toBe(true);
  });

  test("captures the rendered Claude Code PR-link shape as an artifact", () => {
    const artifacts = extractKeyMoments([
      p(1, "user", ["**user:** open a pull request"]),
      p(2, "meta", ["pr-link #23 https://github.com/acme/billing/pull/23"]),
    ]).moments.filter((moment) => moment.kind === "artifact");
    expect(artifacts).toEqual([{
      kind: "artifact",
      seq: 2,
      text: "pr-link #23 https://github.com/acme/billing/pull/23",
    }]);
  });

  test("captures a Codex exec_command commit as an artifact", () => {
    const artifacts = extractKeyMoments([
      p(1, "user", ["**user:** ship it"]),
      p(2, "tool_use", ['→ **exec_command** {"cmd":"git commit -m \\"finish queue retry\\""}']),
    ]).moments.filter((moment) => moment.kind === "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.text).toContain("git commit -m");
  });

  test("captures a command-array shell reversal as a dead end", () => {
    const deadend = extractKeyMoments([
      p(1, "user", ["**user:** undo it"]),
      p(2, "tool_use", ['→ **shell** {"command":["bash","-lc","git reset --hard HEAD"]}']),
    ]).moments.find((moment) => moment.kind === "deadend");
    expect(deadend?.text).toContain("bash -lc git reset --hard HEAD");
    expect(deadend?.note).toBe("explicit reversal");
  });

  test("does not infer a commit artifact from a Read path", () => {
    const artifacts = extractKeyMoments([
      p(1, "user", ["**user:** inspect the guide"]),
      p(2, "tool_use", ['→ **Read** {"file_path":"notes/git-commit-guide.md"}']),
    ]).moments.filter((moment) => moment.kind === "artifact");
    expect(artifacts).toEqual([]);
  });

  test("captures explicit git reversals as dead ends", () => {
    const deadend = extractKeyMoments(fixture()).moments.find((m) => m.kind === "deadend" && m.seq === 40);
    expect(deadend?.text).toContain("git reset --hard");
    expect(deadend?.note).toBe("explicit reversal");
  });

  test("tail-gates error-result dead ends", () => {
    const deadends = extractKeyMoments(fixture()).moments.filter((m) => m.kind === "deadend");
    expect(deadends.some((m) => m.note?.includes("tail error failed"))).toBe(true);
    expect(deadends.some((m) => m.note?.includes("early error failed"))).toBe(false);
    expect(deadends.some((m) => m.seq === 94 && m.text.includes("bad-command"))).toBe(true);
  });

  test("adds WIP moments from the last tool/edit pieces", () => {
    const wips = extractKeyMoments(fixture(), { wipCount: 2 }).moments.filter((m) => m.kind === "wip");
    expect(wips.map((m) => m.seq)).toEqual([94, 96]);
    expect(wips[1]?.text).toContain("src/keymoments/extract.ts");
  });

  test("does NOT flag a passing tail command as a dead end", () => {
    const pcs = [
      p(1, "user", ["**user:** go"]),
      p(90, "tool_use", ["→ **Bash** {\"cmd\":\"bun test\"}"]),
      p(91, "tool_result", ["  ⤷ 12 passed, 0 failed. error output scanned. Process exited with code 0"]),
    ];
    expect(extractKeyMoments(pcs).moments.filter((m) => m.kind === "deadend")).toEqual([]);
  });

  test("reduces verbose tool json to the salient command (no harness noise)", () => {
    const pcs = [
      p(1, "user", ["**user:** go"]),
      p(2, "tool_use", ["→ **exec_command** {\"cmd\":\"npx vitest run\",\"workdir\":\"/tmp/x\",\"yield_time_ms\":30000,\"max_output_tokens\":50000}"]),
    ];
    const wip = extractKeyMoments(pcs).moments.find((m) => m.kind === "wip");
    expect(wip?.text).toContain("npx vitest run");
    expect(wip?.text).not.toContain("yield_time_ms");
    expect(wip?.text).not.toContain("workdir");
  });

  test("captures a genuine tail failure with the named error as the note", () => {
    const pcs = [
      p(1, "user", ["**user:** go"]),
      p(90, "tool_use", ["→ **exec_command** {\"cmd\":\"npx tsc --noEmit\"}"]),
      p(91, "tool_result", ["  ⤷ Chunk ID: abc\nWall time: 12s\nProcess exited with code 2\nOutput:\nsrc/a.ts(1,2): error TS2322: Type 'null' not assignable"]),
    ];
    const dd = extractKeyMoments(pcs).moments.find((m) => m.kind === "deadend");
    expect(dd?.text).toContain("tsc --noEmit");
    expect(dd?.note).toContain("error TS2322");
    expect(dd?.note).not.toContain("Chunk ID");
  });
});

describe("renderResumeBlock", () => {
  test("keeps goal decisions and wip while reporting budget trims", () => {
    const base = fixture();
    const noisy = [
      ...base.slice(0, 7),
      ...Array.from({ length: 12 }, (_, i) => p(20 + i, "user", [`**user:** course correction ${i} ${"x".repeat(120)}`])),
      ...base.slice(7),
    ];
    const set = extractKeyMoments(noisy, { wipCount: 2 });
    const block = renderResumeBlock(d(), set, { budgetChars: 900 });

    expect(block.trimmed).toBeGreaterThan(0);
    expect(block.text).toContain("## The goal");
    expect(block.text).toContain("### Ch 1");
    expect(block.text).toContain("- decision:");
    expect(block.text).toContain("- wip:");
    expect(block.text).toContain("moments trimmed");
    expect(block.text).toContain("[seq 2]");
    expect(block.text).toContain("[seq 3]");
    expect(block.text).toContain("[seq 96]");

    const bullets = block.text.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.every((line) => line.includes("[seq "))).toBe(true);
  });

  test("gives every populated category a share of a small budget", () => {
    const counts: Record<Exclude<MomentKind, "goal">, number> = {
      decision: 50,
      breakthrough: 0,
      finding: 0,
      deadend: 30,
      rule: 0,
      recap: 0,
      instruction: 0,
      openask: 0,
      ask: 30,
      artifact: 30,
      wip: 20,
    };
    const moments: KeyMoment[] = [{ kind: "goal", seq: 1, text: "**user:** keep every category represented" }];
    let seq = 2;
    for (const [kind, count] of Object.entries(counts) as [Exclude<MomentKind, "goal">, number][]) {
      for (let i = 0; i < count; i++) {
        moments.push({ kind, seq: seq++, text: `${kind} moment ${i} ${"x".repeat(80)}` });
      }
    }
    const set: KeyMomentSet = { moments, totalEvents: moments.length };
    const block = renderResumeBlock(d(), set, { budgetChars: 1_200 });

    expect(block.text).toContain("- decision:");
    expect(block.text).toContain("- steering:");
    expect(block.text).toContain("- dead end:");
    expect(block.text).toContain("- commit:");
    expect(block.text).toContain("- wip:");
    expect(block.trimmed).toBeGreaterThan(0);
  });

  test("names per-kind counts in the trim notice", () => {
    const kinds = ["decision", "deadend", "ask", "artifact", "wip"] as const;
    const moments: KeyMoment[] = [{ kind: "goal", seq: 1, text: "**user:** report honest trim counts" }];
    for (const [kindIndex, kind] of kinds.entries()) {
      for (let i = 0; i < 10; i++) {
        moments.push({ kind, seq: kindIndex * 10 + i + 2, text: `${kind} ${i} ${"x".repeat(100)}` });
      }
    }
    const block = renderResumeBlock(d(), { moments, totalEvents: moments.length }, { budgetChars: 600 });
    const notice = block.text.split("\n").find((line) => line.includes("moments trimmed"));

    for (const kind of kinds) expect(notice).toMatch(new RegExp(`\\d+ ${kind}`));
  });
});

describe("renderMomentsSection", () => {
  test("composes a chapter headline only from recorded field values", () => {
    const chapter: Chapter = { index: 3, startSeq: 8120, endSeq: 9955, startTs: "2026-05-14T09:00:00Z", endTs: "2026-05-16T18:00:00Z", turns: 41, toolCalls: 20, chars: 2000, branch: "feat/queue-retries", cwd: "/repo", files: [{ name: "worker.ts", count: 4 }, { name: "retry.ts", count: 3 }, { name: "pool.ts", count: 2 }], commits: 3, failures: 2, decisions: 1, boundary: "branch", strength: 3 };
    expect(chapterHeadline(chapter)).toBe("### Ch 3 · 2026-05-14 → 05-16 · feat/queue-retries · 41 turns · 3 commits · 2 failures · worker.ts, retry.ts, pool.ts · [seq 8120–9955]");
  });

  test("renders anchored categories without resume framing or a duplicate goal", () => {
    const section = renderMomentsSection(extractKeyMoments(fixture()), { budgetChars: 1_200 });

    expect(section.text).toContain("### Ch 1");
    expect(section.text).toContain("- decision:");
    expect(section.text).toContain("[seq 3]");
    expect(section.text).not.toContain("# Resume context");
    expect(section.text).not.toContain("## The goal");
    expect(section.text).not.toContain("Continue from here");
    expect(section.text).not.toContain("build key moments");
  });

  test("keeps the chapter skeleton when only the non-embeddable goal was selected", () => {
    const section = renderMomentsSection({
      moments: [{ kind: "goal", seq: 1, text: "**user:** only a goal" }],
      totalEvents: 1,
    });

    expect(section.text).toContain("### Ch 1");
    expect(section.momentCount).toBe(0);
    expect(section.trimmed).toBe(0);
  });

  test("renders standing rules before chapter moments", () => {
    const section = renderMomentsSection({ moments: [
      { kind: "goal", seq: 1, text: "**user:** build it" },
      { kind: "rule", seq: 2, endSeq: 4, text: "Never edit generated files", note: "restated ×2 (seq 2, 4)" },
      { kind: "ask", seq: 3, text: "**user:** inspect the caller" },
    ], totalEvents: 5 });
    expect(section.text.indexOf("### Standing rules")).toBeLessThan(section.text.indexOf("### Ch 1"));
    expect(section.text).toContain("- rule: Never edit generated files");
  });
});
