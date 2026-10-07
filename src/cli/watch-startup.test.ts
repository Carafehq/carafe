/**
 * The watcher after a restart: capture first, the backlog afterwards.
 * Synthetic stores only (a mkdtemp workspace whose paths contain spaces).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { indexCatalogPath, sessionIndexPath } from "../search/session-index";
import { listCheckpoints, maybeAutoCheckpointAt, resetFreeSpaceCache } from "../state/checkpoint";
import { runImport, type ImportResult } from "./import";
import { formatServiceStatus, formatWatchdogReport, checkWatchdog, statusService, type ServiceRunner } from "./service";
import { Watchdog, WatchCycle, type WatchCycleDeps } from "./watch";
import { enterStage, newHeartbeat, writeHeartbeat, type HeartbeatStage, type WatchHeartbeat } from "./watch-heartbeat";

let root = "";
let home = "";
const saved: Record<string, string | undefined> = {};
const ENV = ["CARAFE_HOME", "CARAFE_CC_ROOT", "CARAFE_CODEX_ROOT"] as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe startup "));
  home = join(root, "home dir");
  for (const key of ENV) saved[key] = process.env[key];
  process.env.CARAFE_HOME = join(home, ".carafe");
  process.env.CARAFE_CC_ROOT = join(root, "claude home");
  process.env.CARAFE_CODEX_ROOT = join(root, "codex home");
  mkdirSync(process.env.CARAFE_HOME, { recursive: true });
  // This machine's free space must not decide whether a synthetic snapshot is taken.
  writeFileSync(join(process.env.CARAFE_HOME, "config.json"), JSON.stringify({ checkpointMinFreeBytes: 1 }));
  resetFreeSpaceCache();
});

afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function repo(name: string): string {
  const dir = join(root, "work space", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A Claude Code session of `turns` user/assistant pairs, the last one `ageMs` ago. */
function writeSession(id: string, cwd: string, ageMs: number, turns = 25): string {
  const end = Date.now() - ageMs;
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    const ts = new Date(end - (turns - i) * 1_000).toISOString();
    lines.push(JSON.stringify({ type: "user", sessionId: id, uuid: `${id}-u${i}`, timestamp: ts, cwd, isSidechain: false, message: { content: `please change part ${i} of the parser` } }));
    lines.push(JSON.stringify({ type: "assistant", sessionId: id, uuid: `${id}-a${i}`, timestamp: ts, cwd, isSidechain: false, message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: `changed part ${i}` }], usage: {} } }));
  }
  const path = join(process.env.CARAFE_CC_ROOT!, "projects", cwd.replaceAll("/", "-"), `${id}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

interface Recorder { beats: string[]; order: string[]; progress: number }

function cycle(extra: Partial<WatchCycleDeps> = {}): { cycle: WatchCycle; hb: WatchHeartbeat; rec: Recorder } {
  const hb = newHeartbeat();
  const rec: Recorder = { beats: [], order: [], progress: 0 };
  const c = new WatchCycle({
    intervalMs: 4_000,
    hb,
    beat: (stage?: HeartbeatStage, detail: string | null = null) => {
      if (stage) enterStage(hb, stage, detail);
      rec.beats.push(`${stage ?? "-"}${detail ? `:${detail}` : ""}`);
      if (stage === "idle") rec.order.push("tick completed");
      if (stage === "indexing") rec.order.push("index build");
      if (detail?.startsWith("catch-up")) rec.order.push(detail.startsWith("catch-up snapshot") ? "snapshot" : detail);
    },
    progress: () => { rec.progress++; },
    log: () => {},
    error: () => {},
    ...extra,
  });
  return { cycle: c, hb, rec };
}

function indexFiles(store: CarafeStore): string[] {
  const dir = join(store.root, "state", "session-index", "claude-code");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sqlite")) : [];
}

describe("watcher startup: capture first", () => {
  test("the first import writes every session and completes a tick before any snapshot or index work", async () => {
    const repos = [repo("alpha repo"), repo("beta repo"), repo("gamma repo")];
    // three sessions active just before the restart, two older ones
    writeSession("recent-a", repos[0]!, 60_000);
    writeSession("recent-b", repos[1]!, 120_000);
    writeSession("recent-c", repos[2]!, 180_000);
    writeSession("old-d", repos[0]!, 3 * 86_400_000);
    writeSession("old-e", repos[1]!, 5 * 86_400_000);
    const store = new CarafeStore();
    const snapshotCalls: string[] = [];
    const { cycle: c, hb, rec } = cycle({
      snapshotBudget: { perTick: 2, maxMs: 60_000 },
      snapshot: (s, d, candidate, nowMs) => { snapshotCalls.push(d.sessionId); return maybeAutoCheckpointAt(s, d, candidate, { now: () => nowMs, gate: null }); },
    });

    const first = await c.firstImport();
    expect(first.filesImported).toBe(5);
    for (const id of ["recent-a", "recent-b", "recent-c", "old-d", "old-e"]) expect(existsSync(store.distillatePath("claude-code", id))).toBe(true);
    // nothing but capture ran
    expect(snapshotCalls).toEqual([]);
    for (const id of ["recent-a", "recent-b", "recent-c"]) expect(listCheckpoints(store, "claude-code", id)).toEqual([]);
    expect(indexFiles(store)).toEqual([]);
    expect(existsSync(indexCatalogPath(store))).toBe(false);
    // ... and it counts as a completed tick
    expect(hb.lastTickAt).not.toBeNull();
    expect(rec.order).toEqual(["tick completed"]);
    expect(first.deferredSnapshots.map((s) => s.id)).toEqual(["recent-a", "recent-b", "recent-c"]); // newest first
    expect(hb.catchingUp).toMatchObject({ snapshotsQueued: 3, indexQueued: 5, indexPlanned: false });

    // tick 1: two snapshots (the budget), newest first; indexes begin; the catalog step runs
    await c.tick();
    expect(snapshotCalls).toEqual(["recent-a", "recent-b"]);
    expect(listCheckpoints(store, "claude-code", "recent-a")).toHaveLength(1);
    expect(indexFiles(store).length).toBeGreaterThan(0);
    expect(indexFiles(store).length).toBeLessThanOrEqual(3);
    expect(existsSync(indexCatalogPath(store))).toBe(true);
    expect(hb.catchingUp).toMatchObject({ snapshotsQueued: 1, indexPlanned: false });

    // tick 2: the last snapshot and the backfill plan; later ticks drain the index queue
    await c.tick();
    expect(snapshotCalls).toEqual(["recent-a", "recent-b", "recent-c"]);
    expect(hb.catchingUp?.snapshotsQueued ?? 0).toBe(0);
    expect(hb.catchingUp?.indexPlanned ?? true).toBe(true);
    for (let i = 0; i < 5 && hb.catchingUp; i++) await c.tick();
    expect(hb.catchingUp).toBeNull();
    for (const id of ["recent-a", "recent-b", "recent-c", "old-d", "old-e"]) expect(existsSync(sessionIndexPath(store, { tool: "claude-code", sessionId: id }))).toBe(true);
    // the order the heartbeat saw: capture completed first, backlog after
    expect(rec.order.indexOf("tick completed")).toBeLessThan(rec.order.indexOf("snapshot"));
    expect(rec.order.indexOf("tick completed")).toBeLessThan(rec.order.indexOf("index build"));
  });

  test("queued snapshots drain within the per-tick time budget, and expired ones are dropped, not taken late", async () => {
    let now = Date.now();
    const repos = [repo("one"), repo("two")];
    for (let i = 0; i < 6; i++) writeSession(`s${i}`, repos[i % 2]!, 30_000 + i * 1_000, 3);
    const taken: string[] = [];
    const { cycle: c, hb } = cycle({
      now: () => now,
      snapshotBudget: { perTick: 10, maxMs: 5_000 },
      // each snapshot costs 3 s (a git probe on a loaded Mac)
      snapshot: (_s, d) => { taken.push(d.sessionId); now += 3_000; return null; },
    });
    await c.firstImport();
    expect(hb.catchingUp?.snapshotsQueued).toBe(6);
    await c.tick();
    expect(taken).toEqual(["s0", "s1"]); // 0 s → 3 s → 6 s: the third would start past 5 s
    await c.tick();
    expect(taken).toEqual(["s0", "s1", "s2", "s3"]);
    now += 20 * 60_000; // the rest is older than the 15-minute recency window now
    await c.tick();
    expect(taken).toHaveLength(4);
    expect(hb.catchingUp?.snapshotsQueued ?? 0).toBe(0);
  });

  test("a restart with no source changes reads no source file (stat only)", async () => {
    const r = repo("stat only");
    const paths = [writeSession("a", r, 60_000, 3), writeSession("b", r, 7 * 86_400_000, 3)];
    // Codex's name index is a source too; nothing Codex changed, so it is not read
    mkdirSync(process.env.CARAFE_CODEX_ROOT!, { recursive: true });
    writeFileSync(join(process.env.CARAFE_CODEX_ROOT!, "session_index.jsonl"), `${JSON.stringify({ id: "x", thread_name: "n", updated_at: "2026-01-01T00:00:00Z" })}\n`);
    // whole-second mtimes, so restoring one below is exact
    const stamp = Math.floor(Date.now() / 1000) - 5;
    for (const p of paths) utimesSync(p, stamp, stamp);
    const before = await runImport({ quiet: true });
    expect(before.filesImported).toBe(2);
    const store = new CarafeStore();
    const distillate = readFileSync(store.distillatePath("claude-code", "a"), "utf8");
    const manifestAt = statSync(join(store.root, "state", "import-manifest.json")).mtimeMs;
    // Same size and mtime, different bytes: a read would re-import garbage.
    for (const p of paths) {
      writeFileSync(p, "x".repeat(statSync(p).size));
      utimesSync(p, stamp, stamp);
    }
    // a "restarted" watcher: a fresh cycle over the same store
    const { cycle: c, hb } = cycle();
    const after: ImportResult = await c.firstImport();
    expect(after.filesImported).toBe(0);
    expect(after.filesSkipped).toBe(2);
    expect(after.sourcesRead).toBe(0);
    expect(after.rawBytes).toBe(0);
    expect(after.deferredSnapshots).toEqual([]);
    expect(readFileSync(store.distillatePath("claude-code", "a"), "utf8")).toBe(distillate);
    expect(statSync(join(store.root, "state", "import-manifest.json")).mtimeMs).toBe(manifestAt); // nothing to record, nothing written
    expect(hb.catchingUp).toMatchObject({ snapshotsQueued: 0, indexQueued: 0, indexPlanned: false });
  });
});

describe("in-process watchdog during the first import", () => {
  const MIN = 60_000;

  test("a slow first import that keeps entering stages is never killed; one silent past the threshold is", async () => {
    for (const silentMs of [0, 6 * MIN]) {
      let now = 0;
      const fired: number[] = [];
      const watchdog = new Watchdog({ now: () => now, thresholdMs: 5 * MIN, onFire: (ms) => fired.push(ms) });
      // 20 minutes of first import (the incident's 18), one stage change a minute,
      // the check running every 30 s as the real timer does
      const slowImport = (async (opts: Parameters<typeof runImport>[0] = {}) => {
        const stages = ["discover", "read sources", "write sessions", "distillates", "index catalog"] as const;
        for (let minute = 0; minute < 20; minute++) {
          opts.onStage?.(stages[minute % stages.length]!);
          now += 30_000; watchdog.check();
          now += 30_000; watchdog.check();
        }
        for (let t = 0; t < silentMs; t += 30_000) { now += 30_000; watchdog.check(); }
        return { filesImported: 0, filesSkipped: 0, newSessions: [], changedSessions: [], storedBytes: 0, rawBytes: 0, checkpointsTaken: 0, sourcesRead: 0, deferredSnapshots: [] };
      }) as typeof runImport;
      const { cycle: c } = cycle({ now: () => now, runImport: slowImport, progress: () => watchdog.progress() });
      await c.firstImport();
      if (silentMs === 0) expect(fired).toEqual([]);
      else expect(fired).toHaveLength(1);
    }
  });
});

describe("startup visibility", () => {
  test("carafe service watchdog and service status say the watcher is catching up", async () => {
    const r = repo("visible");
    writeSession("v1", r, 60_000);
    writeSession("v2", r, 90_000);
    const { cycle: c, hb } = cycle({ snapshot: () => null });
    await c.firstImport();
    const carafeRoot = process.env.CARAFE_HOME!;
    hb.pid = process.pid;
    writeHeartbeat(carafeRoot, hb);
    writeFileSync(join(carafeRoot, "state", "watch.lock"), `${process.pid}\n`);
    const runner: ServiceRunner = () => ({ code: 0, out: "" });
    const opts = { home, serviceDir: join(root, "Launch Agents"), runner, platform: "darwin" as const };

    const report = formatWatchdogReport(checkWatchdog({ ...opts, pidAlive: () => true }));
    expect(report).toContain("watcher: ok");
    expect(report).toContain("startup: starting up — catching up (snapshots 2 left, index 2+ left, planning)");
    expect(formatServiceStatus(statusService(opts))).toContain("startup: starting up — catching up (snapshots 2 left");

    // during the first import itself
    const booting = newHeartbeat(new Date().toISOString(), process.pid);
    enterStage(booting, "first import", "write sessions");
    writeHeartbeat(carafeRoot, booting);
    expect(formatWatchdogReport(checkWatchdog({ ...opts, pidAlive: () => true }))).toContain("startup: starting up — capturing sessions (write sessions)");

    // once drained, nothing is said
    hb.catchingUp = null;
    writeHeartbeat(carafeRoot, hb);
    expect(formatWatchdogReport(checkWatchdog({ ...opts, pidAlive: () => true }))).not.toContain("startup:");
    expect(formatServiceStatus(statusService(opts))).not.toContain("startup:");
  });
});
