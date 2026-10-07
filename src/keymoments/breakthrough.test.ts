import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { detectBreakthroughs } from "./breakthrough";

const sid = "breakthrough-test";
function row(seq: number, kind: string, line: string, raw: unknown = {}): [CarafeEvent, EventPieces] {
  const ts = `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`;
  return [{ seq, kind, raw, sessionId: sid, tool: "claude-code", ts }, { seq, kind, lines: [line], chars: line.length, ts }];
}
const user = (seq: number, text: string) => row(seq, "user", `**user:** ${text}`);
const assistant = (seq: number, text: string) => row(seq, "assistant", `**assistant:** ${text}`);
const result = (seq: number, text: string) => row(seq, "tool_result", `  ⤷ ${text}`);
function shell(seq: number, command: string) {
  const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } };
  return row(seq, "tool_use", `→ **Bash** {"command":"${command}"}`, raw);
}
function edit(seq: number, path: string) {
  const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path } }] } };
  return row(seq, "tool_use", `→ **Edit** {"file_path":"${path}"}`, raw);
}
function input(rows: Array<[CarafeEvent, EventPieces]>) { return { events: rows.map(([event]) => event), pieces: rows.map(([, piece]) => piece) }; }

describe("detectBreakthroughs", () => {
  test("anchors a red-to-green streak on the final edit and its preceding explanation", () => {
    const trace = input([user(0, "fix it"), edit(1, "src/a.ts"), result(2, "updated"), shell(3, "bun test"), result(4, "error TS2322"), shell(5, "bun test"), result(6, "error TS2322"), assistant(7, "The missing await is the root cause."), edit(8, "src/a.ts"), result(9, "updated"), shell(10, "bun test"), result(11, "0 failed; exited with code 0")]);
    const moment = detectBreakthroughs(trace.events, trace.pieces)[0];
    expect(moment).toMatchObject({ kind: "breakthrough", seq: 8, endSeq: 11, note: "after 2 failed runs of bun test" });
    expect(moment?.text).toContain("missing await");
    expect(moment?.text).toContain("src/a.ts");
  });

  test("requires at least two failures and a success before the next user turn", () => {
    const oneFailure = input([user(0, "fix it"), shell(1, "bun test"), result(2, "error TS2322"), edit(3, "src/a.ts"), result(4, "updated"), shell(5, "bun test"), result(6, "0 failed")]);
    expect(detectBreakthroughs(oneFailure.events, oneFailure.pieces)).toEqual([]);

    const crossedTurn = input([user(0, "fix it"), shell(1, "bun test"), result(2, "error TS2322"), shell(3, "bun test"), result(4, "error TS2322"), user(5, "continue"), shell(6, "bun test"), result(7, "0 failed")]);
    expect(detectBreakthroughs(crossedTurn.events, crossedTurn.pieces)).toEqual([]);
  });

  test("ignores failure streaks from git and gh command families", () => {
    const trace = input([user(0, "stage it"), shell(1, "git add ."), result(2, "Exit code 1"), shell(3, "git add ."), result(4, "Exit code 1"), shell(5, "git add ."), result(6, "staged")]);
    expect(detectBreakthroughs(trace.events, trace.pieces)).toEqual([]);
  });
});
