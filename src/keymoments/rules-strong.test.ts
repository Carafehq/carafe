import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { detectRules } from "./rules";

function turn(seq: number, kind: "user" | "assistant", text: string): { event: CarafeEvent; piece: EventPieces } {
  const line = `**${kind}:** ${text}`;
  return {
    event: { ts: null, tool: "claude-code", sessionId: "rules", seq, kind, raw: {} },
    piece: { seq, kind, lines: [line], chars: line.length, ts: null },
  };
}

function rules(...turns: Array<{ event: CarafeEvent; piece: EventPieces }>) {
  return detectRules(turns.map((t) => t.event), turns.map((t) => t.piece));
}

describe("standing rules stated once", () => {
  test("an emphatic single statement with a standing marker is a rule", () => {
    const found = rules(turn(0, "user", "start"), turn(1, "assistant", "ok"), turn(2, "user", "never ever delete anything without prior confirmation even locally, add that to claude md"), turn(3, "assistant", "noted"), turn(4, "user", "now fix the build"));
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("never ever delete anything");
    expect(found[0]?.note).toBe("stated as a standing rule");
    expect(found[0]?.endSeq).toBeUndefined();
  });

  test("a plain one-off 'don't' is still not a rule", () => {
    expect(rules(turn(0, "user", "start"), turn(1, "assistant", "ok"), turn(2, "user", "don't touch the migrations for this one, do it in the service layer"))).toEqual([]);
  });
});
