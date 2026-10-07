import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { detectRules } from "./rules";

function trace(users: string[]) {
  const events: CarafeEvent[] = [];
  const pieces: EventPieces[] = [];
  for (const [index, text] of users.entries()) {
    const ts = `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`;
    events.push({ seq: index, kind: "user", raw: {}, sessionId: "rules-test", tool: "codex", ts });
    const line = `**user:** ${text}`;
    pieces.push({ seq: index, kind: "user", lines: [line], chars: line.length, ts });
  }
  return { events, pieces };
}

describe("detectRules", () => {
  test("groups three near-identical restatements into one verbatim rule", () => {
    const input = trace([
      "Never edit the generated client by hand.",
      "Please never edit generated client by hand!",
      "Never edit the generated client by hand — regenerate it.",
    ]);
    expect(detectRules(input.events, input.pieces)).toEqual([{
      kind: "rule",
      seq: 0,
      endSeq: 2,
      text: "Never edit the generated client by hand",
      note: "restated ×3 (seq 0, 1, 2)",
    }]);
  });

  test("does not emit a one-off rule or acknowledgement", () => {
    const input = trace(["Always run the checksum before committing.", "ok", "sounds good", "k, next", "thanks, carry on", "looks good, go on", "Please inspect the migration."]);
    expect(detectRules(input.events, input.pieces)).toEqual([]);
  });

  test("accepts an explicitly labelled repeated rule", () => {
    const input = trace(["Rule: keep generated output untouched.", "Rule: keep generated output untouched."]);
    expect(detectRules(input.events, input.pieces)[0]).toMatchObject({ kind: "rule", seq: 0, endSeq: 1 });
  });

  test("does not turn lack of understanding or rhetorical criticism into rules", () => {
    const input = trace([
      "I don't get it can you explain this again",
      "I don't get it can you explain this again",
      "Why don't you read the codebase properly",
      "Why don't you read the codebase properly",
    ]);
    expect(detectRules(input.events, input.pieces)).toEqual([]);
  });

  test("keeps a repeated imperative prohibition", () => {
    const input = trace([
      "Never delete anything without prior confirmation.",
      "Never delete anything without prior confirmation.",
      "Never delete anything without prior confirmation.",
    ]);
    expect(detectRules(input.events, input.pieces)).toEqual([expect.objectContaining({ kind: "rule", seq: 0, endSeq: 2 })]);
  });
});
