import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { buildSessionIndex } from "../search/session-index";
import { reflex } from "./reflex";

const sessionId = "reflex-fixture";
let root = "";
let oldHome: string | undefined;

function user(seq: number, message: string): CarafeEvent {
  return { ts: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq, kind: "user", raw: { type: "event_msg", payload: { type: "user_message", message } } };
}
function assistant(seq: number, message: string): CarafeEvent {
  return { ts: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq, kind: "assistant", raw: { type: "event_msg", payload: { type: "agent_message", message } } };
}
function exec(seq: number, cmd: string, output = "Process exited with code 0\nOutput:\nok"): CarafeEvent[] {
  return [
    { ts: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq, kind: "tool_use", raw: { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }), call_id: `c${seq}` } } },
    { ts: `2026-01-01T00:${String(seq + 1).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq: seq + 1, kind: "tool_result", raw: { type: "response_item", payload: { type: "function_call_output", call_id: `c${seq}`, output } } },
  ];
}

export function fixtureSession(store: CarafeStore): { session: SessionDistillate; events: CarafeEvent[] } {
  const events: CarafeEvent[] = [
    user(0, "Start with the auth session handling"),
    assistant(1, "Reading it now."),
    ...exec(2, "sed -n '1,80p' src/auth/session.ts"),
    user(4, "never ever delete anything without prior confirmation, add that to claude md"),
    assistant(5, "Noted."),
    ...exec(6, "sed -n '1,80p' src/auth/service.ts"),
    ...exec(8, "git restore src/auth/service.ts"),
    user(10, "Now look at the export path"),
    assistant(11, "Looking."),
    ...exec(12, "sed -n '1,80p' src/exports/csv.ts"),
    ...exec(14, "bun test src/exports/csv.test.ts"),
    ...exec(16, "sed -n '1,40p' README.md"),
    ...exec(18, "sed -n '1,40p' package.json"),
    ...exec(20, "sed -n '1,40p' src/exports/stream.ts"),
    ...exec(22, "sed -n '1,40p' src/exports/archive.ts"),
    ...exec(24, "sed -n '1,40p' src/exports/zip.ts"),
    ...exec(26, "sed -n '1,40p' src/exports/pdf.ts"),
    user(28, "Ship it to staging"),
    assistant(29, "Deploying."),
    ...exec(30, "npm run deploy:update", "Process exited with code 1\nError: deploy failed: missing STAGING_TOKEN"),
    ...exec(32, "npm run deploy:update", "Process exited with code 1\nError: deploy failed: missing STAGING_TOKEN"),
  ].sort((a, b) => a.seq - b.seq);
  const session: SessionDistillate = { tool: "codex", sessionId, sourcePath: "f.jsonl", title: "reflex fixture", cwd: "/tmp/reflex-project", gitBranch: "main", startTs: events[0]!.ts, endTs: events.at(-1)!.ts, eventCount: events.length, toolUseCount: 12, sidechain: false, rawBytes: 1, version: 1 };
  sealSession(store, session.tool, session.sessionId, events);
  writeDistillate(store, session);
  buildSessionIndex(store, session, events, { force: true });
  return { session, events };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "carafe-reflex-")); oldHome = process.env.CARAFE_HOME; process.env.CARAFE_HOME = root; });
afterEach(() => { if (oldHome === undefined) delete process.env.CARAFE_HOME; else process.env.CARAFE_HOME = oldHome; rmSync(root, { recursive: true, force: true }); });

describe("reflex", () => {
  test("a file the session reverted yields a dead-end pointer with an address, under budget", () => {
    const store = new CarafeStore(root);
    const { session } = fixtureSession(store);
    const result = reflex({ store, session, turnText: "I'm about to change src/auth/service.ts for the new session flow", receiverId: "r1" });
    expect(result.pointers.length).toBeGreaterThan(0);
    const deadend = result.pointers.find((pointer) => pointer.kind === "deadend");
    expect(deadend?.seq).toBe(8);
    expect(deadend?.address).toBe(`carafe show ${sessionId} --seq 8`);
    expect(result.text.length).toBeLessThanOrEqual(600);
    for (const pointer of result.pointers) expect(pointer.line.length).toBeLessThanOrEqual(200);
    expect(result.text).toContain("[carafe reflex ·");
  });

  test("a standing rule fires on overlapping words and acks, empty turns, unknown files stay silent", () => {
    const store = new CarafeStore(root);
    const { session } = fixtureSession(store);
    const rule = reflex({ store, session, turnText: "I'll never delete anything here without asking, just cleaning fixtures", receiverId: "r2" });
    expect(rule.pointers.some((pointer) => pointer.kind === "rule" && pointer.seq === 4)).toBe(true);
    expect(reflex({ store, session, turnText: "ok", receiverId: "r3" }).silentReason).toBe("ack");
    expect(reflex({ store, session, turnText: "hm", receiverId: "r3" }).silentReason).toBe("turn-too-short");
    expect(reflex({ store, session, turnText: "what's the plan for today?", receiverId: "r3" }).silentReason).toBe("no-entities");
    expect(reflex({ store, session, turnText: "please look at src/reports/summary.ts first", receiverId: "r3" }).pointers).toEqual([]);
  });

  test("suppression is per receiver and per entity; the tail is never pointed into", () => {
    const store = new CarafeStore(root);
    const { session } = fixtureSession(store);
    const first = reflex({ store, session, turnText: "src/auth/service.ts keeps failing for me", receiverId: "same" });
    expect(first.pointers.length).toBeGreaterThan(0);
    const again = reflex({ store, session, turnText: "src/auth/service.ts keeps failing for me", receiverId: "same" });
    expect(again.pointers).toEqual([]);
    expect(again.silentReason).toBe("suppressed");
    const other = reflex({ store, session, turnText: "src/auth/service.ts keeps failing for me", receiverId: "other" });
    expect(other.pointers.length).toBeGreaterThan(0);
    const tail = reflex({ store, session, turnText: "src/auth/service.ts keeps failing for me", receiverId: "tail", tailStartSeq: 0 });
    expect(tail.pointers).toEqual([]);
    expect(tail.silentReason).toBe("inside-tail");
  });

  test("k caps the number of pointers", () => {
    const store = new CarafeStore(root);
    const { session } = fixtureSession(store);
    const result = reflex({ store, session, turnText: "revisit src/auth/service.ts and src/auth/session.ts and src/exports/csv.ts", receiverId: "k", k: 1 });
    expect(result.pointers).toHaveLength(1);
  });

  test("a distinctive script name alone resolves to its command family", () => {
    const store = new CarafeStore(root);
    const { session } = fixtureSession(store);
    const result = reflex({ store, session, turnText: "deploy:update keeps failing again, what happened last time?", receiverId: "script" });
    expect(result.pointers.length).toBeGreaterThan(0);
    expect(result.pointers[0]?.entity).toBe("npm run deploy:update");
    expect(result.pointers[0]?.seq).toBeGreaterThanOrEqual(28);
    // "build" and "test" are ordinary words: never entities on their own.
    expect(reflex({ store, session, turnText: "the build is slow today", receiverId: "script-2" }).pointers).toEqual([]);
  });

  test("a second pointer for an entity is only ever a dead end, decision, breakthrough or rule", () => {
    const store = new CarafeStore(root);
    const { session } = fixtureSession(store);
    for (const [index, turnText] of ["src/auth/service.ts keeps failing for me", "why did we go this way in src/auth/session.ts", "deploy:update keeps failing"].entries()) {
      const result = reflex({ store, session, turnText, receiverId: `second-${index}`, k: 3 });
      const perEntity = new Map<string, string[]>();
      for (const pointer of result.pointers) perEntity.set(pointer.entity, [...(perEntity.get(pointer.entity) ?? []), pointer.kind]);
      for (const kinds of perEntity.values()) for (const kind of kinds.slice(1)) expect(["deadend", "decision", "breakthrough", "rule"]).toContain(kind);
    }
  });
});
