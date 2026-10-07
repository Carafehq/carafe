import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { SessionIndex } from "./session-index";

const sessionId = "ask-files";
let root = "";
let oldHome: string | undefined;

function user(seq: number, message: string): CarafeEvent {
  return { ts: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq, kind: "user", raw: { type: "event_msg", payload: { type: "user_message", message } } };
}
function assistant(seq: number, message: string): CarafeEvent {
  return { ts: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq, kind: "assistant", raw: { type: "event_msg", payload: { type: "agent_message", message } } };
}
function read(seq: number, path: string): CarafeEvent[] {
  return [
    { ts: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq, kind: "tool_use", raw: { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `sed -n '1,80p' ${path}` }), call_id: `c${seq}` } } },
    { ts: `2026-01-01T00:${String(seq + 1).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq: seq + 1, kind: "tool_result", raw: { type: "response_item", payload: { type: "function_call_output", call_id: `c${seq}`, output: "Process exited with code 0\nOutput:\nexport const x = 1;" } } },
  ];
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "carafe-ask-files-")); oldHome = process.env.CARAFE_HOME; process.env.CARAFE_HOME = root; });
afterEach(() => { if (oldHome === undefined) delete process.env.CARAFE_HOME; else process.env.CARAFE_HOME = oldHome; rmSync(root, { recursive: true, force: true }); });

describe("carafe ask --file", () => {
  test("a user turn's files link its moments, and a file with no moment falls back to its turns", () => {
    // Nine tool calls follow the session-start read, so that read is outside the
    // last-eight "work in flight" window and no moment of any kind covers it.
    const events: CarafeEvent[] = [
      ...read(0, "src/boot/init.ts"),
      user(2, "Start with the auth session handling"),
      assistant(3, "Reading it now."),
      ...read(4, "src/auth/session.ts"), ...read(6, "src/auth/cookies.ts"), ...read(8, "src/auth/permissions.ts"),
      user(10, "stop — don't touch the migrations, do it in the auth service layer"),
      assistant(11, "Understood."),
      ...read(12, "src/auth/service.ts"), ...read(14, "src/auth/service.test.ts"), ...read(16, "src/auth/routes.ts"),
      user(18, "Now look at the export path"),
      assistant(19, "Looking."),
      ...read(20, "src/exports/csv.ts"), ...read(22, "src/exports/stream.ts"), ...read(24, "src/exports/archive.ts"),
    ].sort((a, b) => a.seq - b.seq);
    const store = new CarafeStore(root);
    const d: SessionDistillate = { tool: "codex", sessionId, sourcePath: "f.jsonl", title: "ask files", cwd: "/tmp/p", gitBranch: "main", startTs: events[0]!.ts, endTs: events.at(-1)!.ts, eventCount: events.length, toolUseCount: 3, sidechain: false, rawBytes: 1, version: 1 };
    sealSession(store, d.tool, d.sessionId, events);
    writeDistillate(store, d);
    const index = new SessionIndex(store, d);
    index.reindex({ events });

    // The steering turn at seq 10 read src/auth/service.ts: the moment links to it,
    // and so does the routine turn at seq 18 for csv.ts (every user turn is a moment).
    const steering = index.ask({ file: "service.ts" });
    expect(steering.some((row) => row.type === "moment" && row.seq === 10)).toBe(true);
    expect(index.ask({ file: "csv.ts" }).some((row) => row.type === "moment" && row.seq === 18)).toBe(true);

    // init.ts was only read before the first user turn — no moment can cover it —
    // so the session-start turn itself answers.
    const turns = index.ask({ file: "init.ts" });
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((row) => row.type === "turn")).toBe(true);
    expect(turns[0]?.seq).toBe(0);
    expect(turns[0]?.text).toContain("session start");

    expect(index.ask({ file: "nowhere.ts" })).toEqual([]);
    index.close();
  });
});
