import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { detectBends } from "./bend";

const sid = "bend-test";

function event(seq: number, kind: string, raw: unknown = {}): CarafeEvent {
  return { seq, kind, raw, sessionId: sid, tool: "claude-code", ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z` };
}

function piece(seq: number, kind: string, line: string): EventPieces {
  return { seq, kind, lines: [line], chars: line.length, ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z` };
}

function user(seq: number, text: string): [CarafeEvent, EventPieces] {
  return [event(seq, "user"), piece(seq, "user", `**user:** ${text}`)];
}

function assistant(seq: number, text: string): [CarafeEvent, EventPieces] {
  return [event(seq, "assistant"), piece(seq, "assistant", `**assistant:** ${text}`)];
}

function edit(seq: number, path: string): [CarafeEvent, EventPieces] {
  const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path } }] } };
  return [event(seq, "tool_use", raw), piece(seq, "tool_use", `→ **Edit** {"file_path":"${path}"}`)];
}

function unzip(rows: Array<[CarafeEvent, EventPieces]>): { events: CarafeEvent[]; pieces: EventPieces[] } {
  return { events: rows.map(([ev]) => ev), pieces: rows.map(([, rendered]) => rendered) };
}

describe("detectBends", () => {
  test("classifies a freetext choice across a file-set bend as a decision", () => {
    const input = unzip([
      user(0, "build it"), edit(1, "src/old/a.ts"), edit(2, "src/old/b.ts"),
      user(3, "inspect the old path"), edit(4, "src/old/c.ts"),
      user(5, "Let's go with Redis instead of memory."), edit(6, "src/new/x.ts"),
      user(7, "implement the new path"), edit(8, "src/new/y.ts"),
    ]);
    const decision = detectBends(input.events, input.pieces, 0).find((moment) => moment.kind === "decision");
    expect(decision?.seq).toBe(5);
    expect(decision?.text).toContain("Redis instead of memory");
    expect(decision?.note).toBe("trajectory changed");
  });

  test("records an approval on the proposal span without requiring a bend", () => {
    const input = unzip([user(0, "build it"), assistant(1, "I'd recommend the checksum guard; shall I proceed?"), user(2, "yes, go ahead")]);
    const decision = detectBends(input.events, input.pieces, 0).find((moment) => moment.kind === "decision");
    expect(decision).toMatchObject({ seq: 1, endSeq: 2, kind: "decision" });
    expect(decision?.text).toContain("checksum guard");
  });

  test("a refusal after a proposal is steering, never a decision", () => {
    const input = unzip([user(0, "build it"), assistant(1, "I suggest replacing the parser. Should I do that?"), user(2, "no — keep the parser")]);
    const moments = detectBends(input.events, input.pieces, 0);
    expect(moments.some((moment) => moment.kind === "decision")).toBe(false);
    expect(moments).toContainEqual(expect.objectContaining({ kind: "ask", seq: 2 }));
  });

  test("drops acknowledgement-only turns", () => {
    const input = unzip([user(0, "build it"), user(1, "ok"), user(2, "👍")]);
    expect(detectBends(input.events, input.pieces, 0)).toEqual([]);
  });

  test("keeps a generic question response as an ask, not a decision", () => {
    const input = unzip([user(0, "build it"), assistant(1, "Anything else you want to push on?"), user(2, "ok let's think about this")]);
    const moments = detectBends(input.events, input.pieces, 0);
    expect(moments.some((moment) => moment.kind === "decision")).toBe(false);
    expect(moments).toContainEqual(expect.objectContaining({ kind: "ask", seq: 2 }));
  });

  test("does not treat suggests as the suggest proposal cue", () => {
    const input = unzip([user(0, "build it"), assistant(1, "This strongly suggests the same operator."), user(2, "yes")]);
    expect(detectBends(input.events, input.pieces, 0)).toEqual([]);
  });
});
