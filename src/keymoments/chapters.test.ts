import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import { extractPieces } from "../handoff/pieces";
import { chapterOf, segmentChapters, type ChapterOpts } from "./chapters";

const sid = "chapters-test";

function cc(seq: number, kind: "user" | "assistant", ts: string, content: unknown, cwd = "/repo", branch = "main"): CarafeEvent {
  return { ts, tool: "claude-code", sessionId: sid, seq, kind, raw: { type: kind, timestamp: ts, cwd, gitBranch: branch, message: { role: kind, content } } };
}

function makeBlocks(count: number, decorate?: (index: number) => { gapHours?: number; command?: string; cwd?: string; file?: string }): CarafeEvent[] {
  const events: CarafeEvent[] = [];
  let clock = Date.parse("2026-01-01T00:00:00Z");
  let seq = 0;
  for (let index = 0; index < count; index++) {
    const shape = decorate?.(index) ?? {};
    clock += (shape.gapHours ?? 0.01) * 60 * 60 * 1000;
    const ts = new Date(clock).toISOString();
    events.push(cc(seq++, "user", ts, `turn ${index}`, shape.cwd));
    const command = shape.command ?? (shape.file ? `sed -n '1,20p' ${shape.file}` : "git status --short");
    events.push(cc(seq++, "assistant", new Date(clock + 1000).toISOString(), [{ type: "tool_use", name: "Bash", input: { command } }], shape.cwd));
  }
  return events;
}

function chapters(events: CarafeEvent[], opts: ChapterOpts = {}) {
  const pieces = extractPieces(events, {}, {});
  return segmentChapters(events, pieces, { shortSessionBlocks: 0, minBlocks: 1, minChapters: 1, ...opts });
}

describe("segmentChapters", () => {
  test("places a gap boundary", () => {
    const result = chapters(makeBlocks(12, (index) => ({ gapHours: index === 6 ? 5 : undefined })), { minBlocks: 3 });
    expect(result.some((chapter) => chapter.boundary === "gap" && chapter.turns === 6)).toBe(true);
  });

  test("recognizes branch creation but not a path checkout", () => {
    const switched = chapters(makeBlocks(16, (index) => ({ command: index === 7 ? "git checkout -b feat/x" : undefined })), { minBlocks: 4 });
    expect(switched.some((chapter) => chapter.boundary === "branch" && chapter.startSeq === 16)).toBe(true);
    const pathOnly = chapters(makeBlocks(16, (index) => ({ command: index === 7 ? "git checkout -- src/a.ts" : undefined })), { minBlocks: 4, driftJaccard: 0 });
    expect(pathOnly.some((chapter) => chapter.boundary === "branch")).toBe(false);
  });

  test("requires a cwd move to persist for three blocks", () => {
    const moved = chapters(makeBlocks(16, (index) => ({ cwd: index < 7 ? "/a" : "/b" })), { minBlocks: 3, driftJaccard: 0 });
    expect(moved.some((chapter) => chapter.boundary === "cwd" && chapter.cwd === "/b")).toBe(true);
    const flip = chapters(makeBlocks(16, (index) => ({ cwd: index === 7 || index === 8 ? "/b" : "/a" })), { minBlocks: 3, driftJaccard: 0 });
    expect(flip.some((chapter) => chapter.boundary === "cwd")).toBe(false);
  });

  test("places drift only below the configured Jaccard threshold", () => {
    const before = ["shared", "a", "b", "c", "shared", "a"];
    const after = ["shared", "d", "e", "f", "shared", "d"];
    const events = makeBlocks(12, (index) => ({ file: `src/${(index < 6 ? before[index] : after[index - 6])}.ts` }));
    expect(chapters(events, { driftWindow: 6, driftJaccard: 0.15, minBlocks: 3 }).some((chapter) => chapter.startSeq === 12 && chapter.boundary === "drift")).toBe(true); // 1/7 < .15
    expect(chapters(events, { driftWindow: 6, driftJaccard: 0.14, minBlocks: 3 }).some((chapter) => chapter.startSeq === 12)).toBe(false); // 1/7 > .14
  });

  test("sums Claude Code new tokens and Codex deltas", () => {
    const events = makeBlocks(4);
    for (const event of events) if (event.kind === "assistant") Object.assign((event.raw as any).message, { id: `msg_${event.seq}`, model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 } });
    expect(chapters(events)[0]?.tokens).toBe(56);
    // Claude Code repeats a message's usage on each content-block record: one call
    const copies = events.flatMap((event) => event.kind === "assistant" ? [event, { ...event, seq: event.seq + 0.5 }] : [event]);
    expect(chapters(copies)[0]?.tokens).toBe(56);
    const codexEvents: CarafeEvent[] = [
      ...events.map((event) => ({ ...event, tool: "codex", raw: { type: "event_msg", payload: {} } })),
      { ...events.at(-1)!, seq: 8, tool: "codex", kind: "meta", raw: { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 10, total_tokens: 100 } } } } },
      { ...events.at(-1)!, seq: 9, tool: "codex", kind: "meta", raw: { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 10, total_tokens: 100 } } } } },
      { ...events.at(-1)!, seq: 10, tool: "codex", kind: "meta", raw: { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 145, cached_input_tokens: 100, output_tokens: 20, total_tokens: 165 } } } } },
    ];
    // cumulative readings: the growth (100 + 0 + 65), never the sum of the totals
    expect(chapters(codexEvents)[0]?.tokens).toBe(165);
  });

  test("counts failed runs rather than dead-end moments", () => {
    const events: CarafeEvent[] = [
      cc(0, "user", "2026-01-01T00:00:00Z", "fix it"),
      cc(1, "assistant", "2026-01-01T00:00:01Z", [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }]),
      cc(2, "user", "2026-01-01T00:00:02Z", [{ type: "tool_result", content: "error TS2322", is_error: true }]),
    ];
    const pieces = extractPieces(events, {}, {});
    expect(segmentChapters(events, pieces)[0]?.failures).toBe(1);
  });

  test("minimum block guard rejects squeezed boundaries", () => {
    const result = chapters(makeBlocks(24, (index) => ({ command: index === 4 || index === 12 ? `git switch feat/b${index}` : undefined })), { minBlocks: 8, driftJaccard: 0 });
    expect(result).toHaveLength(2);
    expect(result.every((chapter) => chapter.turns >= 8)).toBe(true);
  });

  test("real-shape scoring caps at 40 while retaining unsqueezed branch boundaries", () => {
    const branchStarts: number[] = [];
    const events = makeBlocks(700, (index) => {
      const branch = index >= 10 && (index - 10) % 27 === 0 && branchStarts.length < 25;
      if (branch) branchStarts.push(index + 1);
      const cwdBand = Math.min(6, Math.floor(index / 100));
      return {
        gapHours: index > 0 && index <= 100 ? 5 : undefined,
        command: branch ? `git switch -c feat/ch-${branchStarts.length}` : undefined,
        cwd: `/repo/${cwdBand}`,
        file: `src/topic-${Math.floor(index / 23) % 31}/file.ts`,
      };
    });
    const result = chapters(events, { minBlocks: 8 });
    expect(result.length).toBeWithin(25, 41);
    expect(result.every((chapter) => chapter.turns >= 8)).toBe(true);
    const starts = new Set(result.map((chapter) => chapter.startSeq / 2));
    for (const start of branchStarts) expect(starts.has(start), `branch at block ${start}`).toBe(true);
    expect(chapterOf(result, result[10]!.startSeq).index).toBe(11);
  });
});
