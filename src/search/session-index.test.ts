import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSearch } from "../cli/search";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { runHandoff } from "../handoff/handoff";
import { runKeyMoments } from "../keymoments/keymoments";
import { SessionIndex } from "./session-index";

let root = "";
let oldHome: string | undefined;
const sessionId = "session-recall-test";

function event(seq: number, kind: string, message: string): CarafeEvent {
  return { ts: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`, tool: "codex", sessionId, seq, kind, raw: { payload: { message } } };
}

function capture(fn: () => void): string {
  const output: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try { fn(); } finally { console.log = log; }
  return output.join("\n");
}

function fixtureDistillate(events: CarafeEvent[]): SessionDistillate {
  return {
    tool: "codex", sessionId, sourcePath: "fixture.jsonl", title: "recall fixture",
    cwd: "/tmp/project", gitBranch: "main", startTs: events[0]!.ts, endTs: events.at(-1)!.ts,
    eventCount: events.length, toolUseCount: 0, sidechain: false, rawBytes: 1, version: 1,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-session-index-"));
  oldHome = process.env.CARAFE_HOME;
  process.env.CARAFE_HOME = root;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CARAFE_HOME;
  else process.env.CARAFE_HOME = oldHome;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("session-scoped search", () => {
  test("ranks a matching middle turn, creates its index, and rebuilds on eventCount change", () => {
    const events = [
      event(0, "user", "Inspect the existing queue worker"),
      event(1, "assistant", "I will read the worker first."),
      event(10, "user", "Add retry policy to the queue worker"),
      event(11, "assistant", "Use exponential backoff with jitter for transient failures."),
      event(12, "assistant", "The focused retry tests pass."),
      event(20, "user", "Now review the unrelated export path"),
    ];
    const store = new CarafeStore(root);
    const d = fixtureDistillate(events);
    sealSession(store, d.tool, d.sessionId, events);
    writeDistillate(store, d);

    const output = capture(() => runSearch("exponential jitter", { session: sessionId }));
    expect(output.split("\n")[0]).toStartWith("[seq 10–19]  Add retry policy to the queue worker");
    expect(output).toContain(`read one: carafe show ${sessionId} --seq 10-19`);
    const indexPath = join(root, "state", "session-index", "codex", `${sessionId}.sqlite`);
    expect(existsSync(indexPath)).toBe(true);

    const unchanged = new SessionIndex(store, d);
    const db = new Database(indexPath);
    db.run(`INSERT INTO meta (key, value) VALUES ('probe', 'unchanged')`);
    db.close();
    expect(unchanged.reindex().rebuilt).toBe(false);
    unchanged.close();
    const after = new Database(indexPath, { readonly: true });
    expect(after.query(`SELECT value FROM meta WHERE key = 'probe'`).get()).toEqual({ value: "unchanged" });
    after.close();

    const appended = [...events, event(30, "assistant", "One appended event makes the materialized session stale.")];
    const changed = { ...d, eventCount: appended.length, endTs: appended.at(-1)!.ts };
    sealSession(store, changed.tool, changed.sessionId, appended);
    writeDistillate(store, changed);
    const stale = new SessionIndex(store, changed);
    expect(stale.reindex().rebuilt).toBe(true);
    stale.close();
  });

  test("punctuation and partial matches never raise FTS syntax errors", () => {
    const events = [
      event(0, "user", "Inspect the existing queue worker"),
      event(1, "assistant", "Use exponential backoff with jitter for transient failures."),
      event(10, "user", "Now review the unrelated export path"),
    ];
    const store = new CarafeStore(root);
    const d = fixtureDistillate(events);
    sealSession(store, d.tool, d.sessionId, events);
    writeDistillate(store, d);
    const index = new SessionIndex(store, d);
    index.reindex();
    // Quotes, parentheses, a bare dash, and NOT would all be FTS5 syntax unquoted.
    expect(() => index.search(`don't "jitter" (retry) - NOT timeout:x`)).not.toThrow();
    expect(index.search(`jitter (retry) - "backoff"`).map((h) => h.startSeq)).toEqual([0]);
    // Every term first (AND); when nothing carries all of them, any of them (OR).
    expect(index.search("jitter nonexistentterm").map((h) => h.startSeq)).toEqual([0]);
    expect(index.search("nonexistentterm")).toEqual([]);
    expect(index.search("- ( )")).toEqual([]);
    index.close();
  });

  test("handoff and key-moments arm the per-session index as a side effect", async () => {
    const store = new CarafeStore(root);
    const events = [event(0, "user", "Inspect the queue"), event(1, "assistant", "The queue is ready.")];
    const handoff = fixtureDistillate(events);
    sealSession(store, handoff.tool, handoff.sessionId, events);
    writeDistillate(store, handoff);
    const secondId = `${sessionId}-moments`;
    const secondEvents = events.map((item) => ({ ...item, sessionId: secondId }));
    const moments = { ...fixtureDistillate(secondEvents), sessionId: secondId };
    sealSession(store, moments.tool, moments.sessionId, secondEvents);
    writeDistillate(store, moments);
    const log = console.log;
    console.log = () => {};
    try {
      await runHandoff(handoff.sessionId);
      await runKeyMoments(moments.sessionId);
    } finally { console.log = log; }
    expect(existsSync(join(root, "state", "session-index", "codex", `${handoff.sessionId}.sqlite`))).toBe(true);
    expect(existsSync(join(root, "state", "session-index", "codex", `${moments.sessionId}.sqlite`))).toBe(true);
  });

  test("an unknown --session id fails with the standard message", () => {
    const cli = join(import.meta.dir, "..", "cli", "index.ts");
    const result = Bun.spawnSync([process.execPath, "run", cli, "search", "--session", "missing-session", "retry"], {
      env: { ...process.env, CARAFE_HOME: root, CARAFE_NO_UPDATE_CHECK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("session not found: missing-session");
  });
});
