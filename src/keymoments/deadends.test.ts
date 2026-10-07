import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { detectDeadends } from "./deadends";

const sid = "deadends-test";

function row(seq: number, kind: string, line: string, raw: unknown = {}): [CarafeEvent, EventPieces] {
  const ts = `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`;
  return [{ seq, kind, raw, sessionId: sid, tool: "claude-code", ts }, { seq, kind, lines: [line], chars: line.length, ts }];
}

const user = (seq: number, text: string) => row(seq, "user", `**user:** ${text}`);
const result = (seq: number, text: string) => row(seq, "tool_result", `  ⤷ ${text}`);
function shell(seq: number, command: string, tool = "Bash") {
  const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: tool, input: { command } }] } };
  return row(seq, "tool_use", `→ **${tool}** {"command":"${command}"}`, raw);
}
function edit(seq: number, path: string, tool: "Edit" | "Write" = "Edit") {
  const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: tool, input: { file_path: path } }] } };
  return row(seq, "tool_use", `→ **${tool}** {"file_path":"${path}"}`, raw);
}
function codexPatch(seq: number, path: string) {
  const patch = `*** Begin Patch\n*** Add File: ${path}\n@@\n+temporary\n*** End Patch`;
  const item = row(seq, "tool_use", `→ **apply_patch** ${JSON.stringify({ input: patch })}`, { type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: patch }) } });
  item[0].tool = "codex";
  return item;
}
function input(rows: Array<[CarafeEvent, EventPieces]>) {
  return { events: rows.map(([event]) => event), pieces: rows.map(([, piece]) => piece) };
}

describe("detectDeadends", () => {
  test("detects an abandoned failing streak anywhere in the turn", () => {
    const trace = input([user(0, "fix it"), edit(1, "src/a.ts"), result(2, "updated"), shell(3, "bun test"), result(4, "error TS2322: bad type"), edit(5, "src/a.ts"), result(6, "updated"), shell(7, "bun test"), result(8, "error TS2322: still bad")]);
    const deadend = detectDeadends(trace.events, trace.pieces).find((moment) => moment.note?.includes("still bad"));
    expect(deadend).toMatchObject({ kind: "deadend", seq: 3, endSeq: 8 });
    expect(deadend?.text).toContain("bun test");
  });

  test("ignores error text returned by a read-ish tool", () => {
    const trace = input([user(0, "read the log"), shell(1, "sed -n '1,20p' logs/build.log", "exec_command"), result(2, "src/a.ts: error TS2322"), shell(3, "sed -n '1,20p' logs/build.log", "exec_command"), result(4, "src/a.ts: error TS2322")]);
    expect(detectDeadends(trace.events, trace.pieces)).toEqual([]);
  });

  test("does not call a single failure fixed quickly a dead end", () => {
    const trace = input([user(0, "fix it"), shell(1, "bun test"), result(2, "error TS2322: bad type"), edit(3, "src/a.ts"), result(4, "updated"), shell(5, "bun test"), result(6, "0 failed; exited with code 0")]);
    expect(detectDeadends(trace.events, trace.pieces)).toEqual([]);
  });

  test("a failing streak followed by success is not a dead end", () => {
    const trace = input([user(0, "fix it"), edit(1, "src/a.ts"), result(2, "updated"), shell(3, "bun test"), result(4, "error TS2322"), shell(5, "bun test"), result(6, "error TS2322"), edit(7, "src/a.ts"), result(8, "updated"), shell(9, "bun test"), result(10, "0 failed; exited with code 0")]);
    expect(detectDeadends(trace.events, trace.pieces).filter((moment) => moment.seq === 3)).toEqual([]);
  });

  test("unrelated later edits to the same file do not erase an abandoned streak", () => {
    const trace = input([
      user(0, "fix it"), edit(1, "src/a.ts"), result(2, "updated"),
      shell(3, "bun test"), result(4, "error TS2322: bad type"),
      shell(5, "bun test"), result(6, "error TS2322: still bad"),
      user(7, "now update the copy"), edit(8, "src/a.ts"), result(9, "updated copy"),
    ]);
    expect(detectDeadends(trace.events, trace.pieces)).toContainEqual(expect.objectContaining({ kind: "deadend", seq: 3, endSeq: 6 }));
  });

  test("detects work later removed, but not work committed first", () => {
    const removed = input([user(0, "try it"), edit(1, "src/temp.ts", "Write"), result(2, "wrote"), shell(3, "git rm src/temp.ts"), result(4, "removed")]);
    expect(detectDeadends(removed.events, removed.pieces)).toContainEqual(expect.objectContaining({ seq: 1, endSeq: 2, note: "removed at seq 3" }));

    const committed = input([user(0, "try it"), edit(1, "src/temp.ts", "Write"), result(2, "wrote"), shell(3, "git commit -m keep"), result(4, "committed"), shell(5, "git reset --hard HEAD~1"), result(6, "reset")]);
    expect(detectDeadends(committed.events, committed.pieces).some((moment) => moment.seq === 1)).toBe(false);
  });

  test("groups contiguous Codex apply_patch writes removed by one git rm -q", () => {
    const trace = input([
      user(0, "try it"), codexPatch(1, "src/a.ts"), result(2, "Done!"),
      codexPatch(3, "src/b.ts"), result(4, "Done!"), codexPatch(5, "src/c.ts"), result(6, "Done!"),
      shell(7, "git rm -q src/a.ts src/b.ts src/c.ts", "exec_command"), result(8, "removed"),
    ]);
    expect(detectDeadends(trace.events, trace.pieces)).toContainEqual(expect.objectContaining({ kind: "deadend", seq: 1, endSeq: 6, note: "removed at seq 7" }));
  });

  test("does not treat a file rewritten from a later turn as a dead end", () => {
    const trace = input([user(0, "try it"), edit(1, "src/temp.ts", "Write"), result(2, "wrote"), user(3, "replace it"), edit(4, "src/temp.ts", "Write"), result(5, "rewrote")]);
    expect(detectDeadends(trace.events, trace.pieces)).toEqual([]);
  });

  test("stash plus pop is housekeeping; an unpopped stash is a reversal", () => {
    const housekeeping = input([user(0, "hold it"), shell(1, "git stash push -m hold"), result(2, "saved"), shell(3, "git stash pop"), result(4, "applied")]);
    expect(detectDeadends(housekeeping.events, housekeeping.pieces)).toEqual([]);

    const unpopped = input([user(0, "hold it"), shell(1, "git stash push -m hold"), result(2, "saved")]);
    expect(detectDeadends(unpopped.events, unpopped.pieces)).toContainEqual(expect.objectContaining({ seq: 1, note: "explicit reversal" }));
  });
});
