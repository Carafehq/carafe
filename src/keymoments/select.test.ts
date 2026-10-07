import { describe, expect, test } from "bun:test";
import type { Chapter } from "./chapters";
import type { KeyMoment } from "./extract";
import { selectChapterMoments, steeringPriority } from "./select";

function chapter(index: number, eventful = false): Chapter {
  return { index, startSeq: index * 100, endSeq: index * 100 + 99, startTs: null, endTs: null, turns: 10, toolCalls: 2, chars: 1000, branch: "main", cwd: "/repo", files: [], commits: eventful ? 20 : 0, failures: eventful ? 20 : 0, decisions: eventful ? 20 : 0, boundary: index === 1 ? "start" : "drift", strength: index === 1 ? 0 : 1 };
}

describe("selectChapterMoments", () => {
  test("gives every active chapter a moment in a 30-chapter session", () => {
    const chapters = Array.from({ length: 30 }, (_, index) => chapter(index + 1));
    const moments: KeyMoment[] = chapters.map((item) => ({ kind: "ask", seq: item.startSeq, text: `chapter ${item.index}` }));
    const selection = selectChapterMoments({ moments, totalEvents: 3000 }, chapters, 20_000);
    expect(new Set(selection.selected.map((moment) => moment.chapter)).size).toBe(30);
  });

  test("eventfulness gets the largest share without silencing quiet chapters", () => {
    const chapters = Array.from({ length: 30 }, (_, index) => chapter(index + 1, index === 14));
    const moments: KeyMoment[] = chapters.flatMap((item) => Array.from({ length: item.index === 15 ? 100 : 3 }, (_, index) => ({ kind: index % 2 ? "decision" as const : "ask" as const, seq: item.startSeq + index, text: `${"x".repeat(80)} ${item.index}-${index}` })));
    const selection = selectChapterMoments({ moments, totalEvents: 3000 }, chapters, 20_000);
    const counts = chapters.map((item) => selection.selected.filter((moment) => moment.chapter === item.index).length);
    expect(counts[14]).toBe(Math.max(...counts));
    expect(counts.every((count) => count > 0)).toBe(true);
  });

  test("is deterministic", () => {
    const chapters = Array.from({ length: 8 }, (_, index) => chapter(index + 1, index === 3));
    const moments: KeyMoment[] = chapters.flatMap((item) => Array.from({ length: 20 }, (_, index) => ({ kind: index % 3 === 0 ? "deadend" as const : "ask" as const, seq: item.startSeq + index, text: `moment ${item.index}-${index}` })));
    expect(selectChapterMoments({ moments, totalEvents: 800 }, chapters, 4_000)).toEqual(selectChapterMoments({ moments, totalEvents: 800 }, chapters, 4_000));
  });

  test("funds standing rules before chapters and keeps them out of chapter assignment", () => {
    const chapters = [chapter(1), chapter(2)];
    const moments: KeyMoment[] = [
      { kind: "rule", seq: 100, endSeq: 200, text: "Never edit generated files by hand", note: "restated ×2 (seq 100, 200)" },
      { kind: "ask", seq: 101, text: "chapter one" },
      { kind: "ask", seq: 201, text: "chapter two" },
    ];
    const selection = selectChapterMoments({ moments, totalEvents: 3 }, chapters, 1_000);
    const rule = selection.selected.find((moment) => moment.kind === "rule");
    expect(rule?.chapter).toBeUndefined();
    expect(selection.selected.filter((moment) => moment.kind === "ask")).toHaveLength(2);
  });

  test("ranks steering turns by action, then questions, then narrative", () => {
    const imperative: KeyMoment = { kind: "ask", seq: 1, text: "**user:** Use SQLite for the retry state." };
    const changed: KeyMoment = { kind: "ask", seq: 2, text: "**user:** I was thinking about queues.", note: "trajectory changed" };
    const question: KeyMoment = { kind: "ask", seq: 3, text: "**user:** Which retry path is active?" };
    const narrative: KeyMoment = { kind: "ask", seq: 4, text: "**user:** CI was crawling this morning." };
    expect([imperative, changed, question, narrative].map(steeringPriority)).toEqual([1, 1, 2, 3]);
  });
});
