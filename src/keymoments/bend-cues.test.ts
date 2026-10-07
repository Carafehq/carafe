import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { detectBends, hasContrastiveChoice } from "./bend";

function turn(seq: number, kind: "user" | "assistant", text: string): { event: CarafeEvent; piece: EventPieces } {
  const line = `**${kind}:** ${text}`;
  return {
    event: { ts: `2026-03-02T09:${String(seq).padStart(2, "0")}:00.000Z`, tool: "codex", sessionId: "cues", seq, kind, raw: { payload: {} } },
    piece: { seq, kind, lines: [line], chars: line.length, ts: null },
  };
}

function bends(...turns: Array<{ event: CarafeEvent; piece: EventPieces }>) {
  return detectBends(turns.map((t) => t.event), turns.map((t) => t.piece), 0);
}

describe("proposal cues", () => {
  test("'I'd proceed with …; is that the direction?' is a proposal an approval can lock", () => {
    const moments = bends(turn(0, "user", "build it"), turn(1, "assistant", "I’d proceed with the checksum guard; is that the direction?"), turn(2, "user", "yes"));
    const decision = moments.find((m) => m.kind === "decision");
    expect(decision?.seq).toBe(1);
    expect(decision?.text).toContain("checksum guard");
  });

  test("a pasted log line with a cue inside is not a proposal", () => {
    const moments = bends(turn(0, "user", "build it"), turn(1, "assistant", "3:31:24 PM: build-image version: ac6eb13 — should I retry? logged by the platform"), turn(2, "user", "ok"));
    expect(moments.filter((m) => m.kind === "decision")).toEqual([]);
  });

  test("a user turn that pastes a log is never a decision, even with cue words", () => {
    const moments = bends(turn(0, "user", "build it"), turn(1, "assistant", "I recommend the retry path; shall I proceed?"), turn(2, "user", "3:31:24 PM: build-image version: ac6eb13 (noble) — pick option a, decided"));
    expect(moments.filter((m) => m.kind === "decision")).toEqual([]);
    expect(moments.some((m) => m.kind === "ask" && m.seq === 2)).toBe(true);
  });

  test("a question that proposes nothing does not turn 'ok' into a decision", () => {
    const moments = bends(turn(0, "user", "build it"), turn(1, "assistant", "Anything else you want to push on?"), turn(2, "user", "ok let's think about this a little"));
    expect(moments.filter((m) => m.kind === "decision")).toEqual([]);
  });
});

describe("contrastive choices", () => {
  for (const text of [
    "Let's go with Redis instead of memory.",
    "We'll use Postgres rather than SQLite.",
    "Decision: JWT over session cookies.",
    "Switch to webhooks, polling isn't worth it.",
    "Going with streaming and dropping buffering.",
  ]) {
    test(`is a decision without a file bend: ${text}`, () => {
      expect(hasContrastiveChoice(text)).toBe(true);
      expect(bends(turn(0, "user", "build it"), turn(1, "user", text))).toContainEqual(expect.objectContaining({ kind: "decision", seq: 1 }));
    });
  }

  test("a weak preference still needs a bend", () => {
    expect(hasContrastiveChoice("I prefer tabs")).toBe(false);
    expect(bends(turn(0, "user", "build it"), turn(1, "user", "I prefer tabs"))).toContainEqual(expect.objectContaining({ kind: "ask", seq: 1 }));
  });

  test("a refusal is never a decision", () => {
    const moments = bends(turn(0, "user", "build it"), turn(1, "user", "Don't switch to Redis, memory isn't worth dropping yet."));
    expect(moments.some((moment) => moment.kind === "decision")).toBe(false);
  });
});

describe("assistant options answered in chat", () => {
  for (const reply of ["SQLite, please.", "Use Postgres.", "Go with the file-backed retry log."]) {
    test(`locks the matching option from: ${reply}`, () => {
      const moments = bends(
        turn(0, "user", "build it"),
        turn(1, "assistant", "Which storage should carry the retry state? Options: Postgres, SQLite, a file-backed retry log."),
        turn(2, "user", reply),
      );
      const decision = moments.find((moment) => moment.kind === "decision");
      expect(decision).toMatchObject({ seq: 1, endSeq: 2 });
      expect(decision?.text).toContain("Which storage should carry the retry state?");
    });
  }

  test("a reply naming none of the options remains steering", () => {
    const moments = bends(
      turn(0, "user", "build it"),
      turn(1, "assistant", "Which storage should carry the retry state? Options: Postgres, SQLite, a file-backed retry log."),
      turn(2, "user", "Investigate the operational cost first."),
    );
    expect(moments.some((moment) => moment.kind === "decision")).toBe(false);
    expect(moments).toContainEqual(expect.objectContaining({ kind: "ask", seq: 2 }));
  });
});
