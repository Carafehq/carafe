import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCorpus } from "../bench/corpus";
import { reflexGoldTurns } from "../bench/reflex/cases";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { buildSessionIndex, sessionIndexPath } from "../search/session-index";
import { fixtureSession } from "./reflex.test";
import { reflex } from "./reflex";
import { armReflex, sessionsForCwd } from "./state";

let root = "";
let oldHome: string | undefined;

function cloneSession(store: CarafeStore, base: { session: SessionDistillate; events: CarafeEvent[] }, id: string, opts: { cwd?: string; day?: number; events?: CarafeEvent[] } = {}): { session: SessionDistillate; events: CarafeEvent[] } {
  const day = opts.day ?? 1;
  const sourceEvents = opts.events ?? base.events;
  const events = sourceEvents.map((event) => ({ ...event, sessionId: id, ts: event.ts?.replace("2026-01-01", `2026-01-${String(day).padStart(2, "0")}`) ?? null }));
  const session: SessionDistillate = {
    ...base.session, sessionId: id, internalSessionId: undefined, sourcePath: `${id}.jsonl`, cwd: opts.cwd ?? base.session.cwd,
    startTs: events[0]?.ts ?? null, endTs: events.at(-1)?.ts ?? null, eventCount: events.length,
  };
  sealSession(store, session.tool, id, events);
  writeDistillate(store, session);
  buildSessionIndex(store, session, events, { force: true });
  return { session, events };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-reflex-project-"));
  oldHome = process.env.CARAFE_HOME;
  process.env.CARAFE_HOME = root;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CARAFE_HOME; else process.env.CARAFE_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

describe("project reflex", () => {
  test("a dead end in an older session answers for the shared cwd", () => {
    const store = new CarafeStore(root);
    const old = fixtureSession(store);
    const recent = cloneSession(store, old, "recent-session", { day: 2 });
    const recentDb = new Database(sessionIndexPath(store, recent.session));
    const recentMoment = recentDb.query(`SELECT seq FROM moments WHERE kind IN ('steering', 'decision') ORDER BY seq LIMIT 1`).get() as { seq: number };
    recentDb.run(`DELETE FROM moment_files WHERE basename = 'service.ts'`);
    recentDb.run(`DELETE FROM block_files WHERE basename = 'service.ts'`);
    recentDb.run(`INSERT INTO moment_files (seq, file, basename) VALUES (?, ?, ?)`, [recentMoment.seq, "src/recent-only.ts", "recent-only.ts"]);
    recentDb.close();
    const sources = sessionsForCwd(store, "/tmp/reflex-project/packages/api");
    expect(sources.map((source) => source.session.sessionId)).toEqual(["recent-session", old.session.sessionId]);
    const result = reflex({ store, sessions: sources, cwd: "/tmp/reflex-project/packages/api", turnText: "src/auth/service.ts keeps failing; also revisit src/recent-only.ts", receiverId: "project-old" });
    expect(result.pointers.some((pointer) => pointer.sessionId === old.session.sessionId && pointer.kind === "deadend")).toBe(true);
    expect(result.text).toContain("[carafe reflex · 2 sessions in api]");
  });

  test("the current session excludes its last chapter but can answer from an earlier one", () => {
    const store = new CarafeStore(root);
    const current = buildCorpus("gate").find((session) => session.name === "L-31-codex")!;
    sealSession(store, current.distillate.tool, current.distillate.sessionId, current.events);
    writeDistillate(store, current.distillate);
    buildSessionIndex(store, current.distillate, current.events, { force: true });
    const sources = sessionsForCwd(store, current.distillate.cwd!, { currentSessionId: current.distillate.sessionId });
    const currentSource = sources[0]!;
    expect(currentSource.excludeLastChapter).toBe(true);
    const db = new Database(sessionIndexPath(store, current.distillate), { readonly: true });
    const lastChapter = Number((db.query(`SELECT max(idx) AS idx FROM chapters`).get() as { idx: number }).idx);
    db.close();
    const results = reflexGoldTurns(current).filter((turn) => turn.shouldFire).map((turn) => reflex({
      store, sessions: [currentSource], cwd: current.distillate.cwd!, turnText: turn.text,
      receiverId: `${current.distillate.sessionId}-${turn.id}`,
    }));
    expect(results.some((result) => result.pointers.length > 0)).toBe(true);
    expect(results.flatMap((result) => result.pointers).every((pointer) => pointer.chapterIdx !== lastChapter)).toBe(true);
  });

  test("an armed session wins equal candidates and an unknown cwd stays silent", () => {
    const store = new CarafeStore(root);
    const base = fixtureSession(store);
    const older = cloneSession(store, base, "armed-older", { day: 2 });
    cloneSession(store, base, "unarmed-newer", { day: 3 });
    armReflex(store, older.session, { armedAtSeq: older.events.at(-1)!.seq, tailStartSeq: older.events.at(-1)!.seq + 1 });
    const sources = sessionsForCwd(store, "/tmp/reflex-project");
    expect(sources[0]?.session.sessionId).toBe("armed-older");
    const result = reflex({ store, sessions: sources, cwd: "/tmp/reflex-project", turnText: "src/auth/service.ts keeps failing again", receiverId: "armed-tie" });
    expect(result.pointers[0]?.sessionId).toBe("armed-older");
    expect(sessionsForCwd(store, "/unknown/project")).toEqual([]);
    expect(reflex({ store, sessions: [], cwd: "/unknown/project", turnText: "src/auth/service.ts keeps failing", receiverId: "unknown" }).text).toBe("");
  });

  test("twelve read-only indexes stay under the hook budget", () => {
    const store = new CarafeStore(root);
    const base = fixtureSession(store);
    for (let index = 1; index < 12; index++) cloneSession(store, base, `session-${index}`, { day: Math.min(28, index + 1) });
    const sources = sessionsForCwd(store, "/tmp/reflex-project", { maxSessions: 12 });
    expect(sources).toHaveLength(12);
    const started = performance.now();
    const result = reflex({ store, sessions: sources, cwd: "/tmp/reflex-project", turnText: "src/auth/service.ts keeps failing again", receiverId: "twelve-indexes" });
    const elapsed = performance.now() - started;
    expect(result.pointers.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(800);
    console.log(`reflex hook 12 indexes: ${elapsed.toFixed(1)}ms`);
  });
});
