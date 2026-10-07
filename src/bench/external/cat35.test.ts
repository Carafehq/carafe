import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCat35, type Cat35Gold } from "./cat35";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function line(type: "user" | "assistant", text: string, index: number): string {
  return JSON.stringify({
    type, sessionId: "cat35-fixture", uuid: `${type}-${index}`,
    timestamp: `2026-08-01T00:00:0${index}.000Z`, cwd: "/repo", isSidechain: false,
    message: type === "user" ? { content: text } : { role: "assistant", content: [{ type: "text", text }], usage: {} },
  });
}

function writeSession(root: string, id: string, transcript: string[], gold: Cat35Gold): void {
  writeFileSync(join(root, "transcripts", `2026-08-01-${id}.jsonl`), `${transcript.join("\n")}\n`);
  writeFileSync(join(root, "gold", `${id}.json`), `${JSON.stringify(gold)}\n`);
}

describe("Cat 35 mechanical lane", () => {
  test("scores a tiny two-transcript fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "carafe-cat35-")); roots.push(root);
    mkdirSync(join(root, "transcripts")); mkdirSync(join(root, "gold"));
    writeSession(root, "found", [line("user", "Use SQLite. CI was crawling this morning.", 0)], {
      transcript_id: "found", scenario: "fixture",
      items: [{ item_id: "i-found", kind: "decision", statement: "Use SQLite", verbatim_anchor: "Use SQLite", planted_turn: 0, depth_bucket: "early" }],
      distractors: [{ distractor_id: "d-leak", anchor: "CI was crawling this morning", planted_turn: 0 }],
      hazards: [{ hazard_id: "h-safe", type: "attribution", wrong_claim: "The user chose Postgres", anchor: "Use SQLite", planted_turn: 0 }],
    });
    writeSession(root, "missed", [line("user", "Investigate the retry path.", 0), line("assistant", "The cache key stayed stale.", 1)], {
      transcript_id: "missed", scenario: "fixture",
      items: [{ item_id: "i-missed", kind: "fact", statement: "The cache key stayed stale", verbatim_anchor: "cache key stayed stale", planted_turn: 1, depth_bucket: "late" }],
      distractors: [], hazards: [],
    });

    const score = runCat35(root, [20_000]);
    expect(score).toMatchObject({ sessions: 2, items: 2, distractors: 1, candidateAnchor: 1 });
    expect(score.byBudget[20_000]).toEqual({ anchor: 1, turn: 1, junk: 1, wrongClaims: 0 });
  });
});
