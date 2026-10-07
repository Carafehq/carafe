import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import type { SessionDistillate } from "../format/distillate";
import {
  checkpointDir,
  listCheckpoints,
  readCheckpointManifest,
  resetFreeSpaceCache,
  takeCheckpoint,
  takeManualCheckpoint,
} from "./checkpoint";
import { applyGc, applyMigration, formatGcReport, planGc, planMigration } from "./gc";
import { listObjects } from "./objects";
import { applyUndo, planUndo } from "./undo";

const temps: string[] = [];

afterEach(() => {
  resetFreeSpaceCache();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(prefix = "carafe-gc-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${Buffer.from(r.stderr).toString()}`);
  return Buffer.from(r.stdout).toString().trim();
}

function initRepo(): string {
  const repo = tempDir("carafe-gc-repo-");
  run(["git", "init"], repo);
  run(["git", "config", "user.email", "test@example.com"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  run(["git", "add", "tracked.txt"], repo);
  run(["git", "commit", "-m", "initial"], repo);
  return repo;
}

function store(config: Record<string, unknown> = {}): CarafeStore {
  const s = new CarafeStore(tempDir("carafe-gc-store-"));
  writeFileSync(join(s.root, "config.json"), JSON.stringify({ version: 1, ...config }));
  return s;
}

function distillate(cwd: string, sessionId = "s1"): SessionDistillate {
  return {
    tool: "codex", sessionId, sourcePath: join(cwd, "session.jsonl"), title: "GC Test",
    cwd, gitBranch: "main", startTs: "2026-01-01T10:00:00Z", endTs: "2026-01-01T10:10:00Z",
    eventCount: 1, toolUseCount: 0, sidechain: false, rawBytes: 10, version: 1,
  };
}

/** Take `n` distinct auto snapshots (each one changes a file, or the snapshot
 *  would rightly be skipped as identical). */
function snapshots(s: CarafeStore, d: SessionDistillate, repo: string, n: number, startSeq = 1): void {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repo, "tracked.txt"), `v${startSeq + i}\n`);
    expect(takeCheckpoint(s, d, startSeq + i, null)).not.toBeNull();
  }
}

function setTakenAt(s: CarafeStore, d: SessionDistillate, seq: number, iso: string): void {
  const dir = checkpointDir(s, d.tool, d.sessionId, seq);
  const m = readCheckpointManifest(dir)!;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, takenAt: iso }, null, 2));
}

describe("gc policies", () => {
  test("per-session keep names the oldest auto snapshots and spares manual ones", () => {
    const repo = initRepo();
    const s = store({ checkpointKeep: 3 });
    const d = distillate(repo);
    takeManualCheckpoint(s, d, 0, null);
    snapshots(s, d, repo, 5);

    const plan = planGc(s);
    const keys = plan.victims.filter((v) => v.policy === "keep").map((v) => v.snapshot.key).sort();
    expect(keys).toEqual(["1", "2"]);
    expect(plan.victims.some((v) => v.snapshot.key === "0")).toBe(false);
  });

  test("inactivity removes every auto snapshot of an ended session, never the manual one", () => {
    const repo = initRepo();
    const s = store({ checkpointKeep: 100, checkpointInactiveDays: 30 });
    const d = distillate(repo);
    takeManualCheckpoint(s, d, 0, null);
    snapshots(s, d, repo, 3);
    for (const seq of [0, 1, 2, 3]) setTakenAt(s, d, seq, "2026-01-01T00:00:00Z");

    const now = Date.parse("2026-03-01T00:00:00Z");
    const plan = planGc(s, { now });
    const inactive = plan.victims.filter((v) => v.policy === "inactive").map((v) => v.snapshot.key).sort();
    expect(inactive).toEqual(["1", "2", "3"]);
    expect(plan.victims.some((v) => v.snapshot.key === "0")).toBe(false);
  });

  test("the budget takes the oldest auto snapshots across sessions, and applying sweeps their objects", () => {
    const repo = initRepo();
    const s = store({ checkpointKeep: 100, checkpointInactiveDays: 3650, checkpointBudgetBytes: 1 });
    const a = distillate(repo, "a");
    const b = distillate(repo, "b");
    takeManualCheckpoint(s, a, 0, null);
    snapshots(s, a, repo, 2);
    snapshots(s, b, repo, 2, 10);

    const plan = planGc(s);
    expect(plan.victims.every((v) => v.policy === "budget")).toBe(true);
    // everything auto goes; the manual snapshot survives the budget too
    expect(plan.victims.length).toBe(4);
    expect(plan.victims.some((v) => v.snapshot.key === "0")).toBe(false);

    const before = listObjects(s).size;
    expect(before).toBeGreaterThan(0);
    const applied = applyGc(s, plan);
    expect(applied.removed).toBe(4);
    expect(existsSync(checkpointDir(s, a.tool, a.sessionId, 0))).toBe(true);
    // the manual snapshot's own objects are still referenced, so still present
    const survivors = listObjects(s);
    expect(survivors.size).toBeGreaterThan(0);
    expect(survivors.size).toBeLessThan(before);
    for (const e of readCheckpointManifest(checkpointDir(s, a.tool, a.sessionId, 0))!.files!) {
      expect(survivors.has(e.hash)).toBe(true);
    }
  });

  test("a pre-undo stash survives every policy", () => {
    const repo = initRepo();
    const s = store({ checkpointKeep: 1, checkpointInactiveDays: 0, checkpointBudgetBytes: 1 });
    const d = distillate(repo);
    takeCheckpoint(s, d, 1, null);
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    const applied = applyUndo(s, d, planUndo(s, d, 1));
    expect(applied.stashDir).toContain("pre-undo-");

    const plan = planGc(s);
    expect(plan.victims.some((v) => v.snapshot.dir === applied.stashDir)).toBe(false);
    applyGc(s, plan);
    expect(existsSync(join(applied.stashDir, "manifest.json"))).toBe(true);
    // its bytes are still readable after the sweep
    expect(readFileSync(join(applied.stashDir, "manifest.json"), "utf8")).toContain("tracked.txt");
  });
});

describe("version-1 migration", () => {
  /** Write a snapshot exactly the way carafe wrote them before objects existed. */
  function writeV1(s: CarafeStore, d: SessionDistillate, seq: number, files: Record<string, string>): string {
    const dir = checkpointDir(s, d.tool, d.sessionId, seq);
    mkdirSync(join(dir, "files"), { recursive: true });
    let totalBytes = 0;
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, "files", rel), content);
      chmodSync(join(dir, "files", rel), 0o644);
      totalBytes += Buffer.byteLength(content);
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      seq, ts: null, takenAt: new Date().toISOString(), cwd: d.cwd, gitHead: null, gitBranch: null,
      dirtyCount: null, fileCount: Object.keys(files).length, totalBytes, skipped: [], version: 1,
    }, null, 2));
    return dir;
  }

  test("a version-1 snapshot still lists and undoes, and --migrate converts it only with --yes", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    const dir = writeV1(s, d, 1, { "tracked.txt": "v1 content\n" });

    expect(listCheckpoints(s, d.tool, d.sessionId).map((c) => c.seq)).toEqual([1]);
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    applyUndo(s, d, planUndo(s, d, 1));
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("v1 content\n");

    // dry run: reports, converts nothing
    const plan = planMigration(s);
    expect(plan.dirs.map((x) => x.dir)).toContain(dir);
    expect(plan.distinctCount).toBeGreaterThan(0);
    expect(existsSync(join(dir, "files"))).toBe(true);
    expect(readCheckpointManifest(dir)!.version).toBe(1);

    // apply
    expect(applyMigration(s, plan).converted).toBeGreaterThan(0);
    expect(existsSync(join(dir, "files"))).toBe(false);
    expect(readCheckpointManifest(dir)!.version).toBe(2);

    // and the same bytes come back out of the objects
    writeFileSync(join(repo, "tracked.txt"), "edited again\n");
    applyUndo(s, d, planUndo(s, d, 1));
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("v1 content\n");
  });

  test("a version-1 victim reports its tree bytes; a version-2 victim reports object bytes", () => {
    const repo = initRepo();
    const s = store({ checkpointKeep: 100, checkpointInactiveDays: 30 });
    const legacy = distillate(repo, "legacy");
    const modern = distillate(repo, "modern");
    const body = "y".repeat(2048);
    const dir = writeV1(s, legacy, 1, { "a.txt": body });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      ...readCheckpointManifest(dir)!, takenAt: "2026-01-01T00:00:00Z",
    }, null, 2));
    snapshots(s, modern, repo, 1);
    setTakenAt(s, modern, 1, "2026-01-01T00:00:00Z");

    const plan = planGc(s, { now: Date.parse("2026-03-01T00:00:00Z") });
    expect(plan.victims.length).toBe(2);
    expect(plan.v1Snapshots).toBe(1);
    // the v1 tree's bytes are counted as a TREE — they are not in state/objects
    expect(plan.v1VictimDirs).toBe(1);
    expect(plan.v1VictimBytes).toBe(2048);
    // ...and the v2 victim is the only thing the object numbers describe
    expect(plan.freedObjects).toBeGreaterThan(0);
    expect(plan.freedBytes).toBeGreaterThan(0);
    expect(plan.freedBytes).toBeLessThan(2048);

    const report = formatGcReport(plan, { apply: false, now: Date.parse("2026-03-01T00:00:00Z") });
    expect(report).toContain("version-1 trees among them: 1");
    expect(report).toContain("(1 version 1; gc --migrate converts)");
  });

  test("migration reports reclaimable bytes with each distinct content counted once", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    const body = "x".repeat(1000);
    // the same content in three snapshots — the real saving is two copies
    writeV1(s, d, 1, { "a.txt": body });
    writeV1(s, d, 2, { "a.txt": body });
    writeV1(s, d, 3, { "a.txt": body });

    const plan = planMigration(s);
    expect(plan.dirs.length).toBe(3);
    expect(plan.totalBytes).toBe(3000);
    expect(plan.distinctCount).toBe(1);
    expect(plan.distinctBytes).toBe(1000);
    applyMigration(s, plan);
    expect(listObjects(s).size).toBe(1);
  });
});
